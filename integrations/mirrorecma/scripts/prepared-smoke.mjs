import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, copyFileSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {ControlClient} from 'mirrorgate/control';
import {decodeSemanticDescriptor, semanticDescriptorDigest, MODEL_INTERFACE_DESCRIPTOR_SCHEMA, runClientWithTracesNegotiatedWithReport, ReplayMismatchError} from 'mirrorecma';
import {createSandboxCompiledModel, createSandboxPublicManifest, createPreparedImplementationProvider} from 'mirrorgate-mirrorecma';
import {evaluateSandboxed} from 'mirrorgate-mirrorecma/legacy';
import * as generated from './CounterMirror.generated.js';
const [gate, ecma] = process.argv.slice(2);
const mirrors = process.env.MIRRORS_ROOT;
assert(mirrors, 'MIRRORS_ROOT is required');
const model = createSandboxCompiledModel({
  metadata: generated.CounterModelInterface,
  descriptor: (() => {
    const {contract, semanticDigest, provenance, provenanceDigest, ...rest} = JSON.parse(readFileSync(join(ecma,
      'test/fixtures/model-interface/counter/Counter.mirror-interface.lock.json'), 'utf8'));
    return decodeSemanticDescriptor({...rest, schema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA});
  })(),
  adapterId: 'counter.generated-async-v1', publicManifest: generated.CounterPublicManifest,
  targetProfile: generated.CounterAsyncTargetProfile,
  stateComputerContractVersion: generated.CounterAsyncStateComputerContractVersion,
  bindPublicPort: generated.bindCounterAsyncPublicPort,
});
const root = resolve('submissions');
const privateCanary = resolve('private-canary');
writeFileSync(privateCanary, 'trusted-only');
process.env.GATE_MBT_PRIVATE_CANARY = 'trusted-only';
for (const variant of ['correct', 'faulty']) {
  mkdirSync(join(root, variant), {recursive:true});
  copyFileSync(join(gate, 'runtimes/node/examples', variant === 'correct' ? 'counter.mjs' : 'faulty-counter.mjs'), join(root, variant, 'adapter.mjs'));
  copyFileSync(join(gate, 'runtimes/node/examples/counter.mjs'), join(root, variant, 'counter.mjs'));
  const adapter = join(root, variant, 'adapter.mjs');
  writeFileSync(adapter, `import {existsSync} from 'node:fs';
if(existsSync(${JSON.stringify(privateCanary)}) || process.env.GATE_MBT_PRIVATE_CANARY) throw new Error('private execution access');
` + readFileSync(adapter, 'utf8'));
  writeFileSync(join(root, variant, 'build.py'), `import os, shutil
assert not os.path.exists(${JSON.stringify(privateCanary)}), 'private build access'
assert 'GATE_MBT_PRIVATE_CANARY' not in os.environ
shutil.copytree('/source', '/output', dirs_exist_ok=True)
`);
}
const policyFile = resolve('policy.json');
const policy = spawnSync('python3', [join(gate,'tests/control_policy_fixture.py'), policyFile, root,
  '--policy-id','integration.counter', '--adapter-id','counter.generated-async-v1',
  '--target-profile','mirrorecma-async-v1', '--state-computer-contract-version','mirrors.async-state-computer/v1'], {encoding:'utf8'});
