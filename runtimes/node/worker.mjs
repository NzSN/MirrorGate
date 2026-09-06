#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {Console} from 'node:console';
import {
  LIMITS, ProtocolError, FrameDecoder, frame, parseJson, validateManifest,
  validateRequest, decodeFields, encodeFields, object,
} from '../../sdk/node/protocol.mjs';

// Application console logs must not become protocol messages.
globalThis.console = new Console({stdout: process.stderr, stderr: process.stderr});
const rawWrite = process.stdout.write.bind(process.stdout);
let manifest; let adapterPath;
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--adapter') throw new Error('Usage: worker.mjs --manifest FILE --adapter FILE');
  const bytes = await readFile(args[1]);
  if (bytes.length > LIMITS.manifestBytes) throw new Error('Manifest byte limit exceeded');
  manifest = validateManifest(parseJson(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes), LIMITS.manifestBytes));
  adapterPath = resolve(args[3]);
} catch (error) {
  process.stderr.write(`MirrorGate admission failed: ${error.message}\n`); process.exit(2);
}

let state = 'awaitHello'; let lastId = 0; let pending = null; let abandoned = null;
let adapter = null; let disposalPromise = null; let terminating = false;
const operations = new Map([...manifest.initializers, ...manifest.actions].map(op => [op.id, op]));
const initializers = new Set(manifest.initializers.map(op => op.id));
function errorMessage(error) {
  let message = typeof error?.message === 'string' ? error.message : 'Adapter operation failed';
  // Truncate by Unicode scalar rather than splitting an encoded character.
  message = message.toWellFormed();
  while (Buffer.byteLength(message) > 1024) message = message.slice(0, -1).toWellFormed();
  return message;
}
function reply(id, result) { rawWrite(frame({v: 1, id, ok: true, result})); }
function failure(id, error) { rawWrite(frame({v: 1, id, ok: false, error: {code: error instanceof ProtocolError ? error.code : 'APPLICATION', message: errorMessage(error)}})); }
function disposeAdapter() {
  if (disposalPromise) return disposalPromise;
  if (!adapter) return Promise.resolve();
  disposalPromise = Promise.resolve().then(() => {
    if (typeof adapter.dispose === 'function') return adapter.dispose();
  });
  return disposalPromise;
}
function finish(exitCode) {
  if (terminating) return;
  terminating = true; process.stdin.pause();
  const timer = setTimeout(() => process.exit(exitCode), 100);
  Promise.resolve(abandoned?.done ?? pending?.done).catch(() => {}).then(disposeAdapter).catch(() => {}).finally(() => {
    clearTimeout(timer); rawWrite('', () => process.exit(exitCode));
  });
}
function fatal(error) {
  if (terminating) return;
  state = 'poisoned'; pending?.controller.abort();
  process.stderr.write(`MirrorGate channel closed: ${error instanceof ProtocolError ? error.code : 'APPLICATION'}\n`);
  finish(1);
}
function lifecycle(message) { throw new ProtocolError('LIFECYCLE', message); }
function validateAdapter(value) {
  if (!object(value) || !object(value.actions) || typeof value.observe !== 'function' || (value.dispose !== undefined && typeof value.dispose !== 'function')) throw new ProtocolError('APPLICATION', 'Adapter must provide actions, observe, and optional dispose');
  const expected = [...operations.keys()];
  if (Object.keys(value.actions).length !== expected.length || expected.some(key => typeof value.actions[key] !== 'function' || !Object.hasOwn(value.actions, key))) throw new ProtocolError('APPLICATION', 'Adapter actions must exactly match public stable IDs');
}
async function execute(request, token) {
  const context = Object.freeze({signal: token.controller.signal});
  switch (request.op) {
    case 'hello':
      if (state !== 'awaitHello') lifecycle('Handshake already completed');
      if (request.interfaceDigest !== manifest.interfaceDigest || request.runtime !== 'node-v1') throw new ProtocolError('HANDSHAKE', 'Public interface or runtime does not match');
      state = 'awaitCreate'; return {interfaceDigest: manifest.interfaceDigest, runtime: 'node-v1'};
    case 'create': {
      if (state !== 'awaitCreate') lifecycle('Create requires successful handshake');
      const loaded = await import(pathToFileURL(adapterPath).href);
      if (typeof loaded.createAdapter !== 'function') throw new ProtocolError('APPLICATION', 'Adapter module must export createAdapter');
      if (token.cancelled) return null;
      adapter = await loaded.createAdapter();
      if (token.cancelled) { await disposeAdapter(); return null; }
      validateAdapter(adapter); state = 'needInitializer'; return null;
    }
    case 'invoke': {
      if (state !== 'needInitializer' && state !== 'readyAction') lifecycle('Operation requires initialization or preceding observation');
      const operation = operations.get(request.action);
      if (!operation) throw new ProtocolError('VALUE', 'Unknown public action ID');
      if (state === 'needInitializer' && !initializers.has(operation.id)) lifecycle('Initialization is required');
      const inputs = decodeFields(operation.inputs, request.inputs);
      const result = await adapter.actions[operation.id](inputs, context);
      if (token.cancelled) return null;
      if (result !== undefined) throw new ProtocolError('APPLICATION', 'Adapter actions must return undefined');
      state = 'needObserve'; return null;
    }
    case 'observe':
      if (state !== 'needObserve') lifecycle('Observation requires completed initialization or action');
      { const native = await adapter.observe(context); if (token.cancelled) return null;
        const observation = encodeFields(manifest.observations, native);
        state = 'readyAction'; return observation; }
    case 'dispose':
      if (state === 'disposed' || state === 'awaitHello') lifecycle('Dispose requires a handshake attempt and must occur once');
      state = 'disposed';
      // A cancellation acknowledgment does not establish callback quiescence.
      await abandoned?.done; await disposeAdapter(); return null;
    case 'cancel': lifecycle('No operation is pending'); break;
    default: throw new ProtocolError('SCHEMA', 'Unsupported operation');
  }
}
function receive(raw) {
  if (terminating) return;
  let request;
  try {
    request = validateRequest(raw);
    if (request.id <= lastId) throw new ProtocolError('SCHEMA', 'Request IDs must increase');
    lastId = request.id;
    if (pending) {
      if (request.op !== 'cancel' || request.requestId !== pending.request.id || pending.request.op === 'dispose') throw new ProtocolError('SCHEMA', 'Pipelining or invalid cancellation target');
      const cancelled = pending; pending = null; abandoned = cancelled; cancelled.cancelled = true;
      state = 'poisoned'; cancelled.controller.abort();
      failure(cancelled.request.id, new ProtocolError('CANCELLED', 'Operation cancelled'));
      reply(request.id, null); return;
    }
  } catch (error) { fatal(error); return; }
  const token = {request, controller: new AbortController(), cancelled: false}; pending = token;
  token.done = Promise.resolve().then(() => {
    if (state === 'poisoned' && request.op !== 'dispose') lifecycle('Worker is poisoned; only disposal is permitted');
    return execute(request, token);
  }).then(result => {
    if (token.cancelled || terminating) return;
    pending = null;
    try { reply(request.id, result); } catch (error) { state = 'poisoned'; failure(request.id, error); }
    if (request.op === 'dispose') finish(0);
  }, async error => {
    if (token.cancelled || terminating) return;
    pending = null; state = request.op === 'dispose' ? 'disposed' : 'poisoned';
    // A partially created adapter may already own resources. Preserve the first error.
    if (request.op === 'create') { try { await disposeAdapter(); } catch {} }
    if (!terminating) { try { failure(request.id, error); } catch (writeError) { fatal(writeError); } }
    if (request.op === 'dispose') finish(1);
  }).finally(() => { if (abandoned === token) abandoned = null; });
}
const decoder = new FrameDecoder(receive);
process.stdin.on('data', chunk => { try { decoder.push(chunk); } catch (error) { fatal(error); } });
process.stdin.on('end', () => { try { decoder.end(); finish(0); } catch (error) { fatal(error); } });
process.stdin.on('error', fatal); process.stdout.on('error', () => finish(1));
process.on('SIGTERM', () => { pending?.controller.abort(); finish(143); });
