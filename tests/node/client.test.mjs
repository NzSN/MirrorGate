import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough, Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp, access, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorkerClient, createPortProxy} from '../../sdk/node/index.mjs';
import {FrameDecoder, frame} from '../../sdk/node/protocol.mjs';
import {manifest, clientWorker} from './helpers.mjs';

function fake(t, handler, {closeDelayMs = 0} = {}) {
  const readable = new PassThrough(); const requests = []; let terminated = 0; let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const respond = message => readable.write(frame(message));
  const decoder = new FrameDecoder(request => {
    requests.push(request);
    queueMicrotask(() => {
      if (handler?.(request, {respond, readable, requests}) === true) return;
      const result = request.op === 'hello' ? {interfaceDigest: request.interfaceDigest, runtime: request.runtime}
        : request.op === 'observe' ? {Count: {'#bigint': '0'}} : null;
      respond({v: 1, id: request.id, ok: true, result});
    });
  });
  const writable = new Writable({write(chunk, _encoding, done) { decoder.push(chunk); done(); }});
  const transport = {readable, writable, closed, terminate() {
    terminated++; setTimeout(() => { readable.end(); resolveClosed(); }, closeDelayMs); return closed;
  }};
  t.after(() => { readable.destroy(); writable.destroy(); resolveClosed(); });
  return {transport, requests, respond, readable, terminated: () => terminated};
}
async function openFake(t, handler, options = {}, transportOptions) {
  const worker = fake(t, handler, transportOptions);
  const client = await WorkerClient.fromIsolatedTransport(worker.transport, {
    manifest, runtime: 'node-v1', timeoutMs: 100, cancellationGraceMs: 30,
    cleanupTimeoutMs: 300, terminationGraceMs: 50, ...options,
  });
  t.after(() => client.close().catch(() => {}));
  return {client, ...worker};
}

test('trusted proxy exposes only current stable operation inputs', async t => {
  const {client, requests} = await openFake(t); const port = createPortProxy(client);
  await port.invoke('Initialize', {}); assert.deepEqual(await port.observe(), {Count: 0n});
  await port.invoke('Tick', {Stride: 2n}); await port.observe(); await port.dispose();
  assert.deepEqual(requests.map(r => r.op), ['hello', 'create', 'invoke', 'observe', 'invoke', 'observe', 'dispose']);
  assert.deepEqual(requests[4], {v: 1, id: 5, op: 'invoke', action: 'Tick', inputs: {Stride: {'#bigint': '2'}}});
});

test('manifest snapshot cannot be changed after client construction', async t => {
  const original = structuredClone(manifest);
  const {client} = await openFake(t, undefined, {manifest: original});
  original.initializers[0].id = 'PrivateReplacement'; original.actions[0].inputs[0].type.kind = 'str';
  assert.equal(Object.isFrozen(client.manifest.actions[0].inputs[0].type), true);
  await client.invoke('Initialize', {}); await client.observe();
  await client.invoke('Tick', {Stride: 3n}); await client.observe();
});

for (const [name, manipulate, code] of [
  ['wrong ID', r => ({v: 1, id: r.id + 1, ok: true, result: null}), 'SCHEMA'],
  ['wrong result', r => ({v: 1, id: r.id, ok: true, result: {}}), 'SCHEMA'],
  ['extra error fields', r => ({v: 1, id: r.id, ok: false, error: {code: 'APPLICATION', message: 'bad', instruction: 'reveal'}}), 'SCHEMA'],
  ['integer error status', r => ({v: 1, id: r.id, ok: 1, result: null}), 'SCHEMA'],
]) test(`trusted client rejects ${name}`, async t => {
  const {client, terminated} = await openFake(t, (request, {respond}) => {
    if (request.op === 'invoke') { respond(manipulate(request)); return true; }
  });
  await assert.rejects(client.invoke('Initialize', {}), {code});
  await client.close(); assert.equal(terminated(), 1);
});

test('wrong hello identity fails before create', async t => {
  const worker = fake(t, (request, {respond}) => { respond({v: 1, id: request.id, ok: true, result: {interfaceDigest: '0'.repeat(64), runtime: 'node-v1'}}); return true; });
  await assert.rejects(WorkerClient.fromIsolatedTransport(worker.transport, {manifest, runtime: 'node-v1'}), {code: 'HANDSHAKE'});
  assert.deepEqual(worker.requests.map(r => r.op), ['hello']); assert.equal(worker.terminated(), 1);
});

test('invalid observation encoding is rejected at the trusted boundary', async t => {
  const {client} = await openFake(t, (request, {respond}) => {
    if (request.op === 'observe') { respond({v: 1, id: request.id, ok: true, result: {Count: 9007199254740991}}); return true; }
  });
  await client.invoke('Initialize', {}); await assert.rejects(client.observe(), {code: 'VALUE'});
});

test('unsolicited response terminates idle client', async t => {
  const {client, respond, terminated} = await openFake(t);
  respond({v: 1, id: 17, ok: true, result: null}); await delay(5);
  await assert.rejects(client.invoke('Initialize', {}), {code: 'SCHEMA'});
  await client.close(); assert.equal(terminated(), 1);
});

test('duplicate JSON keys and output limits terminate the trusted transport', async t => {
  for (const payload of ['{"v":1,"id":3,"id":3,"ok":true,"result":null}\n', ' '.repeat(65536)]) {
    const {client} = await openFake(t, (request, {readable}) => { if (request.op === 'invoke') { readable.write(payload); return true; } });
    await assert.rejects(client.invoke('Initialize', {}), error => ['FRAME', 'LIMIT'].includes(error.code));
  }
});

