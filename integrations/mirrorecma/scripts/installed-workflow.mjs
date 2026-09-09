import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, copyFileSync, cpSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const integration = resolve(fileURLToPath(new URL('..', import.meta.url)));
const gate = resolve(integration, '../..');
const ecma = resolve(process.env.MIRRORECMA_ROOT ?? join(gate, '../MirrorECMA'));
const mirrors = process.env.MIRRORS_ROOT;
assert(mirrors, 'MIRRORS_ROOT is required');
assert.equal(process.version, 'v24.15.0', 'real workflow evidence requires pinned Node');
const scratch = mkdtempSync(join(tmpdir(), 'gate-installed-workflow-'));
const run = (command, args, cwd = scratch, env = process.env) => {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', env});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};
try {
  // Installation-only work. The application run below does none of this.
  run(join(integration, 'node_modules/.bin/tsc'), ['-p', join(integration, 'tsconfig.json')]);
  run(join(ecma, 'node_modules/.bin/tsc'), ['-p', join(ecma, 'tsconfig.json')]);
  const consumer = join(scratch, 'consumer');
  cpSync(join(integration, 'examples/counter'), consumer, {recursive: true,
    filter: source => !['node_modules', 'dist'].includes(source.split('/').at(-1))});
  const suiteSource = readFileSync(join(ecma, 'examples/mbt-counter/suite.ts'), 'utf8');
  const packagedSuite = suiteSource.replace('"../../src/index.js"', '"mirrorecma"')
    .replace('"../../test/fixtures/model-interface/counter/generated-async/CounterMirror.generated.js"', '"./CounterMirror.generated.js"');
  assert.equal(readFileSync(join(consumer, 'suite.ts'), 'utf8'), packagedSuite,
    'installed Counter suite differs beyond its two approved import rewrites');
  for (const [source, destination] of [
    ['Counter.mirror-interface.lock.json', 'Counter.mirror-interface.lock.json'],
    ['generated-async/CounterMirror.generated.ts', 'CounterMirror.generated.ts'],
  ]) assert.deepEqual(readFileSync(join(ecma, 'test/fixtures/model-interface/counter', source)), readFileSync(join(consumer, destination)));
  for (const [name, source] of [['mirrorecma', ecma], ['mirrorgate', gate], ['mirrorgate-mirrorecma', integration]]) {
    const archive = run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', scratch, '--cache', join(scratch, 'npm-cache')], source).split('\n').at(-1);
    const target = join(consumer, 'node_modules', name); mkdirSync(target, {recursive: true});
    run('tar', ['-xzf', join(scratch, archive), '--strip-components=1', '-C', target]);
  }
  run(join(integration, 'node_modules/.bin/tsc'), ['-p', join(consumer, 'tsconfig.json'), '--types', 'node', '--typeRoots', join(ecma, 'node_modules/@types')]);
  const privateCanary = join(scratch, 'private-canary'); writeFileSync(privateCanary, 'trusted oracle canary');
  const environment = {...process.env, GATE_WORKFLOW_PRIVATE_PATH: privateCanary, GATE_WORKFLOW_SECRET: 'private evaluator secret'};
  const submissions = join(scratch, 'submissions'); mkdirSync(submissions);
  const policyFile = join(scratch, 'policy.json');
  run('python3', [join(gate, 'tests/control_policy_fixture.py'), policyFile, submissions, '--policy-id', 'counter',
    '--adapter-id', 'counter-mbt/v1', '--target-profile', 'mirrorecma-async-v1',
    '--state-computer-contract-version', 'mirrors.async-state-computer/v1']);
  const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
  policy.policies[0].buildPlans[0].command = ['/usr/bin/python3', '/source/build.py'];
  writeFileSync(policyFile, JSON.stringify(policy));
  const specPath = join(mirrors, 'specs/Counter.tla');
  const baseConfig = {
    policyId: 'counter', mirror: process.env.MIRROR_BIN ?? join(mirrors, '.lake/build/bin/mirror'),
    modelRevision: createHash('sha256').update(readFileSync(specPath)).digest('hex'),
    modelConfig: {specPath, invariant: 'TraceComplete', lengthBound: 6, constInit: 'CInit', paramVars: 'parameters'},
    tracePaths: [join(gate, 'conformance/control-v1/counter.itf.json')], disclosure: {counts: true, implementationIdentity: true},
  };
  for (const variant of ['correct', 'faulty']) {
    const relativePath = `authored-${variant}`; mkdirSync(join(submissions, relativePath));
    const configuration = {...baseConfig, taskRef: `counter-${variant}`,
      gate: {kind: 'owned', launcher: {command: 'python3', args: [join(integration, 'test/support/workflow-controller.py')]}, policyFile},
      submission: {kind: 'source', input: {rootId: 'submission', relativePath}, buildPlanId: 'copy', authoring: true},
      agent: {profileId: 'synthetic-author', publicTask: {instructions: `Implement ${variant} Counter`, files: []}},
    };
    writeFileSync(join(consumer, `hosted-${variant}.json`), JSON.stringify(configuration));
    if (variant === 'correct') {
      mkdirSync(join(submissions, 'mcp-correct'));
      writeFileSync(join(consumer, 'mcp-correct.json'), JSON.stringify({...configuration,
        submission: {...configuration.submission, input: {rootId: 'submission', relativePath: 'mcp-correct'}}}));
    }
    const toolRelative = `tool-${variant}`; mkdirSync(join(submissions, toolRelative));
    writeFileSync(join(consumer, `tool-${variant}.json`), JSON.stringify({...configuration,
      submission: {...configuration.submission, input: {rootId: 'submission', relativePath: toolRelative}}}));
    const prebuilt = {...configuration,
      gate: {kind: 'owned', launcher: {command: join(gate, 'bin/mirrorgate')}, policyFile},
      submission: {kind: 'prebuilt', input: {rootId: 'submission', relativePath}}};
    delete prebuilt.agent;
    writeFileSync(join(consumer, `prebuilt-${variant}.json`), JSON.stringify(prebuilt));
  }
  copyFileSync(join(integration, 'test/installed-workflow-driver.mjs'), join(consumer, 'installed-driver.mjs'));
  // From this point onward: only installed packages, app config and the shared
  // suite. No npm, compilation, broker/credential copies or custom host launcher
  // logic runs in the consumer; the operator test controller is explicitly synthetic.
  console.log(run(process.execPath, [join(consumer, 'installed-driver.mjs')], consumer, environment));
  if (process.argv.includes('--mcp')) {
    copyFileSync(join(integration, 'test/installed-mcp-driver.mjs'), join(consumer, 'installed-mcp-driver.mjs'));
    console.log(run(process.execPath, [join(consumer, 'installed-mcp-driver.mjs')], consumer, environment));
  }
  if (process.argv.includes('--service')) {
    copyFileSync(join(integration, 'test/service-installed-driver.mjs'), join(consumer, 'service-installed-driver.mjs'));
    console.log(run(process.execPath, [join(consumer, 'service-installed-driver.mjs')], consumer, environment));
  }
} finally {
  if (process.env.KEEP_GATE_WORKFLOW_CONSUMER === '1') console.log(`installed consumer retained: ${scratch}`);
  else rmSync(scratch, {recursive: true, force: true});
}