assert.equal(policy.status, 0, policy.stderr);
const policyDocument = JSON.parse(readFileSync(policyFile, 'utf8'));
policyDocument.policies[0].buildPlans[0].command = ['/usr/bin/python3', '/source/build.py'];
writeFileSync(policyFile, JSON.stringify(policyDocument));
const config = {specPath:join(mirrors,'specs/Counter.tla'), invariant:'TraceComplete', lengthBound:6, paramVars:'parameters'};
const trace = join(gate,'conformance/control-v1/counter.itf.json');
const mirror = process.env.MIRROR_BIN ?? join(mirrors,'.lake/build/bin/mirror');
const wrongDescriptor = structuredClone(model.descriptor);
wrongDescriptor.runProfile.itfParamVars = ['ghost'];
wrongDescriptor.runProfile.effectiveParamVars = ['ghost', 'parameters'];
const wrongDigest = semanticDescriptorDigest(decodeSemanticDescriptor(wrongDescriptor));
const wrongModel = createSandboxCompiledModel({
  metadata: {semanticDigest: wrongDigest, contract: generated.CounterModelInterface.contract},
  descriptor: wrongDescriptor, adapterId: model.adapterId,
  publicManifest: createSandboxPublicManifest(wrongDescriptor, wrongDigest),
  targetProfile: generated.CounterAsyncTargetProfile,
  stateComputerContractVersion: generated.CounterAsyncStateComputerContractVersion,
  bindPublicPort: generated.bindCounterAsyncPublicPort,
});
for (const variant of ['correct', 'faulty', 'wrong-digest']) {
  const currentModel = variant === 'wrong-digest' ? wrongModel : model;
  const relativePath = variant === 'wrong-digest' ? 'correct' : variant;
  const client = await ControlClient.launch({onStderr:chunk=>process.stderr.write(chunk),controller:{command:join(gate,'bin/mirrorgate'),args:['control','--stdio','--policy-file',policyFile]}});
  let provider; let primary; let cleanup; let launches = 0;
  try {
    const session = await client.openSession({policyId:'integration.counter', submission:{kind:'source',buildPlanId:'copy',authoring:false,input:{rootId:'submission',relativePath}},
      runtime:'node-v1', manifestJson:JSON.stringify(currentModel.publicManifest)});
    session.onEvent(event => { if(event.event === 'worker.started') launches++; });
    const prepared = await (await session.prepare()).wait();
    assert.equal(prepared.status,'succeeded');
    assert.match(prepared.result.sourceHash, /^[0-9a-f]{64}$/);
    provider = await createPreparedImplementationProvider({session,prepared:prepared.result,model:currentModel,runtime:'node-v1',policyId:'integration.counter'});
    assert.equal(launches,0);
    try { await runClientWithTracesNegotiatedWithReport(mirror,config,[trace],provider.selection); }
    catch(error) { primary = error; }
    cleanup = await provider.close({status:primary ? 'mismatch':'passed'});
    assert.equal(cleanup.status,'confirmed'); assert.deepEqual(cleanup.remainingResources,[]);
    if(variant === 'correct') assert.equal(primary,undefined);
    else if (variant === 'faulty') assert(primary instanceof ReplayMismatchError, String(primary));
    else assert(primary && primary.code === 'interface_digest_mismatch', String(primary));
    assert.equal(launches,variant === 'wrong-digest' ? 0 : 1);
    console.log(JSON.stringify({path:'prepared-provider',variant,status:primary ? (variant === 'wrong-digest' ? 'modelNegotiation' : 'mismatch') : 'passed',cleanup:cleanup.status,launches,buildAndExecutionCanaries:variant !== 'wrong-digest'}));
  } finally { if(provider) await provider.close(); else await client.close(); }
  const result = await evaluateSandboxed({gate:{kind:'owned',launcher:{command:join(gate,'bin/mirrorgate')},policyFile},
    policyId:'integration.counter',submission:{kind:'source',buildPlanId:'copy',authoring:false,input:{rootId:'submission',relativePath}},runtime:'node-v1',model:currentModel,
    replay:{kind:'traces',target:mirror,config,tracePaths:[trace]}});
  assert.equal(result.status,variant === 'correct'?'passed':variant === 'faulty'?'mismatch':'failed'); assert.equal(result.cleanup,'confirmed');
  console.log(JSON.stringify({path:'packed-legacy',variant,status:result.status,cleanup:result.cleanup}));
}
console.log('PACKED PREPARED/V1 SANDBOX + LEGACY GREEN');
