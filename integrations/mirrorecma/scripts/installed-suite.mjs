// Preparation packs once. Execution uses only the relocated installation and
// operator environment with all three source checkouts hidden and no network.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, cpSync, copyFileSync, readFileSync, writeFileSync, renameSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const integration = resolve(fileURLToPath(new URL('..', import.meta.url)));
const gate = resolve(integration, '../..');
const ecma = resolve(process.env.MIRRORECMA_ROOT ?? join(gate, '../MirrorECMA'));
const mirrors = resolve(process.env.MIRRORS_ROOT ?? join(gate, '../Mirrors'));
const scratch = mkdtempSync(join(tmpdir(), 'gate-installed-suite-'));
const run = (command, args, cwd = scratch, env = process.env) => {
  const result = spawnSync(command, args, {cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};
try {
  run(process.execPath, [join(ecma, 'node_modules/typescript/bin/tsc'), '-p', join(ecma, 'tsconfig.json')]);
  run(process.execPath, [join(integration, 'node_modules/typescript/bin/tsc'), '-p', join(integration, 'tsconfig.json')]);
  const original = join(scratch, 'prepared-install'); mkdirSync(original);
  const application = join(original, 'application'); mkdirSync(application);
  writeFileSync(join(application, 'package.json'), '{"type":"module","private":true}\n');
  for (const [name, source] of [['mirrorecma', ecma], ['mirrorgate', gate], ['mirrorgate-mirrorecma', integration]]) {
    const archive = run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', scratch, '--cache', join(scratch, 'npm-cache')], source).split('\n').at(-1);
    const target = join(application, 'node_modules', name); mkdirSync(target, {recursive: true});
    run('tar', ['-xzf', join(scratch, archive), '--strip-components=1', '-C', target]);
  }
  const generated = join(application, 'generated');
  run(join(mirrors, '.lake/build/bin/model_interface_gen'), ['bundle', '--lock',
    'test/fixtures/model-interface/counter/Counter.mirror-interface.lock.json', '--target', 'mirrorecma-async-v1', '--out', generated], mirrors);
  run(process.execPath, [join(ecma, 'node_modules/typescript/bin/tsc'), join(generated, 'Counter.suite.ts'),
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck',
    '--types', 'node', '--typeRoots', join(ecma, 'node_modules/@types')], application);
  run(process.execPath, ['--input-type=module', '-e',
    "import {generateAdapterKit} from 'mirrorgate/adapter-kit'; import {CounterModel} from './generated/Counter.suite.js'; await generateAdapterKit(CounterModel.publicManifest,{directory:'./public-kit'});"], application);
  // Install the trusted supervisor/runtime separately from the public SDK npm
  // package. This is an operator installation step, never per-evaluation work.
  const operator = join(original, 'operator'); mkdirSync(operator);
  for (const folder of ['bin', 'supervisor', 'runtimes/node', 'sdk/node', 'protocol']) {
    cpSync(join(gate, folder), join(operator, folder), {recursive: true, filter: path => !path.includes('__pycache__')});
  }
  copyFileSync(join(mirrors, '.lake/build/bin/mirror'), join(operator, 'bin/mirror'));
  mkdirSync(join(application, 'private'));
  copyFileSync(join(mirrors, 'specs/Counter.tla'), join(application, 'private/Counter.tla'));
  copyFileSync(join(mirrors, 'test/fixtures/model-interface/counter/counter.itf.json'), join(application, 'private/counter.itf.json'));
  const oneTick = JSON.parse(readFileSync(join(application, 'private/counter.itf.json')));
  oneTick.states = oneTick.states.slice(0, 2);
  writeFileSync(join(application, 'private/one-tick.itf.json'), JSON.stringify(oneTick));
  const submissions = join(application, 'submissions'); mkdirSync(submissions);
  for (const variant of ['correct', 'faulty', 'crash', 'hang', 'dispose-failure']) {
    const path = join(submissions, variant); mkdirSync(path);
    copyFileSync(join(gate, 'runtimes/node/examples/counter.mjs'), join(path, 'counter.mjs'));
    const overrides = variant === 'faulty' ? 'adapter.actions.Tick = ({Stride}) => counter.increment(Stride - 1n);'
      : variant === 'crash' ? 'adapter.actions.Tick = () => process.exit(17);'
      : variant === 'hang' ? 'adapter.actions.Tick = () => { while (true) {} };'
      : variant === 'dispose-failure' ? 'adapter.dispose = () => { throw new Error("private disposal diagnostic"); };' : '';
    writeFileSync(join(path, 'adapter.mjs'), `import {existsSync} from 'node:fs';
import {Counter, counterAdapter} from './counter.mjs';
export function createAdapter() {
  if (process.env.GATE_SUITE_SECRET || existsSync(${JSON.stringify(join(application, 'private/Counter.tla'))})) throw new Error('private execution access');
  const counter = new Counter(); const adapter = counterAdapter(counter); ${overrides} return adapter;
}\n`);
  }
  copyFileSync(join(integration, 'test/installed-suite-driver.mjs'), join(application, 'run.mjs'));
  // A real move demonstrates there is no original installation-root dependency.
  const installed = join(scratch, 'relocated-install'); renameSync(original, installed);
  const app = join(installed, 'application'), environment = join(installed, 'operator');
  // Operator preparation pins the actual relocated private canary path.
  for (const variant of ['correct', 'faulty', 'crash', 'hang', 'dispose-failure']) {
    const adapter = join(app, 'submissions', variant, 'adapter.mjs');
    writeFileSync(adapter, readFileSync(adapter, 'utf8').replaceAll(original, installed));
  }
  const nodeRoot = process.env.MIRRORGATE_NODE_RUNTIME_ROOT ?? dirname(dirname(process.execPath));
  const runtimeSha256 = createHash('sha256').update(readFileSync(join(nodeRoot, 'bin/node'))).digest('hex');
  const policyScript = `import json,sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1]+'/supervisor')\nfrom mirrorgate.control_policy import example_policy_document\np=example_policy_document(submission_root=sys.argv[2]+'/submissions',node_shim_root=sys.argv[1],node_runtime_root=sys.argv[3],policy_id='suite.counter',adapter_id='suite.counter',target_profile='mirrorecma-async-v1',state_computer_contract_version='mirrors.async-state-computer/v1')\np['schema']='mirrorgate.control-policy/v2'\np['agentProfiles']=[]\np['policies'][0]['agentProfileIds']=[]\np['policies'][0]['buildPlans']=[dict(id='node',profile='node-esm/v1',entryPoint='adapter.mjs',sourceFiles=['adapter.mjs','counter.mjs'],runtimeSha256=sys.argv[4],dependencies=[])]\nPath(sys.argv[2]+'/operator.json').write_text(json.dumps(p))\n`;
  run('python3', ['-c', policyScript, environment, app, nodeRoot, runtimeSha256]);
  const env = {...process.env, GATE_SUITE_SECRET: 'private evaluator secret', npm_config_offline: 'true',
    GATE_SUITE_HIDDEN_ROOTS: JSON.stringify([gate, ecma, mirrors]), GATE_SUITE_ORIGINAL_INSTALL: original};
  delete env.MIRRORECMA_ROOT; delete env.MIRRORS_ROOT; delete env.MIRROR_BIN; delete env.MODEL_INTERFACE_GEN;
  for (let iteration = 0; iteration < 2; iteration++) {
    const args = ['--die-with-parent', '--unshare-net', '--ro-bind', '/', '/', '--bind', '/tmp', '/tmp',
      '--dev-bind', '/dev', '/dev', '--proc', '/proc'];
    for (const repository of [gate, ecma, mirrors]) args.push('--tmpfs', repository);
    args.push('--chdir', app, '--', process.execPath, 'run.mjs', String(iteration));
    console.log(run('bwrap', args, app, env));
  }
  console.log('INSTALLED SUITE GREEN: packed once, relocated, offline, hidden source checkouts, repeated real worker execution');
} finally {
  if (process.env.KEEP_GATE_SUITE_CONSUMER === '1') console.log(`installed suite retained: ${scratch}`);
  else rmSync(scratch, {recursive: true, force: true});
}
