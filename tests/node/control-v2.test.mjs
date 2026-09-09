import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PassThrough, Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {ControlClient, ControlFrameDecoder, ControlProtocolError, controlFrame, validateOperationRecord} from '../../sdk/node/control.mjs';
import {HOSTING_CAPABILITY, HOSTING_LIMITS, validateControlV2Request, validateControlV2Response, validateControlV2Event, validatePublicTask} from '../../sdk/node/control-v2.mjs';
import {manifest} from './helpers.mjs';

const sessionId = '2'.repeat(32), runId = '3'.repeat(32);
const helloLimits = {maxFrameBytes: 1048576, maxJsonDepth: 128, maxJsonNodes: 16384, maxPendingOutputBytes: 4194304,
  maxSessionsPerConnection: 4, maxInflightRequestsPerConnection: 16, maxCompletedOperationsPerSession: 128,
  helloTimeoutMs: 5000, requestAckTimeoutMs: 5000, workerAttachmentTimeoutMs: 5000,
  sessionWallMs: 600000, gracefulStopMs: 1000, teardownMs: 5000};
const openArgs = {policyId: 'default', submission: {kind: 'source', input: {rootId: 'sources', relativePath: 'counter'}, buildPlanId: 'node-build', authoring: true}, runtime: 'node-v1', manifestJson: JSON.stringify(manifest)};
const startArgs = {profileId: 'restricted-codex', publicTask: {instructions: 'Implement the public Counter contract.', files: []}};
function running() { return {runId, phase: 'running', cleanup: {status: 'notStarted', remainingResources: []}, limits: {...HOSTING_LIMITS}, progress: {firstSeq: 1, nextSeq: 1, truncated: false, records: []}}; }
function submitted() { return {...running(), phase: 'finished', outcome: 'submitted', cleanup: {status: 'succeeded', remainingResources: []}, submission: {submissionId: '4'.repeat(32), sourceHash: 'a'.repeat(64), sourceRevision: 1}}; }

function fakeTransport(t, handler) {
  const readable = new PassThrough(); let stopped = 0; let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const requests = [];
  const send = value => readable.write(controlFrame(value));
  const decoder = new ControlFrameDecoder(request => {
    requests.push(request);
    queueMicrotask(() => {
      const respond = result => send({v: request.op === 'hello' ? 1 : 2, kind: 'response', id: request.id, ok: true, result});
      if (handler?.(request, {respond, send, readable}) === true) return;
      if (request.op === 'hello') respond({controlVersion: 2, instanceId: '1'.repeat(32), capabilities: [{id: HOSTING_CAPABILITY, available: true, enforcedScope: 'session', limits: {}}], limits: helloLimits});
      else if (request.op === 'session.open') respond({sessionId});
      else if (request.op === 'agent.start') respond({runId});
      else if (request.op === 'agent.status') respond({run: running()});
      else if (request.op === 'agent.cancel') respond({run: submitted()});
    });
  });
  const writable = new Writable({write(chunk, _, done) { try { decoder.push(chunk); done(); } catch (e) { done(e); } },
    final(done) { readable.end(); resolveClosed(); done(); }});
  const transport = {readable, writable, ownership: 'attached', closed, stop() { stopped++; readable.end(); resolveClosed(); }};
  t.after(() => { readable.destroy(); writable.destroy(); resolveClosed(); });
  return {transport, requests, send, stopped: () => stopped};
}
async function clientFor(t, handler, options = {}) {
  const fake = fakeTransport(t, handler);
  const client = await ControlClient.fromTransport(fake.transport, {controlVersion: 2, requestTimeoutMs: 100, helloTimeoutMs: 1000, ...options});
  t.after(() => client.close().catch(() => {}));
  return {client, ...fake};
}

