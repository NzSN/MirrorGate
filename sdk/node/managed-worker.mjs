import net from 'node:net';
import {performance} from 'node:perf_hooks';
import {ControlError, ControlFrameDecoder, ControlProtocolError, WorkerReservation, __testing as controlTesting, controlFrame, validateAttachmentRecord} from './control.mjs';
import {WorkerClient} from './index.mjs';

const failure = (code, message, options) => new ControlProtocolError(code, message, options);
const remaining = deadline => {
  const milliseconds = Math.ceil(deadline - performance.now());
  if (milliseconds < 1) throw failure('ATTACHMENT_TIMEOUT', 'Worker attachment deadline exceeded');
  return milliseconds;
};
async function beforeDeadline(promise, deadline, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure('ATTACHMENT_TIMEOUT', message)), remaining(deadline)); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function connectPrivateSocket(path, deadline) {
  const before = await beforeDeadline(controlTesting.verifyUnixSocketPath(path), deadline, 'Worker endpoint verification deadline exceeded');
  const socket = net.createConnection({path});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure('ATTACHMENT_TIMEOUT', 'Worker endpoint connection deadline exceeded')), remaining(deadline));
    const connected = () => { clearTimeout(timer); socket.off('error', failed); resolve(); };
    const failed = error => { clearTimeout(timer); socket.off('connect', connected); reject(failure('ATTACHMENT_FAILED', error.message, {cause: error})); };
    socket.once('connect', connected);
    socket.once('error', failed);
  }).catch(error => { socket.destroy(); throw error; });
  const after = await beforeDeadline(controlTesting.verifyUnixSocketPath(path), deadline, 'Worker endpoint verification deadline exceeded').catch(error => { socket.destroy(); throw error; });
  if (before.device !== after.device || before.inode !== after.inode) {
    socket.destroy();
    throw failure('CONTROL_OWNERSHIP_FAILED', 'Worker endpoint identity changed during connection');
  }
  return socket;
}

function validateAttachmentReply(value, reservation) {
  validateAttachmentRecord(value, {success: true});
  if (value.sessionId !== reservation.session.id || value.workerId !== reservation.id) {
    throw failure('ATTACHMENT_FAILED', 'Invalid or incorrectly correlated worker attachment acknowledgement');
  }
}

