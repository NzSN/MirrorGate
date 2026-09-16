/** Local application acceptance: trusted suite stays outside frozen submission. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnMirror } from 'mirrorecma';
import { evaluateSuite, writeTrustedReceipt } from '../dist/index.js';
import {generateAdapterKit} from '../../../sdk/node/adapter-kit.mjs';

const integration = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gate = resolve(integration, '../..');
const ecma = resolve(process.env.MIRRORECMA_ROOT ?? join(gate, '../MirrorECMA'));
const { loadApplication, checkArtifacts } = await import(pathToFileURL(join(ecma, 'examples/application-validation/suite.mjs')));
const { sha256 } = await import(pathToFileURL(join(ecma, 'examples/application-validation/regenerate.mjs')));
assert.equal(process.version, 'v24.15.0', 'Gate acceptance requires the pinned Node runtime');
const [folder, flag, receiptPath, hostFlag, profilePath] = process.argv.slice(2);
assert(flag === '--receipt' && receiptPath && (process.argv.length === 5 ||
  (process.argv.length === 7 && hostFlag === '--host-profile' && profilePath)),
  'Usage: node application-program-gate.mjs APPLICATION --receipt NEW_FILE [--host-profile APPROVED_PROFILE]');
const hostProfile = profilePath ? JSON.parse(await readFile(profilePath, 'utf8')) : undefined;
const app = await loadApplication(folder);
await checkArtifacts(app);
const scratch = await mkdtemp(join(tmpdir(), `gate-${folder}-`));
const outcomes = [];
try {
  const submissions = join(scratch, 'submissions');
  await mkdir(submissions);
  const canary = join(scratch, 'private-oracle-canary');
  await writeFile(canary, 'private evaluator data', { mode: 0o600 });
  const policyFile = join(scratch, 'policy.json');
  const policy = spawnSync('python3', [join(gate, 'tests/control_policy_fixture.py'), policyFile, submissions,
    '--policy-id', folder, '--adapter-id', app.suite.adapterId, '--target-profile', app.model.targetProfile,
    '--state-computer-contract-version', app.model.stateComputerContractVersion], { encoding: 'utf8', timeout: 30_000 });
  if (policy.error) throw policy.error;
  assert.equal(policy.status, 0, policy.stderr);
  const config = JSON.parse(await readFile(policyFile, 'utf8'));
  const nodeRoot = config.policies[0].runtimes[0].runtimeMounts.find(mount => mount.destination === '/runtime/node').source;
  config.schema = 'mirrorgate.control-policy/v2';
  config.agentProfiles = hostProfile ? [hostProfile] : [];
  config.policies[0].agentProfileIds = hostProfile ? [hostProfile.id] : [];
  config.policies[0].buildPlans = [{id: 'application.node', profile: 'node-esm/v1', entryPoint: 'adapter.mjs',
    sourceFiles: hostProfile ? ['adapter.mjs'] : folder === 'work-queue'
      ? ['adapter.mjs', 'service.mjs', 'queue.js', 'package.json'] : ['adapter.mjs', 'service.mjs', 'package.json'],
    runtimeSha256: await sha256(join(nodeRoot, 'bin/node')), dependencies: []}];
  const publicKit = join(scratch, 'public-kit');
  if (hostProfile) await generateAdapterKit(app.publicManifest, {directory: publicKit,
    behavior: await readFile(join(app.directory, 'PUBLIC-CONTRACT.md'), 'utf8')});
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
    const started = performance.now();
    const controller = new AbortController();
    // The cancellation control is triggered when the model requests the first
    // transition, so preparation cannot consume the cancellation timer.
    let cancelTimer;
    const mirror = variant === 'cancel' ? () => {
      const transport = spawnMirror(process.env.MIRROR_BIN ?? resolve(ecma, '../Mirrors/.lake/build/bin/mirror'));
      return {send: line => transport.send(line), close: () => { clearTimeout(cancelTimer); return transport.close(); },
        async *[Symbol.asyncIterator]() {
          for await (const line of transport) {
            if (!cancelTimer && JSON.parse(line).proto_step === 'next_step') {
              cancelTimer = setTimeout(() => controller.abort('application acceptance'), 25);
            }
            yield line;
          }
        }};
    } : process.env.MIRROR_BIN ?? resolve(ecma, '../Mirrors/.lake/build/bin/mirror');
    const outcome = await evaluateSuite(app.suite, {
      mirror,
      environment: {taskRef: `${folder}-${variant}`, policyId: folder, runtime: 'node-v1',
        gate: {kind: 'owned', launcher: {command: join(gate, 'bin/mirrorgate')}, policyFile}},
      submission: { kind: 'source', buildPlanId: 'application.node', authoring: !!hostProfile,
        input: { rootId: 'submission', relativePath: variant } },
      ...(hostProfile ? { agent: { profileId: hostProfile.id, publicTask: {
        instructions: 'Implement the supplied public contract from scratch. Use only public_contract, gate_exec and submit. '
          + 'The approved toolId is python; gate_exec args may be ["-c", "Python code"]. '
          + 'Write self-contained adapter.mjs exporting createAdapter() in the writable /workspace. '
          + 'Use the generated public declarations and Node built-ins only. The approved Node ESM profile prepares the entry point. '
          + 'Submit when complete. Do not inspect private evaluator files.',
        files: [
          { path: 'PUBLIC-CONTRACT.md', text: await readFile(join(app.directory, 'PUBLIC-CONTRACT.md'), 'utf8') },
          { path: 'port.json', text: await readFile(join(publicKit, 'port.json'), 'utf8') },
          { path: 'adapter.d.ts', text: await readFile(join(publicKit, 'adapter.d.ts'), 'utf8') },
        ],
      } } } : {}),
      signal: controller.signal,
      timeouts: {registrationMs: 30_000, actionMs: variant === 'hang' ? 200 : 5_000,
        receiveMs: 30_000, cleanupMs: 10_000},
    });
    outcomes.push({ variant, durationMs: performance.now() - started, ...outcome });
    assert.equal(outcome.receipt.cleanup.status, 'confirmed', JSON.stringify(outcome));
    assert.deepEqual(outcome.receipt.cleanup.remainingResources, []);
    const expected = controlCase ? { crash: 'failed', hang: 'timedOut', cancel: 'cancelled' }[variant]
      : ['correct', 'authored'].includes(variant) ? 'passed' : 'mismatch';
    assert.equal(outcome.outcome, expected, JSON.stringify(outcome));
    if (expected === 'passed') {
      assert.equal(outcome.suiteResult.acceptance.status, 'met');
      assert.equal(outcome.suiteResult.evidence.tracesCompleted, 2);
      assert.equal(outcome.suiteResult.evidence.transitionsMatched, String(2 * app.length));
    }
    if (hostProfile) {
      assert.equal(outcome.receipt.hosting?.outcome, 'submitted');
      assert.equal(outcome.receipt.hosting.submission.sourceHash, outcome.receipt.implementation.sourceHash);
    } else if (variant !== 'correct' && !controlCase) {
      const error = outcome.suiteResult.failure;
      assert.equal(error?.kind, 'mismatch');
      assert.equal(error.stateIndex, app.faults[variant].step);
      assert.equal(error.traceIndex, app.faults[variant].trace ?? 0);
      assert.equal(outcome.suiteResult.trustedError?.action, app.faults[variant].action);
    }
  }
} finally {
  const receipt = { schema: 'mirrorgate.application-validation/v2', application: folder,
    authoring: hostProfile ? 'actual Gate-hosted restricted runtime' : 'not exercised; source submissions', node: process.version,
    runnerSha256: await sha256(fileURLToPath(import.meta.url)),
    publicContractSha256: await sha256(join(app.directory, 'PUBLIC-CONTRACT.md')),
    model: await sha256(app.config.specPath), referenceImplementation: await sha256(join(app.directory, folder === 'work-queue' ? 'queue.ts' : 'service.mjs')),
    trace: await sha256(app.trace), interface: app.model.semanticDigest, outcomes };
  try {
    const persisted = await writeTrustedReceipt(receipt, {path: resolve(receiptPath)});
    assert.equal(persisted.status, 'written', 'private aggregate receipt persistence failed');
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
console.log(`${folder}: ${outcomes.length} real sandbox evaluations passed; all cleanup confirmed`);
