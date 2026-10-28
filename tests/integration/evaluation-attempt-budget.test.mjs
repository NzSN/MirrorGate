import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, symlinkSync, renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {openAttemptBudget} from '../../integrations/mirrorecma/service/attempt-budget.mjs';
import {startEvaluationService} from '../../integrations/mirrorecma/service/index.mjs';
import {connectEvaluationService, newEvaluationStartKey} from '../../integrations/mirrorecma/service/proxy.mjs';

const token = 'a'.repeat(64);
function setup(t, maxAttempts = 2) {
  const root = mkdtempSync(join(tmpdir(), 'gate-private-budget-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const directory = join(root, 'budget'); mkdirSync(directory, {mode:0o700});
  return {root, options:{directory, authorRef:'alice', corpusDigest:'b'.repeat(64), maxAttempts}};
}
function result() {
  return {publicResult:{schema:'mirrorgate.evaluation/v1', runRef:randomUUID(), status:'passed', cleanup:'confirmed',
    counts:{acceptedTraces:3, acceptedSteps:7}, failureStage:'evaluate', implementation:{artifactHash:'c'.repeat(64)}}};
}
async function service(t, budget, evaluate = async () => result(), extra = {}) {
  const instance = await startEvaluationService({requirePersistentBudget:true, callers:[{id:'alice', token,
    bindings:[{suiteRef:'Counter.v1', implementationRef:'correct.v1', evaluate, attemptBudget:budget, ...extra}]}]});
  t.after(() => instance.close());
  const proxy = await connectEvaluationService({origin:instance.origin, token});
  return {instance, proxy};
}
const request = () => ({startKey:newEvaluationStartKey(), suiteRef:'Counter.v1', implementationRef:'correct.v1'});

test('private attempt budget survives service restart and duplicate starts spend once', async t => {
  const {options} = setup(t, 1); let calls = 0;
  const first = await service(t, options, async () => { calls++; return result(); });
  const start = request(), accepted = await first.proxy.start(start);
  assert.equal((await first.proxy.start(start)).runId, accepted.runId);
  const finished = await first.proxy.wait(accepted.runId, {pollMs:5});
  assert.equal(finished.result.status, 'passed');
  assert.equal(finished.result.counts, undefined);
  assert.equal(finished.result.failureStage, undefined);
  assert.equal(finished.result.implementation, undefined);
  await first.instance.close();
  const second = await service(t, options, async () => { calls++; return result(); });
  await assert.rejects(second.proxy.start(request()), {code:'LIMIT_EXCEEDED'});
  assert.equal(calls, 1);
});

test('rejected workflows spend attempts and policy changes cannot reset a directory', async t => {
  const {options} = setup(t, 1);
  const first = await service(t, options, async () => { throw new Error('private failure'); });
  const start = await first.proxy.start(request());
  assert.equal((await first.proxy.wait(start.runId, {pollMs:5})).phase, 'unconfirmed');
  await assert.rejects(first.proxy.start(request()), {code:'LIMIT_EXCEEDED'});
  for (const changed of [{maxAttempts:2}, {corpusDigest:'d'.repeat(64)}, {authorRef:'bob'}]) {
    assert.throws(() => openAttemptBudget({...options, ...changed}, 'alice'));
  }
});

test('partial crash marker remains spent; concurrent services share the same ceiling', async t => {
  const {options} = setup(t, 2);
  const initial = openAttemptBudget(options, 'alice'); initial.close();
  writeFileSync(join(options.directory, 'attempt-0'), '', {mode:0o600, flag:'wx'});
  let calls = 0;
  const a = await service(t, options, async () => {calls++; return result();});
  const b = await service(t, options, async () => {calls++; return result();});
  const attempts = await Promise.allSettled([a.proxy.start(request()), b.proxy.start(request())]);
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(x => x.status === 'rejected' && x.reason.code === 'LIMIT_EXCEEDED').length, 1);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 1);
});

test('exclusive marker creation also bounds independent concurrent threads', async t => {
  const {options} = setup(t, 3);
  const initial = openAttemptBudget(options, 'alice'); initial.close();
  const module = new URL('../../integrations/mirrorecma/service/attempt-budget.mjs', import.meta.url).href;
  const values = await Promise.all(Array.from({length:8}, () => new Promise((resolve, reject) => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      import(workerData.module).then(({openAttemptBudget})=>{const budget=openAttemptBudget(workerData.options,'alice');
        try{budget.consume();parentPort.postMessage('spent');}catch(e){parentPort.postMessage(e.code);}finally{budget.close();}}).catch(e=>{throw e});`,
      {eval:true, workerData:{module, options}});
    worker.once('message', resolve); worker.once('error', reject);
  })));
  assert.equal(values.filter(x => x === 'spent').length, 3);
  assert.equal(values.filter(x => x === 'LIMIT_EXCEEDED').length, 5);
});

test('private mode requires budgets and explicit disclosure only enables selected fields', async t => {
  await assert.rejects(startEvaluationService({requirePersistentBudget:true, callers:[{id:'alice',token,
    bindings:[{suiteRef:'Counter.v1',implementationRef:'correct.v1',evaluate:async()=>result()}]}]}));
  const {options} = setup(t, 1);
  const f = await service(t, options, async () => result(), {disclosure:{counts:true}});
  const start = await f.proxy.start(request()), finished = await f.proxy.wait(start.runId, {pollMs:5});
  assert.deepEqual(finished.result.counts, {acceptedTraces:3, acceptedSteps:7});
  assert.equal(finished.result.implementation, undefined);
});

test('failed durable marker sync never invokes or refunds an evaluation', async t => {
  const {options} = setup(t, 1);
  const budget = openAttemptBudget(options, 'alice'); budget.close();
  let calls = 0;
  const f = await service(t, options, async () => {calls++; return result();});
  const original = fs.fsyncSync;
  try {
    fs.fsyncSync = () => {throw new Error('private storage failure');};
    syncBuiltinESMExports();
    await assert.rejects(f.proxy.start(request()), {code:'SERVICE_UNAVAILABLE'});
  } finally {fs.fsyncSync = original; syncBuiltinESMExports();}
  await assert.rejects(f.proxy.start(request()), {code:'LIMIT_EXCEEDED'});
  assert.equal(calls, 0);
});

test('symlinks, directory replacement, unsafe permissions and corrupted configuration fail closed', t => {
  const {root, options} = setup(t, 1);
  const link = join(root, 'link'); symlinkSync(options.directory, link);
  assert.throws(() => openAttemptBudget({...options, directory:link}, 'alice'));
  chmodSync(options.directory, 0o755);
  assert.throws(() => openAttemptBudget(options, 'alice')); chmodSync(options.directory, 0o700);
  const budget = openAttemptBudget(options, 'alice');
  t.after(() => budget.close());
  renameSync(options.directory, join(root, 'old')); mkdirSync(options.directory, {mode:0o700});
  assert.throws(() => budget.consume(), {code:'SERVICE_UNAVAILABLE'});
  writeFileSync(join(options.directory, 'budget.json'), '{}', {mode:0o600});
  assert.throws(() => openAttemptBudget(options, 'alice'));
});