async function attach(socket, reservation, deadline) {
  const request = {v: 1, kind: 'attach', sessionId: reservation.session.id, workerId: reservation.id, attachmentToken: reservation.attachmentToken};
  validateAttachmentRecord(request);
  const encoded = controlFrame(request, 4_096);
  let buffered = Buffer.alloc(0);
  const acknowledged = new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', received);
      socket.off('end', ended);
      socket.off('error', failed);
    };
    const failed = error => { cleanup(); reject(error instanceof ControlProtocolError ? error : failure('ATTACHMENT_FAILED', error.message, {cause: error})); };
    const ended = () => failed(failure('ATTACHMENT_FAILED', 'Worker endpoint reached EOF before attachment acknowledgement'));
    const received = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(10);
      if (newline < 0) {
        if (buffered.length > 4_096) failed(failure('ATTACHMENT_FAILED', 'Worker attachment frame exceeds 4096 bytes'));
        return;
      }
      if (newline > 4_096) { failed(failure('ATTACHMENT_FAILED', 'Worker attachment frame exceeds 4096 bytes')); return; }
      socket.pause();
      const prefix = buffered.subarray(0, newline + 1);
      const unread = buffered.subarray(newline + 1);
      try {
        let reply;
        const decoder = new ControlFrameDecoder(value => { if (reply !== undefined) throw failure('ATTACHMENT_FAILED', 'Duplicate worker attachment acknowledgement'); reply = value; }, {maxBytes: 4_096});
        decoder.push(prefix);
        decoder.end();
        validateAttachmentReply(reply, reservation);
        cleanup();
        if (unread.length) socket.unshift(unread);
        resolve();
      } catch (error) { failed(error); }
    };
    timer = setTimeout(() => failed(failure('ATTACHMENT_TIMEOUT', 'Worker attachment acknowledgement deadline exceeded')), remaining(deadline));
    socket.on('data', received);
    socket.once('end', ended);
    socket.once('error', failed);
  });
  try {
    socket.write(encoded);
    await acknowledged;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function terminalFailure(outcome) {
  if (outcome.status === 'failed') return new ControlError(outcome.error);
  if (outcome.status !== 'succeeded') return failure('CLEANUP_FAILED', 'Gate cleanup operation did not reach a terminal outcome');
  return null;
}

function managedTransport(socket, reservation, cleanupTimeoutMs) {
  const closed = new Promise(resolve => socket.once('close', resolve));
  let releasePromise;
  let cancelPromise;
  let finishPromise;
  const beginRelease = reason => {
    releasePromise ??= reservation.release(reason);
    return releasePromise;
  };
  const finishRelease = operation => {
    finishPromise ??= (async () => {
      try {
        const outcome = await operation.wait({timeoutMs: cleanupTimeoutMs});
        const error = terminalFailure(outcome);
        if (error) throw error;
        return outcome;
      } finally {
        socket.destroy();
        await closed;
      }
    })();
    return finishPromise;
  };
  const stop = async reason => finishRelease(await beginRelease(reason));
  return {
    readable: socket,
    writable: socket,
    closed,
    managed: true,
    beginRelease,
    finishRelease,
    terminate: stop,
    requestCancellation(reason) {
      cancelPromise ??= reservation.session.cancel(reason).then(operation => operation.wait({timeoutMs: cleanupTimeoutMs}));
      // The worker-v1 cooperative cancel continues independently; Gate owns the deadline.
      cancelPromise.catch(() => {});
      return cancelPromise;
    },
    onClose: callback => socket.once('error', callback),
  };
}

async function cleanupPartial(reservation, socket, cleanupTimeoutMs) {
  let cleanupError;
  try {
    const operation = await reservation.release('client-failure');
    const outcome = await operation.wait({timeoutMs: cleanupTimeoutMs});
    cleanupError = terminalFailure(outcome);
  } catch (error) { cleanupError = error; }
  socket?.destroy();
  return cleanupError;
}

/**
 * Consume a one-use Gate attachment and return the existing strict worker-v1
 * client in managed lifecycle mode. Gate remains the only process supervisor.
 */
export async function createManagedWorker({reservation, manifest, runtime, cleanupTimeoutMs = 5_000, ...options}) {
  if (!(reservation instanceof WorkerReservation) || !reservation.session || typeof reservation.id !== 'string' || reservation.releaseMode !== 'control-v1') throw failure('HANDLE_INVALID', 'An owner-bound control-v1 worker reservation is required');
  if (reservation.attached) throw failure('HANDLE_INVALID', 'Worker reservation attachment was already consumed');
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1) throw failure('CONTROL_ARGUMENT_INVALID', 'Invalid managed cleanup timeout');
  reservation.attached = true;
  const attachmentDeadline = performance.now() + reservation.attachmentTimeoutMs;
  let socket;
  let transport;
  try {
    socket = await connectPrivateSocket(reservation.endpoint.path, attachmentDeadline);
    await attach(socket, reservation, attachmentDeadline);
    transport = managedTransport(socket, reservation, cleanupTimeoutMs);
    const client = await WorkerClient.fromManagedTransport(transport, {manifest, runtime, cleanupTimeoutMs, ...options});
    socket.resume();
    return client;
  } catch (error) {
    if (transport) await transport.terminate('client-failure').catch(() => {});
    else await cleanupPartial(reservation, socket, cleanupTimeoutMs);
    throw error;
  }
}

export const __testing = Object.freeze({attach, connectPrivateSocket, managedTransport, validateAttachmentReply, remaining});