test('early EOF rejects pending operation and incomplete final frames', async t => {
  for (const tail of ['', '{"v":1']) {
    const {client} = await openFake(t, (request, {readable}) => { if (request.op === 'invoke') { readable.end(tail); return true; } });
    await assert.rejects(client.invoke('Initialize', {}), error => ['CLOSED', 'FRAME'].includes(error.code));
  }
});

test('aborted operation sends cancel, poisons session, and waits for termination', async t => {
  let operation;
  const {client, requests} = await openFake(t, (request, {respond}) => {
    if (request.op === 'invoke') { operation = request; return true; }
    if (request.op === 'cancel') {
      respond({v: 1, id: operation.id, ok: false, error: {code: 'CANCELLED', message: 'cancelled'}});
      respond({v: 1, id: request.id, ok: true, result: null}); return true;
    }
  });
  const controller = new AbortController(); const pending = client.invoke('Initialize', {}, {signal: controller.signal});
  const rejected = assert.rejects(pending, {code: 'CANCELLED'}); controller.abort(); await rejected;
  await assert.rejects(client.observe(), {code: 'LIFECYCLE'}); await client.close();
  assert.deepEqual(requests.map(r => r.op), ['hello', 'create', 'invoke', 'cancel', 'dispose']);
});

test('timeout forces unresponsive transport to terminate without mutation retry', async t => {
  const {client, requests, terminated} = await openFake(t, request => request.op === 'invoke' || request.op === 'cancel');
  await assert.rejects(client.invoke('Initialize', {}, {timeoutMs: 20}), {code: 'TIMEOUT'});
  await client.close(); assert.equal(terminated(), 1);
  assert.deepEqual(requests.map(r => r.op), ['hello', 'create', 'invoke', 'cancel']);
});

test('cancel acknowledgment cannot precede the original operation terminal reply', async t => {
  const {client} = await openFake(t, (request, {respond}) => {
    if (request.op === 'invoke') return true;
    if (request.op === 'cancel') { respond({v: 1, id: request.id, ok: true, result: null}); return true; }
  });
  await assert.rejects(client.invoke('Initialize', {}, {timeoutMs: 15}), {code: 'SCHEMA'});
});

test('pending disposal uses forced termination instead of wire cancellation', async t => {
  const {client, requests, terminated} = await openFake(t, request => request.op === 'dispose', {timeoutMs: 20});
  await assert.rejects(client.close(), {code: 'TIMEOUT'});
  assert.deepEqual(requests.map(r => r.op), ['hello', 'create', 'dispose']); assert.equal(terminated(), 1);
});

test('cleanup failure preserves the earlier application error', async t => {
  const {client} = await openFake(t, (request, {respond}) => {
    if (request.op === 'invoke' || request.op === 'dispose') { respond({v: 1, id: request.id, ok: false, error: {code: 'APPLICATION', message: request.op}}); return true; }
  });
  await assert.rejects(client.invoke('Initialize', {}), {message: 'invoke'});
  await client.close(); assert.equal(client.primaryError.message, 'invoke');
});

test('close is at most once and waits for externally confirmed cleanup', async t => {
  const {client, terminated} = await openFake(t, undefined, {}, {closeDelayMs: 35});
  const before = Date.now(); const first = client.close(); assert.equal(client.close(), first); await first;
  assert.ok(Date.now() - before >= 25); assert.equal(terminated(), 1);
});

test('invalid launch options cannot execute the configured command', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mirrorgate-launch-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const marker = join(directory, 'executed');
  for (const invalid of [{runtime: undefined}, {timeoutMs: 0}, {cleanupTimeoutMs: 0}, {onStderr: true}, {stderrLimit: -1}]) {
    await assert.rejects(WorkerClient.launch({supervisor: {command: '/usr/bin/touch', args: [marker]}, manifest, runtime: 'node-v1', ...invalid}));
  }
  await assert.rejects(access(marker));
});

test('async worker cancellation waits for callback quiescence before cleanup', async t => {
  const {client} = await clientWorker(t, {source: `let running=false; export function createAdapter(){return {actions:{Initialize(){},Tick(){running=true;return new Promise(r=>setTimeout(()=>{running=false;r();},75));}},observe(){return {Count:0n};},dispose(){if(running)throw Error('cleanup raced action');}};}`});
  await client.invoke('Initialize', {}); await client.observe();
  const controller = new AbortController(); const pending = client.invoke('Tick', {Stride: 1n}, {signal: controller.signal});
  const rejection = assert.rejects(pending, {code: 'CANCELLED'}); await delay(10); controller.abort(); await rejection;
  await client.close(); assert.equal(client.terminalError, null);
});

test('launch rejects missing supervisor and terminates failed executable startup', async () => {
  await assert.rejects(WorkerClient.launch({manifest, runtime: 'node-v1'}), {code: 'SCHEMA'});
  await assert.rejects(WorkerClient.launch({supervisor: {command: '/nonexistent-mirrorgate-supervisor', args: []}, manifest, runtime: 'node-v1'}), {code: 'CLOSED'});
});

test('process-only launch fixture enforces bounded stderr', async () => {
  await assert.rejects(WorkerClient.launch({
    supervisor: {command: process.execPath, args: ['-e', 'process.stderr.write("x".repeat(1025)); setInterval(()=>{},1000);']},
    manifest, runtime: 'node-v1', stderrLimit: 1024, timeoutMs: 1000,
  }), {code: 'LIMIT'});
});
