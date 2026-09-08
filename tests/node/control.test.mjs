import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough, Writable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {ControlClient, ControlFrameDecoder, ControlProtocolError, controlFrame, parseControlJson, validateAttachmentRecord, validateControlEvent, validateControlRequest, validateControlResponse, validateOperationRecord} from '../../sdk/node/control.mjs';
import {FrameDecoder} from '../../sdk/node/protocol.mjs';
import {manifest} from './helpers.mjs';

const manifestJson = JSON.stringify(manifest);
const sessionId = index => String(index).padStart(32, String(index));
const authorizationId = index => index.toString(16).padStart(32, 'a');
const workerId = index => index.toString(16).padStart(32, 'b');
const helloLimits = {
  maxFrameBytes: 1_048_576, maxJsonDepth: 128, maxJsonNodes: 16_384,
  maxPendingOutputBytes: 4_194_304, maxSessionsPerConnection: 4,
  maxInflightRequestsPerConnection: 16, maxCompletedOperationsPerSession: 128,
  helloTimeoutMs: 5_000, requestAckTimeoutMs: 5_000,
  workerAttachmentTimeoutMs: 5_000, sessionWallMs: 600_000,
  gracefulStopMs: 1_000, teardownMs: 5_000,
};

function fakeControl(t, handler, requiredCapabilities = []) {
  const readable = new PassThrough();
  const requests = [];
  let stopped = 0;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const send = message => readable.write(controlFrame(message));
  const decoder = new ControlFrameDecoder(request => {
    requests.push(request);
    queueMicrotask(() => {
      if (handler?.(request, {send, readable, requests}) === true) return;
      let result;
      switch (request.op) {
        case 'hello': result = {controlVersion: 1, instanceId: '1'.repeat(32), capabilities: requiredCapabilities.map(id => ({id, available: true, enforcedScope: 'connection', limits: {}})), limits: helloLimits}; break;
        case 'session.open': result = {sessionId: sessionId(request.id)}; break;
        case 'session.authorize': result = {authorizationId: authorizationId(request.id)}; break;
        case 'worker.acquire': result = {workerId: workerId(request.id), endpoint: {kind: 'unix', path: '/tmp/gate/worker.sock'}, attachmentToken: '7'.repeat(64), attachmentTimeoutMs: 5_000, releaseMode: 'control-v1'}; break;
        case 'session.status': result = {phase: 'open', resources: {authoringProcesses: 0, buildProcesses: 0, workers: 0, snapshots: 0}, cleanup: {status: 'notStarted', remainingResources: []}}; break;
        case 'operation.status': result = {operationId: request.args.operationId, status: 'pending'}; break;
        case 'worker.release': result = {operationId: request.id, cleanupMode: 'dispose-then-terminate'}; break;
        default: result = {operationId: request.id};
      }
      send({v: 1, kind: 'response', id: request.id, ok: true, result});
    });
  });
  const writable = new Writable({
    write(chunk, _encoding, done) { try { decoder.push(chunk); done(); } catch (error) { done(error); } },
    final(done) { readable.end(); resolveClosed(); done(); },
  });
  const transport = {
    readable, writable, closed, ownership: 'attached',
    stop() { stopped++; readable.end(); resolveClosed(); return closed; },
  };
  t.after(() => { readable.destroy(); writable.destroy(); resolveClosed(); });
  return {transport, requests, send, readable, stopped: () => stopped};
}

async function openClient(t, handler, options = {}) {
  const fake = fakeControl(t, handler, options.requiredCapabilities);
  const client = await ControlClient.fromTransport(fake.transport, {requestTimeoutMs: 100, helloTimeoutMs: 100, closeTimeoutMs: 200, ...options});
  t.after(() => client.close().catch(() => {}));
  return {client, ...fake};
}

