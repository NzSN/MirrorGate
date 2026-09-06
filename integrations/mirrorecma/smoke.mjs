import {strict as assert} from 'node:assert';
import {readFile, mkdir, mkdtemp, rm, cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {gateRoot, launchWorker} from '../../conformance/helpers.mjs';
import {publicManifest} from './public-manifest.mjs';
import {toGateNative, toMirrorNative} from './native-values.mjs';

// This module is evaluator-owned. It is never placed in a worker artifact.
const ecmaRoot = resolve(process.env.MIRRORECMA_ROOT ?? join(gateRoot, '../MirrorECMA'));
const mirrorsRoot = resolve(process.env.MIRRORS_ROOT ?? join(gateRoot, '../Mirrors'));
const mirror = resolve(process.env.MIRROR_BIN ?? join(mirrorsRoot, '.lake/build/bin/mirror'));
const output = join(gateRoot, '.work/ecma');
await mkdir(output, {recursive: true});
const compilation = spawnSync(process.execPath, [join(ecmaRoot, 'node_modules/typescript/bin/tsc'), '-p', join(ecmaRoot, 'tsconfig.examples.json'), '--outDir', output], {cwd: ecmaRoot, encoding: 'utf8'});
assert.ifError(compilation.error);
assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);
const ecma = await import(pathToFileURL(join(output, 'src/index.js')));
const generated = await import(pathToFileURL(join(output, 'test/fixtures/model-interface/counter/generated-async/CounterMirror.generated.js')));
const counterLock = JSON.parse(await readFile(join(ecmaRoot, 'test/fixtures/model-interface/counter/Counter.mirror-interface.lock.json'), 'utf8'));
const counterPort = publicManifest(counterLock, generated.CounterSemanticDigest);
const privateArea = await mkdtemp(join(tmpdir(), 'mirrorgate-evaluator-private-'));

