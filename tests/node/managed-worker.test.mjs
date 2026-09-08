import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {chmod, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {createManagedWorker, __testing as managedTesting} from '../../sdk/node/managed-worker.mjs';
import {ControlFrameDecoder, __testing as controlTesting, controlFrame} from '../../sdk/node/control.mjs';
import {FrameDecoder, frame} from '../../sdk/node/protocol.mjs';
import {manifest} from './helpers.mjs';

async function endpoint(t, workerHandler, {attachment = 'fragmented', ackDelayMs = 0} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mirrorgate-managed-'));
  const directory = join(root, 'private');
  await mkdir(directory, {mode: 0o700});
  await chmod(directory, 0o700);
  const path = join(directory, 'worker.sock');
  const connections = [];
  const server = net.createServer(socket => {
    connections.push(socket);
    socket.on('error', () => {});
    let attached = false;
    let buffered = Buffer.alloc(0);
    const workerDecoder = new FrameDecoder(request => workerHandler(request, socket));
    socket.on('data', chunk => {
      if (attached) { workerDecoder.push(chunk); return; }
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(10);
      if (newline < 0) return;
      let request;
      const decoder = new ControlFrameDecoder(value => { request = value; }, {maxBytes: 4_096});
      decoder.push(buffered.subarray(0, newline + 1)); decoder.end();
      const rest = buffered.subarray(newline + 1);
      attached = true;
      const ack = controlFrame({v: 1, kind: 'attached', sessionId: request.sessionId, workerId: request.workerId}, 4_096);
      if (attachment === 'eof') socket.end();
      else if (attachment === 'malformed') socket.write('{"v":1,"kind":"attached"}\n');
      else if (attachment === 'coalesced-tail') {
        const earlyHello = frame({v: 1, id: 1, ok: true, result: {interfaceDigest: manifest.interfaceDigest, runtime: 'node-v1'}});
        socket.write(Buffer.concat([ack, Buffer.from(earlyHello)]));
      } else {
        const writeAck = () => { socket.write(ack.subarray(0, 7)); queueMicrotask(() => socket.write(ack.subarray(7))); };
        if (ackDelayMs) setTimeout(writeAck, ackDelayMs);
        else writeAck();
      }
      if (rest.length) workerDecoder.push(rest);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(root, {recursive: true, force: true});
  });
  return {path, connections};
}

function reservation(path, {cleanupMode = 'dispose-then-terminate', cleanupFailure = false, order = []} = {}) {
  let operationId = 100;
  const terminal = () => ({
    cleanupMode,
    id: ++operationId,
    async wait() {
      order.push('cleanup-finished');
      if (cleanupFailure) throw new Error('secondary cleanup failure');
      return {operationId: this.id, status: 'succeeded', result: {phase: 'closed', cleanupStatus: 'succeeded', remainingResources: []}};
    },
  });
  let releasePromise;
  const session = {
    id: '2'.repeat(32),
    async cancel(reason) { order.push(`session.cancel:${reason}`); return terminal(); },
    releaseWorker(_reservation, reason) {
      releasePromise ??= Promise.resolve().then(() => { order.push(`worker.release:${reason}`); return terminal(); });
      return releasePromise;
    },
  };
  return controlTesting.makeWorkerReservation(session, {
    workerId: '6'.repeat(32),
    endpoint: {kind: 'unix', path},
    attachmentToken: '7'.repeat(64),
    attachmentTimeoutMs: 500,
    releaseMode: 'control-v1',
  });
}

function normalWorker(order = []) {
  return (request, socket) => {
    order.push(`worker.${request.op}`);
    const result = request.op === 'hello' ? {interfaceDigest: request.interfaceDigest, runtime: request.runtime}
      : request.op === 'observe' ? {Count: {'#bigint': '0'}} : null;
    socket.write(frame({v: 1, id: request.id, ok: true, result}));
  };
}

test('managed factory rejects a reservation-shaped object without the ControlSession brand', async () => {
  await assert.rejects(createManagedWorker({
    reservation: {session: {id: '2'.repeat(32)}, id: '6'.repeat(32), endpoint: {kind: 'unix', path: '/tmp/forged.sock'}, attachmentToken: '7'.repeat(64), attachmentTimeoutMs: 100, releaseMode: 'control-v1'},
    manifest, runtime: 'node-v1',
  }), {code: 'HANDLE_INVALID'});
});

test('fragmented attachment precedes frozen hello/create and managed close delegates release before one dispose', async t => {
  const order = [];
  const {path} = await endpoint(t, normalWorker(order));
  const client = await createManagedWorker({reservation: reservation(path, {order}), manifest, runtime: 'node-v1', timeoutMs: 250, cleanupTimeoutMs: 500});
  await client.invoke('Initialize', {});
  await client.observe();
  await client.close();
  assert.deepEqual(order, [
    'worker.hello', 'worker.create', 'worker.invoke', 'worker.observe',
    'worker.release:normal', 'worker.dispose', 'cleanup-finished',
  ]);
});

test('attachment ACK coalesced with worker bytes preserves the unread tail', async t => {
  const order = [];
  const handler = (request, socket) => {
    order.push(`worker.${request.op}`);
    if (request.op === 'hello') return; // Its response was coalesced after the attachment ACK.
    socket.write(frame({v: 1, id: request.id, ok: true, result: null}));
  };
  const {path} = await endpoint(t, handler, {attachment: 'coalesced-tail'});
  const client = await createManagedWorker({reservation: reservation(path, {order}), manifest, runtime: 'node-v1', timeoutMs: 250, cleanupTimeoutMs: 500});
  assert.deepEqual(order.slice(0, 2), ['worker.hello', 'worker.create']);
  await client.close();
  assert.ok(order.includes('worker.dispose'));
});

test('pending cancellation asks Gate immediately and terminate-only cleanup never races dispose', async t => {
  const order = [];
  let invoke;
  const handler = (request, socket) => {
    order.push(`worker.${request.op}`);
    if (request.op === 'hello') socket.write(frame({v: 1, id: request.id, ok: true, result: {interfaceDigest: request.interfaceDigest, runtime: request.runtime}}));
    else if (request.op === 'create') socket.write(frame({v: 1, id: request.id, ok: true, result: null}));
    else if (request.op === 'invoke') invoke = request;
    else if (request.op === 'cancel') {
      socket.write(frame({v: 1, id: invoke.id, ok: false, error: {code: 'CANCELLED', message: 'cancelled'}}));
      socket.write(frame({v: 1, id: request.id, ok: true, result: null}));
    } else assert.notEqual(request.op, 'dispose');
  };
  const {path} = await endpoint(t, handler);
  const client = await createManagedWorker({reservation: reservation(path, {order, cleanupMode: 'terminate-only'}), manifest, runtime: 'node-v1', timeoutMs: 250, cleanupTimeoutMs: 500});
  const controller = new AbortController();
  const pending = client.invoke('Initialize', {}, {signal: controller.signal});
  controller.abort();
  await assert.rejects(pending, {code: 'CANCELLED'});
  await client.close();
  assert.ok(order.indexOf('session.cancel:user-cancel') >= 0);
  assert.ok(order.indexOf('session.cancel:user-cancel') < order.indexOf('worker.release:user-cancel'));
  assert.equal(order.includes('worker.dispose'), false);
});

test('malformed attachment and handshake failures release the reserved worker while preserving primary error', async t => {
  for (const mode of ['malformed', 'wrong-hello']) {
    const order = [];
    const handler = (request, socket) => {
      if (request.op === 'hello') socket.write(frame({v: 1, id: request.id, ok: true, result: {interfaceDigest: '0'.repeat(64), runtime: 'node-v1'}}));
    };
    const {path} = await endpoint(t, handler, {attachment: mode === 'malformed' ? 'malformed' : 'fragmented'});
    await assert.rejects(createManagedWorker({reservation: reservation(path, {order, cleanupFailure: true}), manifest, runtime: 'node-v1', timeoutMs: 100, cleanupTimeoutMs: 100}), error => {
      assert.notEqual(error.message, 'secondary cleanup failure');
      return true;
    });
    assert.equal(order.filter(item => item.startsWith('worker.release:')).length, 1);
  }
});

test('partial attachment EOF is bounded and releases the handle', async t => {
  const order = [];
  const {path} = await endpoint(t, () => {}, {attachment: 'eof'});
  await assert.rejects(createManagedWorker({reservation: reservation(path, {order}), manifest, runtime: 'node-v1', timeoutMs: 100, cleanupTimeoutMs: 100}));
  assert.ok(order.includes('worker.release:client-failure'));
  await delay(1);
});

test('connection and attachment ACK consume one cumulative descriptor deadline', async t => {
  const {path} = await endpoint(t, normalWorker(), {ackDelayMs: 60});
  const owned = reservation(path);
  const deadline = performance.now() + 90;
  const socket = await managedTesting.connectPrivateSocket(path, deadline);
  await delay(55);
  await assert.rejects(managedTesting.attach(socket, owned, deadline), {code: 'ATTACHMENT_TIMEOUT'});
  socket.destroy();
});