const openArgs = () => ({policyId: 'default', submission: {kind: 'prebuilt', input: {rootId: 'submissions', relativePath: 'counter'}}, runtime: 'node-v1', manifestJson});
const attestation = () => ({
  registrationId: 'registration-1', request: 'verify', policy: 'require', status: 'matched',
  descriptorSchema: 'mirrors.model-interface-descriptor/v1', semanticDigest: manifest.interfaceDigest,
  adapterId: 'counter/node', targetProfile: 'node/v1', stateComputerContractVersion: 'v1',
});

test('control codec accepts frozen transcripts and rejects malformed framing exactly', async () => {
  const vectors = (await readFile(new URL('../../conformance/control-v1/vectors.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const vector of vectors) assert.doesNotThrow(() => parseControlJson(JSON.stringify(vector.value)), vector.name);
  for (const vector of vectors) {
    const validate = () => {
      switch (vector.kind) {
        case 'request': return validateControlRequest(vector.value);
        case 'response': return validateControlResponse(vector.value, {request: vector.request, operation: vector.operation});
        case 'operation': return validateOperationRecord(vector.value, vector.operation);
        case 'event': return validateControlEvent(vector.value, {operation: vector.operation});
        case 'attachment': return validateAttachmentRecord(vector.value);
        case 'attached': return validateAttachmentRecord(vector.value, {success: true});
        default: throw new ControlProtocolError('CONTROL_PROTOCOL_ERROR', 'Unknown shared vector kind');
      }
    };
    if (vector.valid) assert.doesNotThrow(validate, vector.name);
    else assert.throws(validate, ControlProtocolError, vector.name);
  }
  for (const payload of [
    Buffer.from('\ufeff{"v":1}\n'),
    Buffer.from('{"v":1,"v":1}\n'),
    Buffer.from('{"v":1}\r\n'),
    Buffer.from('{"v":9007199254740991.00000000000000001}\n'),
    Buffer.from('{"v":1.5}\n'),
    Buffer.from('\n'),
  ]) {
    const decoder = new ControlFrameDecoder(() => assert.fail('malformed frame dispatched'));
    assert.throws(() => decoder.push(payload), ControlProtocolError);
  }
  const partial = new ControlFrameDecoder(() => assert.fail('unterminated frame dispatched'));
  partial.push('{"v":1}');
  assert.throws(() => partial.end(), ControlProtocolError);
  const oversized = new ControlFrameDecoder(() => assert.fail('oversized frame dispatched'));
  assert.throws(() => oversized.push(Buffer.alloc(1_048_577, 0x20)), {code: 'CONTROL_LIMIT_EXCEEDED'});
});

test('accepted response is registered before a coalesced terminal event and late waiters retain it', async t => {
  let seq = 0;
  const {client, readable} = await openClient(t, request => {
    if (request.op !== 'session.prepare') return false;
    const accepted = {v: 1, kind: 'response', id: request.id, ok: true, result: {operationId: 41}};
    const finished = {v: 1, kind: 'event', seq: ++seq, sessionId: request.args.sessionId, event: 'operation.finished', data: {operationId: 41, status: 'succeeded', result: {preparedRevision: 1, artifactId: '3'.repeat(32), artifactHash: 'a'.repeat(64), manifestHash: 'c'.repeat(64), runtime: 'node-v1', policyId: 'default', challenge: '4'.repeat(32)}}};
    readable.write(Buffer.concat([controlFrame(accepted), controlFrame(finished)]));
    return true;
  });
  const session = await client.openSession(openArgs());
  const operation = await session.prepare();
  const outcome = await operation.wait();
  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.result.artifactHash, 'a'.repeat(64));
  const replay = [];
  session.onEvent(event => replay.push(event));
  assert.deepEqual(replay.map(event => event.event), ['operation.finished']);
});

test('event before its acceptance poisons the connection', async t => {
  const {client, readable} = await openClient(t, request => {
    if (request.op !== 'session.prepare') return false;
    readable.write(controlFrame({v: 1, kind: 'event', seq: 1, sessionId: request.args.sessionId, event: 'operation.finished', data: {operationId: 91, status: 'failed', error: {code: 'BUILD_FAILED', stage: 'build', message: 'failed', operationId: 91}}}));
    return true;
  });
  const session = await client.openSession(openArgs());
  await assert.rejects(session.prepare(), {code: 'CONTROL_PROTOCOL_ERROR'});
  assert.equal(client.terminalError.code, 'CONTROL_PROTOCOL_ERROR');
});

test('duplicate and gapped connection event sequences are rejected', async t => {
  for (const [name, sequences] of [['gap', [2]], ['duplicate', [1, 1]]]) await t.test(name, async t => {
    const {client, send} = await openClient(t);
    const session = await client.openSession(openArgs());
    for (const seq of sequences) {
      send({v: 1, kind: 'event', seq, sessionId: session.id, event: 'session.closed', data: {phase: 'closed', cleanupStatus: 'succeeded', remainingResources: []}});
      await delay(1);
    }
    assert.equal(client.terminalError?.code, 'CONTROL_PROTOCOL_ERROR');
  });
});

test('session-bound authorization and worker handles reject cross-session use without dispatch', async t => {
  const {client, requests} = await openClient(t);
  const first = await client.openSession(openArgs());
  const second = await client.openSession(openArgs());
  const authorization = await first.authorize({preparedRevision: 1, challenge: '4'.repeat(32), attestation: attestation()});
  const before = requests.length;
  await assert.rejects(second.acquireWorker(authorization), {code: 'HANDLE_INVALID'});
  assert.equal(requests.length, before);
  const worker = await first.acquireWorker(authorization);
  await assert.rejects(second.releaseWorker(worker), {code: 'HANDLE_INVALID'});
});

test('request acknowledgement deadline closes once and never retries a mutation', async t => {
  const {client, requests, stopped} = await openClient(t, request => request.op === 'session.open');
  await assert.rejects(client.openSession(openArgs(), {timeoutMs: 15}), {code: 'CONTROL_REQUEST_TIMEOUT'});
  await delay(5);
  assert.deepEqual(requests.map(request => request.op), ['hello', 'session.open']);
  assert.equal(stopped(), 1);
});

test('in-flight request bound rejects excess work without writing it', async t => {
  const {client, requests} = await openClient(t, request => request.op === 'session.open');
  const pending = Array.from({length: 16}, () => client.openSession(openArgs(), {timeoutMs: 1_000}).catch(() => {}));
  await delay(5);
  await assert.rejects(client.openSession(openArgs()), {code: 'CONTROL_LIMIT_EXCEEDED'});
  assert.equal(requests.filter(request => request.op === 'session.open').length, 16);
  await client.close();
  await Promise.all(pending);
});

test('operation status preserves a terminal failure for a late waiter', async t => {
  const {client, send} = await openClient(t, request => {
    if (request.op === 'session.prepare') { send({v: 1, kind: 'response', id: request.id, ok: true, result: {operationId: 7}}); return true; }
    if (request.op === 'operation.status') { send({v: 1, kind: 'response', id: request.id, ok: true, result: {operationId: 7, status: 'failed', error: {code: 'BUILD_FAILED', stage: 'build', message: 'compiler failed', operationId: 7}}}); return true; }
    return false;
  });
  const session = await client.openSession(openArgs());
  const operation = await session.prepare();
  const outcome = await operation.wait();
  assert.equal(outcome.status, 'failed');
  assert.equal((await operation.status()).error.message, 'compiler failed');
});

test('concurrent session close and cancel join one cleanup mutation', async t => {
  const {client, requests} = await openClient(t);
  const session = await client.openSession(openArgs());
  const [first, second] = await Promise.all([session.close({status: 'cancelled'}), session.cancel('user-cancel')]);
  assert.equal(first.id, second.id);
  assert.equal(requests.filter(request => request.op === 'session.close' || request.op === 'session.cancel').length, 1);
});

test('client validates exact manifest before dispatching session.open', async t => {
  const {client, requests} = await openClient(t);
  await assert.rejects(client.openSession({...openArgs(), manifestJson: '{}'}), {code: 'CONTROL_ARGUMENT_INVALID'});
  assert.deepEqual(requests.map(request => request.op), ['hello']);
});
