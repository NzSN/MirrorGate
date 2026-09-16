import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validatePublicContract, validatePublicTask, PUBLIC_ENVIRONMENT_CAPABILITY} from '../../sdk/node/control-v2.mjs';
const fixture=JSON.parse(await readFile(new URL('../../conformance/public-contract-v2.json',import.meta.url)));
test('negotiated public environment validates without widening publicTask',()=>{
  assert.equal(PUBLIC_ENVIRONMENT_CAPABILITY,'hosting.public-environment-v1');
  assert.equal(validatePublicContract(fixture),fixture);
  assert.throws(()=>validatePublicTask({...fixture.task,environment:fixture.environment}));
  for (const change of [v=>v.environment.stages.execution.writable.push('/private'),v=>v.environment.entryPoint='../escape',
    v=>v.environment.tools.push('unapproved'),v=>v.environment.hostPath='/private',v=>v.environment.limits.stdoutBytes=0,
    v=>v.task.expected='secret',v=>v.environment.stages.authoring.root='/home/private']) {
    const altered=structuredClone(fixture);change(altered);assert.throws(()=>validatePublicContract(altered));
  }
});