test('Node hosting codec agrees with every shared v2 vector', async () => {
  const vectors = (await readFile(new URL('../../conformance/control-v2/vectors.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const vector of vectors) {
    const validate = () => ({
      request: () => validateControlV2Request(vector.value),
      response: () => validateControlV2Response(vector.value, {request: vector.request, operation: vector.operation}),
      event: () => validateControlV2Event(vector.value, {operation: vector.operation}),
      operation: () => validateOperationRecord(vector.value, vector.operation),
    })[vector.kind]();
    if (vector.valid) assert.doesNotThrow(validate, vector.name);
    else assert.throws(validate, ControlProtocolError, vector.name);
  }
});

test('v2 task validation rejects unicode byte overflow and prefix/reserved paths', () => {
  validatePublicTask({instructions: 'x', files: [{path: 'a', text: '汉'.repeat(87381) + 'x'}]});
  for (const files of [
    [{path: 'a', text: '汉'.repeat(87382)}], [{path: '.mirrorgate/x', text: ''}],
    [{path: 'a/b', text: ''}, {path: 'a', text: ''}], [{path: '../a', text: ''}],
  ]) assert.throws(() => validatePublicTask({instructions: 'x', files}), ControlProtocolError);
});

test('bootstrap is v1 with only v2 offered and required hosting capability; later frames are v2', async t => {
  const {client, requests} = await clientFor(t);
  const session = await client.openSession(openArgs);
  const run = await session.startAgent(startArgs);
  assert.equal(run.id, runId);
  assert.deepEqual(requests[0], {v: 1, kind: 'request', id: 1, op: 'hello', args: {controlVersions: [2], requiredCapabilities: [HOSTING_CAPABILITY]}});
  assert.deepEqual(requests.slice(1).map(r => r.v), [2, 2]);
  assert.equal((await session.agentStatus()).runId, run.id);
});

test('v1 downgrade and missing hosting grant fail before allocation', async t => {
  for (const [controlVersion, capabilities] of [[1, []], [2, []]]) {
    const fake = fakeTransport(t, (request, {respond}) => {
      respond({controlVersion, instanceId: '1'.repeat(32), capabilities, limits: helloLimits}); return true;
    });
    await assert.rejects(ControlClient.fromTransport(fake.transport, {controlVersion: 2}), ControlProtocolError);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.stopped(), 1);
  }
});

test('invalid public input or pre-start cancellation allocates nothing and permits a corrected request', async t => {
  const {client, requests} = await clientFor(t);
  const session = await client.openSession(openArgs);
  await assert.rejects(session.startAgent({...startArgs, publicTask: {instructions: 'x', files: [{path: '../private', text: ''}]}}), ControlProtocolError);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(session.startAgent(startArgs, {signal: abort.signal}), {code: 'CONTROL_REQUEST_CANCELLED'});
  assert.equal(requests.filter(r => r.op === 'agent.start').length, 0);
  await session.startAgent(startArgs);
  assert.equal(requests.filter(r => r.op === 'agent.start').length, 1);
});

test('run is registered before a coalesced finished event; submit identity remains immutable', async t => {
  const {client, send} = await clientFor(t, (request, {readable}) => {
    if (request.op !== 'agent.start') return false;
    readable.write(Buffer.concat([
      controlFrame({v: 2, kind: 'response', id: request.id, ok: true, result: {runId}}),
      controlFrame({v: 2, kind: 'event', seq: 1, sessionId, event: 'agent.finished', data: {run: submitted()}}),
    ])); return true;
  });
  const session = await client.openSession(openArgs);
  const run = await session.startAgent(startArgs);
  assert.equal(run.latest.outcome, 'submitted');
  const invalid = submitted(); invalid.submission.sourceHash = 'b'.repeat(64);
  send({v: 2, kind: 'event', seq: 2, sessionId, event: 'agent.finished', data: {run: invalid}});
  assert.equal(client.terminalError?.code, 'CONTROL_PROTOCOL_ERROR');
});

test('foreign run replies, premature events and unfinished cancellation poison the connection', async t => {
  for (const fault of ['foreign', 'early', 'cancel']) await t.test(fault, async t => {
    const {client} = await clientFor(t, (request, {respond, send}) => {
      if (fault === 'early' && request.op === 'agent.start') {
        send({v: 2, kind: 'event', seq: 1, sessionId, event: 'agent.updated', data: {run: running()}}); return true;
      }
      if (fault === 'foreign' && request.op === 'agent.status') { respond({run: {...running(), runId: 'f'.repeat(32)}}); return true; }
      if (fault === 'cancel' && request.op === 'agent.cancel') { respond({run: running()}); return true; }
    });
    const session = await client.openSession(openArgs);
    if (fault === 'early') await assert.rejects(session.startAgent(startArgs), ControlProtocolError);
    else {
      const run = await session.startAgent(startArgs);
      await assert.rejects(fault === 'cancel' ? run.cancel() : run.status(), ControlProtocolError);
    }
    assert.equal(client.terminalError?.code, 'CONTROL_PROTOCOL_ERROR');
  });
});

test('uncertain start is not replayed and attached transport is closed once', async t => {
  const {client, requests, stopped} = await clientFor(t, request => request.op === 'agent.start', {requestTimeoutMs: 20});
  const session = await client.openSession(openArgs);
  await assert.rejects(session.startAgent(startArgs), {code: 'CONTROL_REQUEST_TIMEOUT'});
  await assert.rejects(session.startAgent(startArgs), {code: 'STATE_INVALID'});
  await delay(1);
  assert.equal(requests.filter(r => r.op === 'agent.start').length, 1);
  assert.equal(stopped(), 1);
});

test('cancel joins cleanup with a minimum 7-second request timeout and is idempotent locally', async t => {
  const {client, requests} = await clientFor(t, (request, {respond}) => {
    if (request.op === 'agent.cancel') { setTimeout(() => respond({run: submitted()}), 30); return true; }
  }, {requestTimeoutMs: 5});
  const session = await client.openSession(openArgs);
  const run = await session.startAgent(startArgs);
  const a = run.cancel('user-cancel', {timeoutMs: 1});
  const b = run.cancel();
  assert.equal(a, b);
  assert.equal((await a).cleanup.status, 'succeeded');
  assert.equal(requests.filter(r => r.op === 'agent.cancel').length, 1);
});

test('hosted handles cannot be constructed or adopted by another session', async t => {
  const a = await clientFor(t), b = await clientFor(t);
  const first = await a.client.openSession(openArgs), second = await b.client.openSession(openArgs);
  const run = await first.startAgent(startArgs);
  assert.throws(() => second._owned(run, run.constructor, 'hosted run'), {code: 'HANDLE_INVALID'});
  assert.throws(() => new run.constructor(second, run.id), {code: 'HANDLE_INVALID'});
});

test('uncertain owned-v2 request delivers EOF and allows controller cleanup before reaping', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'node-hosting-owner-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const marker = join(directory, 'cleaned');
  const script = `
    const {createInterface}=require('node:readline');const {writeFileSync}=require('node:fs');
    const input=createInterface({input:process.stdin});
    input.on('line',line=>{const q=JSON.parse(line);if(q.op==='hello')process.stdout.write(JSON.stringify({v:1,kind:'response',id:q.id,ok:true,result:{controlVersion:2,instanceId:'1'.repeat(32),capabilities:[{id:'hosting.fresh-agent-v1',available:true,enforcedScope:'session',limits:{}}],limits:${JSON.stringify(helloLimits)}}})+'\\n');});
    input.on('close',()=>setTimeout(()=>{writeFileSync(process.argv[1],'cleaned');process.exit(0);},100));
  `;
  const client = await ControlClient.launch({controlVersion: 2, requestTimeoutMs: 20,
    controller: {command: process.execPath, args: ['--eval', script, marker]}});
  await assert.rejects(client._request('session.status', {sessionId}), {code: 'CONTROL_REQUEST_TIMEOUT'});
  await client.close();
  assert.equal(await readFile(marker, 'utf8'), 'cleaned');
});