try {
  const spec = join(privateArea, 'Counter.tla');
  const trace = join(privateArea, 'counter.itf.json');
  await cp(join(mirrorsRoot, 'specs/Counter.tla'), spec);
  await cp(join(ecmaRoot, 'test/fixtures/model-interface/counter/counter.itf.json'), trace);
  const config = {specPath: spec, invariant: 'TraceComplete', constInit: 'CInit', lengthBound: 6, paramVars: 'parameters'};
  for (const runtime of ['node-v1', 'rust-v1']) for (const faulty of [false, true]) {
    let factoryCalls = 0, disposalCalls = 0;
    const digest = ecma.semanticDigestFromHex(generated.CounterSemanticDigest);
    const key = {semanticDigest: digest, adapterId: `mirrorgate/${runtime}`, targetProfile: ecma.MIRRORECMA_ASYNC_TARGET_PROFILE, stateComputerContractVersion: ecma.ASYNC_STATE_COMPUTER_CONTRACT_VERSION};
    const registry = new ecma.CompiledAdapterRegistry([{key, factory: async effective => {
      factoryCalls += 1;
      const worker = await launchWorker(runtime, {faulty, manifest: counterPort});
      try {
        // Only public operation inputs cross into the worker; no model context.
        const binding = generated.bindCounter({
          initialize: context => worker.client.invoke('Initialize', {}, {signal: context.signal}),
          tick: (input, context) => worker.client.invoke('Tick', {Stride: input.stride}, {signal: context.signal}),
          observe: async context => ({count: (await worker.client.observe({signal: context.signal})).Count}),
        }, effective);
        return {semanticDigest: digest, computer: binding.computer,
          assertCompatibleConfig: candidate => assert.equal(candidate.paramVars, 'parameters'),
          dispose: async () => { disposalCalls += 1; binding.dispose(); await worker.close(); }};
      } catch (error) { await worker.close(); throw error; }
    }}]);
    const selection = {metadata: generated.CounterModelInterface, adapterId: key.adapterId, targetProfile: key.targetProfile, stateComputerContractVersion: key.stateComputerContractVersion, registry, policy: 'require'};
    const run = ecma.runClientWithTracesNegotiatedWithReport(mirror, config, [trace], selection, {actionTimeoutMs: 10000, receiveTimeoutMs: 10000});
    if (faulty) await assert.rejects(run, error => error instanceof ecma.ReplayMismatchError && error.action === 'tick' && error.actual.count.val === 1n && error.expected.count.val === 2n);
    else { const report = await run; assert.equal(report.statesMatched, 3); assert.equal(report.stepsCompleted, 2); }
    assert.equal(factoryCalls, 1); assert.equal(disposalCalls, 1);
    console.log(`${runtime}: private evaluator Counter ${faulty ? 'rejected the real bug' : 'matched all states'} through the public port.`);
  }

  const queueLock = JSON.parse(await readFile(join(ecmaRoot, 'examples/work-queue/artifacts/WorkQueue.mirror-interface.lock.json'), 'utf8'));
  const queueManifest = publicManifest(queueLock, queueLock.semanticDigest);
  const queueSpec = join(privateArea, 'WorkQueue.tla');
  const queueTrace = join(privateArea, 'queue.itf.json');
  await cp(join(ecmaRoot, 'examples/work-queue/specs/WorkQueue.tla'), queueSpec);
  await cp(join(ecmaRoot, 'examples/work-queue/artifacts/witness.itf.json'), queueTrace);
  const queueSource = await readFile(join(output, 'examples/work-queue/queue.js'), 'utf8');
  for (const faulty of [false, true]) {
    let worker, observation;
    const selection = {mode: 'dynamic', policy: 'require', contract: queueLock.contract,
      semanticDigest: queueLock.semanticDigest, descriptorCache: new ecma.DescriptorCache(),
      createRegistry: async () => {
        const source = `import {WorkQueue, BrokenWorkQueue} from './queue.mjs';
export async function createAdapter() {
  const queue = await ${faulty ? 'BrokenWorkQueue' : 'WorkQueue'}.create();
  return { actions: {
    Initialize: (_, c) => queue.initialize(c.signal), Enqueue: ({Item}, c) => queue.enqueue(Item, c.signal),
    Start: (_, c) => queue.start(c.signal), Fail: (_, c) => queue.fail(c.signal), Retry: (_, c) => queue.retry(c.signal),
    Complete: (_, c) => queue.complete(c.signal), Reset: (_, c) => queue.reset(c.signal),
  }, observe: async c => { const s = await queue.observe(c.signal); return {Pending:s.pending,InFlight:s.inFlight,Completed:s.completed,Failed:s.failed}; },
  dispose: () => queue.dispose() };
}`;
        worker = await launchWorker('node-v1', {manifest: queueManifest, adapterSource: source, extraFiles: {'queue.mjs': queueSource}});
        const invoke = operation => async (inputs, context) => {
          observation = undefined;
          const converted = Object.fromEntries(operation.inputs.map(input => [input.id, toGateNative(input.type, inputs[input.id])]));
          await worker.client.invoke(operation.id, converted, {signal: context.signal});
        };
        const observe = field => async context => {
          observation ??= worker.client.observe({signal: context.signal});
          return toMirrorNative(field.type, (await observation)[field.id]);
        };
        return {execution: 'async', registry: {semanticDigest: ecma.semanticDigestFromHex(queueLock.semanticDigest),
          actions: Object.fromEntries([...queueManifest.initializers,...queueManifest.actions].map(op => [op.id,invoke(op)])),
          observations: Object.fromEntries(queueManifest.observations.map(op => [op.id,observe(op)]))},
          dispose: () => worker.close()};
      }};
    const run = ecma.runClientWithTracesNegotiatedWithReport(mirror,
      {specPath: queueSpec, initPredicate: 'Init', nextPredicate: 'WitnessNext', invariant: 'TraceComplete', lengthBound: 15, paramVars: 'parameters'},
      [queueTrace], selection, {actionTimeoutMs: 10000, receiveTimeoutMs: 10000});
    if (faulty) await assert.rejects(run, error => error instanceof ecma.ReplayMismatchError && error.action === 'enqueue' && error.stateIndex === 2);
    else { const report = await run; assert.equal(report.statesMatched, 16); assert.equal(report.stepsCompleted, 15); }
    console.log(`node-v1: isolated queue ${faulty ? 'rejected duplicate-handling bug' : 'passed retry/reset witness'}.`);
  }
} finally { await rm(privateArea, {recursive: true, force: true}); }
console.log('MirrorECMA trusted evaluator integration passed; private model files were never worker mounts.');
