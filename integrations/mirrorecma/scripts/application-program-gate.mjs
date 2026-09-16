/** Local application acceptance: trusted suite stays outside frozen submission. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { decodeSemanticDescriptor, MODEL_INTERFACE_DESCRIPTOR_SCHEMA } from 'mirrorecma';
import { createSandboxCompiledModel, evaluateImplementation } from '../dist/index.js';

const integration = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gate = resolve(integration, '../..');
const ecma = resolve(process.env.MIRRORECMA_ROOT ?? join(gate, '../MirrorECMA'));
const { loadApplication, runApplicationSuite, checkArtifacts } = await import(pathToFileURL(join(ecma, 'examples/application-validation/suite.mjs')));
const { sha256 } = await import(pathToFileURL(join(ecma, 'examples/application-validation/regenerate.mjs')));
assert.equal(process.version, 'v24.15.0', 'Gate acceptance requires the pinned Node runtime');
const [folder, flag, receiptPath, hostFlag, profilePath] = process.argv.slice(2);
assert(flag === '--receipt' && receiptPath && (process.argv.length === 5 ||
  (process.argv.length === 7 && hostFlag === '--host-profile' && profilePath)),
  'Usage: node application-program-gate.mjs APPLICATION --receipt NEW_FILE [--host-profile APPROVED_PROFILE]');
const hostProfile = profilePath ? JSON.parse(await readFile(profilePath, 'utf8')) : undefined;
const app = await loadApplication(folder);
await checkArtifacts(app);
const { contract, semanticDigest, provenance, provenanceDigest, ...descriptor } = JSON.parse(
  await readFile(join(app.directory, 'artifacts', `${app.module}.mirror-interface.lock.json`), 'utf8'));
const model = createSandboxCompiledModel({ metadata: app.metadata,
  descriptor: decodeSemanticDescriptor({ ...descriptor, schema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA }),
  adapterId: app.key.adapterId, publicManifest: app.publicManifest,
  targetProfile: app.key.targetProfile, stateComputerContractVersion: app.key.stateComputerContractVersion,
  bindPublicPort: app.bindPublicPort });
const scratch = await mkdtemp(join(tmpdir(), `gate-${folder}-`));
const outcomes = [];
try {
  const submissions = join(scratch, 'submissions');
  await mkdir(submissions);
  const canary = join(scratch, 'private-oracle-canary');
  await writeFile(canary, 'private evaluator data', { mode: 0o600 });
  const policyFile = join(scratch, 'policy.json');
  const policy = spawnSync('python3', [join(gate, 'tests/control_policy_fixture.py'), policyFile, submissions,
    '--policy-id', folder, '--adapter-id', app.key.adapterId, '--target-profile', app.key.targetProfile,
    '--state-computer-contract-version', app.key.stateComputerContractVersion], { encoding: 'utf8', timeout: 30_000 });
  if (policy.error) throw policy.error;
  assert.equal(policy.status, 0, policy.stderr);
  const config = JSON.parse(await readFile(policyFile, 'utf8'));
  config.policies[0].buildPlans[0].command = ['/usr/bin/python3', '/source/build.py'];
  if (hostProfile) {
    config.schema = 'mirrorgate.control-policy/v2';
    config.agentProfiles = [hostProfile];
    config.policies[0].agentProfileIds = [hostProfile.id];
  }
  await writeFile(policyFile, JSON.stringify(config));
  for (const variant of hostProfile ? ['authored'] : ['correct', ...Object.keys(app.faults), 'crash', 'hang', 'cancel']) {
    const controlCase = ['crash', 'hang', 'cancel'].includes(variant);
    const source = join(submissions, variant);
    await mkdir(source);
    if (!hostProfile) {
    await copyFile(join(app.directory, folder === 'work-queue' ? 'gate-service.mjs' : 'service.mjs'), join(source, 'service.mjs'));
    if (folder === 'work-queue') await copyFile(join(ecma, 'dist-test/examples/work-queue/queue.js'), join(source, 'queue.js'));
    await writeFile(join(source, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(source, 'adapter.mjs'), `import {existsSync} from 'node:fs';
import {createAdapter as create} from './service.mjs';
if (existsSync(${JSON.stringify(canary)}) || existsSync(${JSON.stringify(app.config.specPath)})) throw new Error('private runtime file exposed');
export async function createAdapter() {
  const adapter = await create(${JSON.stringify(controlCase ? 'correct' : variant)});
  if (${JSON.stringify(controlCase)}) {
    for (const id of Object.keys(adapter.actions)) {
      if (id === 'Initialize') continue;
      adapter.actions[id] = ${variant === 'crash' ? '() => process.exit(17)' : '() => new Promise(() => {})'};
    }
  }
  return adapter;
}
`);
    }
    await writeFile(join(source, 'build.py'), `import os, shutil
assert not os.path.exists(${JSON.stringify(canary)}), 'private build file exposed'
assert not os.path.exists(${JSON.stringify(app.config.specPath)}), 'private model exposed'
for name in ${JSON.stringify(folder === 'work-queue' ? ['service.mjs', 'adapter.mjs', 'queue.js', 'package.json'] : ['service.mjs', 'adapter.mjs', 'package.json'])}:
    shutil.copyfile('/source/' + name, '/output/' + name)
`);
    const started = performance.now();
    const controller = new AbortController();
    const outcome = await evaluateImplementation({
      taskRef: `${folder}-${variant}`, policyId: folder, runtime: 'node-v1', model,
      gate: { kind: 'owned', launcher: { command: join(gate, 'bin/mirrorgate') }, policyFile },
      submission: { kind: 'source', buildPlanId: 'copy', authoring: !!hostProfile,
        input: { rootId: 'submission', relativePath: variant } },
      ...(hostProfile ? { agent: { profileId: hostProfile.id, publicTask: {
        instructions: 'Implement the supplied public contract from scratch. Use only public_contract, gate_exec and submit. '
          + 'The approved toolId is python; gate_exec args may be ["-c", "Python code"]. '
          + 'Write adapter.mjs exporting createAdapter() in the writable /workspace. '
          + 'Write build.py that copies your .mjs files from read-only /source to writable /output. '
          + 'Use Node built-ins only. Submit when complete. Do not inspect private evaluator files.',
        files: [
          { path: 'PUBLIC-CONTRACT.md', text: await readFile(join(app.directory, 'PUBLIC-CONTRACT.md'), 'utf8') },
          { path: 'PUBLIC-PORT.json', text: JSON.stringify(app.publicManifest, null, 2) },
        ],
      } } } : {}),
      suite: { id: `${folder}-suite/v1`, revision: await sha256(join(ecma, 'examples/application-validation/suite.mjs')),
        modelRevision: await sha256(app.config.specPath), context: {},
        run: (context, factory) => runApplicationSuite(app, async (...args) => {
          const binding = await factory(...args);
          if (variant !== 'cancel') return binding;
          return { ...binding, computer: (input, replayContext) => {
            if (input.action !== 'init') setTimeout(() => controller.abort('application acceptance'), 25);
            return binding.computer(input, replayContext);
          } };
        }, { signal: context.signal, deadlines: context.deadlines }) },
    }, { signal: controller.signal,
      deadlines: { registrationMs: 30_000, stepMs: variant === 'hang' ? 200 : 5_000, receiveMs: 30_000 } });
    outcomes.push({ variant, durationMs: performance.now() - started, ...outcome });
    assert.equal(outcome.receipt.cleanup.status, 'confirmed', JSON.stringify(outcome));
    assert.deepEqual(outcome.receipt.cleanup.remainingResources, []);
    const expected = controlCase ? { crash: 'failed', hang: 'timedOut', cancel: 'cancelled' }[variant]
      : ['correct', 'authored'].includes(variant) ? 'passed' : 'mismatch';
    assert.equal(outcome.receipt.status, expected, JSON.stringify(outcome));
    if (hostProfile) {
      assert.equal(outcome.receipt.hosting?.outcome, 'submitted');
      assert.equal(outcome.receipt.hosting.submission.sourceHash, outcome.receipt.implementation.sourceHash);
    } else if (variant !== 'correct' && !controlCase) {
      const error = outcome.receipt.primaryFailure?.error;
      assert.equal(error?.code, 'replay_mismatch');
      assert.equal(error.action, app.faults[variant].action);
      assert.equal(error.stateIndex, app.faults[variant].step);
    }
  }
} finally {
  const receipt = { schema: 'mirrorgate.application-validation/v1', application: folder,
    authoring: hostProfile ? 'actual Gate-hosted restricted runtime' : 'not exercised; source submissions', node: process.version,
    runnerSha256: await sha256(fileURLToPath(import.meta.url)),
    publicContractSha256: await sha256(join(app.directory, 'PUBLIC-CONTRACT.md')),
    model: await sha256(app.config.specPath), referenceImplementation: await sha256(join(app.directory, folder === 'work-queue' ? 'queue.ts' : 'service.mjs')),
    trace: await sha256(app.trace), interface: app.key.semanticDigest, outcomes };
  try {
    await writeFile(receiptPath, JSON.stringify(receipt, (_key, value) => value instanceof Error
      ? { name: value.name, message: value.message, code: value.code } : value, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
console.log(`${folder}: ${outcomes.length} real sandbox evaluations passed; all cleanup confirmed`);