test('owned-v2 controller abnormal exit cannot masquerade as successful cleanup', async () => {
  const script = `
    const {createInterface}=require('node:readline');const input=createInterface({input:process.stdin});
    input.on('line',line=>{const q=JSON.parse(line);process.stdout.write(JSON.stringify({v:1,kind:'response',id:q.id,ok:true,result:{controlVersion:2,instanceId:'1'.repeat(32),capabilities:[{id:'hosting.fresh-agent-v1',available:true,enforcedScope:'session',limits:{}}],limits:${JSON.stringify(helloLimits)}}})+'\\n');});
    input.on('close',()=>process.exit(7));
  `;
  const client = await ControlClient.launch({controlVersion: 2, controller: {command: process.execPath, args: ['--eval', script]}});
  await assert.rejects(client.close(), {code: 'CONTROL_CLEANUP_FAILED'});
});

test('local wait cancellation and deadline leave a delayed readonly poll and owner alive', async t => {
  for (const reason of ['abort', 'deadline']) await t.test(reason, async t => {
    let polling; const polled = new Promise(resolve => { polling = resolve; });
    let delayedReply;
    const {client, requests, stopped} = await clientFor(t, (request, {respond, send}) => {
      if (request.op !== 'agent.status') return false;
      delayedReply = failed => failed
        ? send({v: 2, kind: 'response', id: request.id, ok: false, error: {code: 'STATE_INVALID', stage: 'hosting', message: 'Late read failure'}})
        : respond({run: submitted()});
      polling(); return true;
    }, {requestTimeoutMs: 1000});
    const session = await client.openSession(openArgs);
    const run = await session.startAgent(startArgs);
    const abort = new AbortController();
    const wait = run.wait({signal: abort.signal, timeoutMs: reason === 'deadline' ? 20 : 1000});
    const rejected = assert.rejects(wait, {code: reason === 'abort' ? 'CONTROL_WAIT_CANCELLED' : 'CONTROL_WAIT_TIMEOUT'});
    await polled;
    if (reason === 'abort') abort.abort();
    await rejected;
    assert.equal(client.terminalError, null);
    assert.equal(stopped(), 0);
    assert.equal(requests.filter(request => request.op === 'agent.cancel').length, 0);
    assert.equal(client.pending.size, 1, 'readonly poll remains bounded by its normal request timeout');
    delayedReply(reason === 'abort'); await delay(1);
    assert.equal(client.pending.size, 0);
    if (reason === 'abort') assert.equal(run.latest, null, 'late read rejection is observed without an unhandled rejection');
    else assert.equal(run.latest.outcome, 'submitted');
    assert.equal(client.terminalError, null);
    assert.equal((await run.cancel()).outcome, 'submitted', 'explicit cancellation remains usable on the same owner');
    assert.equal(requests.filter(request => request.op === 'agent.cancel').length, 1);
  });
});
