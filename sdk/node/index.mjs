import {spawn} from 'node:child_process';
import {
  LIMITS, ProtocolError, FrameDecoder, frame, parseJson, validateManifest, validateResponse,
  exact, encodeFields, decodeFields,
} from './protocol.mjs';
export {ProtocolError} from './protocol.mjs';

const fail = (code, message) => new ProtocolError(code, message);
const duration = (label, value) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw fail('SCHEMA', `Invalid ${label}`);
  return value;
};
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function prepare(options = {}) {
  const manifest = freeze(validateManifest(parseJson(JSON.stringify(options.manifest), LIMITS.manifestBytes)));
  const runtime = options.runtime;
  if (typeof runtime !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(runtime)) throw fail('SCHEMA', 'A trusted runtime profile is required');
  const timeoutMs = duration('timeoutMs', options.timeoutMs ?? 10000);
  const cancellationGraceMs = duration('cancellationGraceMs', options.cancellationGraceMs ?? 250);
  const cleanupTimeoutMs = duration('cleanupTimeoutMs', options.cleanupTimeoutMs ?? 3000);
  const terminationGraceMs = duration('terminationGraceMs', options.terminationGraceMs ?? 1000);
  if (terminationGraceMs >= cleanupTimeoutMs) throw fail('SCHEMA', 'Termination grace must be shorter than cleanup deadline');
  const stderrLimit = duration('stderrLimit', options.stderrLimit ?? 65536);
  if (options.onStderr !== undefined && typeof options.onStderr !== 'function') throw fail('SCHEMA', 'Invalid evaluator log consumer');
  return {manifest, runtime, timeoutMs, cancellationGraceMs, cleanupTimeoutMs, terminationGraceMs, stderrLimit, onStderr: options.onStderr};
}

/** Trusted controller for an already restricted public-port transport. */
export class WorkerClient {
  static async launch({supervisor, ...options}) {
    if (!supervisor || typeof supervisor.command !== 'string' || !supervisor.command || !Array.isArray(supervisor.args) || supervisor.args.some(arg => typeof arg !== 'string')) throw fail('SCHEMA', 'An evaluator-approved supervisor command is required');
    if (supervisor.cwd !== undefined && typeof supervisor.cwd !== 'string') throw fail('SCHEMA', 'Invalid supervisor working directory');
    if (supervisor.env !== undefined && (!supervisor.env || typeof supervisor.env !== 'object' || Array.isArray(supervisor.env) || Object.values(supervisor.env).some(value => typeof value !== 'string'))) throw fail('SCHEMA', 'Invalid supervisor environment');
    // Validate every option and snapshot the public manifest BEFORE spawning anything.
    const checked = prepare(options);
    const child = spawn(supervisor.command, supervisor.args, {
      cwd: supervisor.cwd, env: supervisor.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    let exited = false; let killTimer;
    const closed = new Promise(resolve => child.once('close', (code, signal) => {
      exited = true; clearTimeout(killTimer); resolve({code, signal});
    }));
    const transport = {
      readable: child.stdout, writable: child.stdin, closed,
      terminate: () => {
        if (exited) return closed;
        child.stdin.destroy(); child.kill('SIGTERM');
        killTimer ??= setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, checked.terminationGraceMs);
        return closed;
      },
      onClose: callback => { child.once('error', callback); child.once('exit', (code, signal) => callback(fail('CLOSED', `Supervisor exited (${signal ?? code})`))); },
    };
    let client;
    try {
      client = new WorkerClient(transport, checked);
      let stderrBytes = 0;
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes > checked.stderrLimit) client._fatal(fail('LIMIT', 'Supervisor stderr limit exceeded'));
        else if (checked.onStderr) { try { checked.onStderr(chunk); } catch { client._fatal(fail('APPLICATION', 'Evaluator log consumer failed')); } }
      });
      await client.start(); return client;
    } catch (error) {
      if (client) { client._fatal(error); await client._stop().catch(() => {}); }
      else { transport.terminate(); await closed; }
      throw error;
    }
  }

  /** Caller must have independently enforced isolation; a raw process is not a sandbox. */
  static async fromIsolatedTransport(transport, options) {
    const client = new WorkerClient(transport, options);
    try { await client.start(); return client; }
    catch (error) { client._fatal(error); await client._stop().catch(() => {}); throw error; }
  }

  constructor(transport, options) {
    const checked = prepare(options);
    if (!transport?.readable || !transport.writable || typeof transport.terminate !== 'function' || typeof transport.closed?.then !== 'function') throw fail('SCHEMA', 'Isolated transport requires streams, terminate, and a closed promise');
    Object.assign(this, checked);
    this.transport = transport;
    this.state = 'awaitHello'; this.nextId = 1; this.pending = null; this.cancelPending = null;
    this.terminalError = null; this.primaryError = null; this.closing = false; this.closePromise = null; this.stopPromise = null;
    this.operations = new Map([...this.manifest.initializers, ...this.manifest.actions].map(action => [action.id, action]));
    this.initializers = new Set(this.manifest.initializers.map(action => action.id));
    this.decoder = new FrameDecoder(reply => this._receive(reply));
    transport.readable.on('data', chunk => { try { this.decoder.push(chunk); } catch (error) { this._fatal(error); } });
    transport.readable.on('error', error => this._fatal(fail('CLOSED', error.message)));
    transport.readable.on('end', () => {
      try { this.decoder.end(); } catch (error) { this._fatal(error); return; }
      if (!this.closing || this.pending) this._fatal(fail('CLOSED', 'Worker closed the protocol channel'));
    });
    transport.writable.on('error', error => this._fatal(fail('CLOSED', error.message)));
    transport.onClose?.(error => { if (!this.closing || this.pending) this._fatal(error instanceof Error ? error : fail('CLOSED', 'Worker exited')); });
  }

  async start() {
    if (this.state !== 'awaitHello') throw fail('LIFECYCLE', 'Client already started');
    await this._call('hello', {interfaceDigest: this.manifest.interfaceDigest, runtime: this.runtime});
    this.state = 'awaitCreate';
    await this._call('create'); this.state = 'needInitializer'; return this;
  }

  async invoke(actionId, inputs, options = {}) {
    this._available();
    if (this.state !== 'needInitializer' && this.state !== 'readyAction') throw fail('LIFECYCLE', 'Operation requires preceding observation');
    const action = this.operations.get(actionId);
    if (!action) throw fail('VALUE', 'Unknown public action ID');
    if (this.state === 'needInitializer' && !this.initializers.has(actionId)) throw fail('LIFECYCLE', 'Initialization is required');
    const encoded = encodeFields(action.inputs, inputs);
    await this._call('invoke', {action: actionId, inputs: encoded}, options); this.state = 'needObserve';
  }

  async observe(options = {}) {
    this._available();
    if (this.state !== 'needObserve') throw fail('LIFECYCLE', 'Observation requires a completed operation');
    const observations = await this._call('observe', {}, options);
    this.state = 'readyAction'; return observations;
  }

  _available() {
    if (this.terminalError) throw this.terminalError;
    if (this.closing || this.state === 'disposed' || this.state === 'poisoned') throw fail('LIFECYCLE', 'Worker is unavailable');
    if (this.pending || this.cancelPending) throw fail('LIFECYCLE', 'Only one operation may be pending');
  }

  _call(op, fields = {}, {signal, timeoutMs = this.timeoutMs} = {}) {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.pending || this.cancelPending) return Promise.reject(fail('LIFECYCLE', 'Only one operation may be pending'));
    try { duration('operation deadline', timeoutMs); } catch (error) { return Promise.reject(error); }
    if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(fail('SCHEMA', 'Expected an AbortSignal'));
    if (signal?.aborted) return Promise.reject(fail('CANCELLED', 'Operation cancelled before dispatch'));
    if (!Number.isSafeInteger(this.nextId)) return Promise.reject(fail('LIMIT', 'Request ID space exhausted'));
    const request = {v: 1, id: this.nextId++, op, ...fields};
    let encoded; try { encoded = frame(request); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const entry = {request, resolve, reject, signal, timer: null, abort: null, cancelled: null}; this.pending = entry;
      entry.abort = () => this._cancel(entry, fail('CANCELLED', 'Operation cancelled'));
      signal?.addEventListener('abort', entry.abort, {once: true});
      entry.timer = setTimeout(() => this._cancel(entry, fail('TIMEOUT', 'Worker operation deadline exceeded')), timeoutMs);
      try { this.transport.writable.write(encoded); } catch (error) { this._fatal(error); }
    });
  }

  _cancel(entry, reason) {
    if (this.pending !== entry || entry.cancelled || this.terminalError) return;
    entry.cancelled = reason; this.state = 'poisoned'; this.primaryError ??= reason;
    clearTimeout(entry.timer);
    // A cleanup callback cannot be interrupted by another protocol request.
    if (entry.request.op === 'dispose') { this._fatal(reason); return; }
    const request = {v: 1, id: this.nextId++, op: 'cancel', requestId: entry.request.id};
    const grace = setTimeout(() => this._fatal(reason), this.cancellationGraceMs);
    this.cancelPending = {request, grace};
    try { this.transport.writable.write(frame(request)); } catch (error) { this._fatal(error); }
  }

  _settle(entry, error, value) {
    clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort);
    if (this.pending === entry) this.pending = null;
    if (error) entry.reject(error); else entry.resolve(value);
  }

  _receive(raw) {
    if (this.terminalError) return;
    const reply = validateResponse(raw);
    if (this.cancelPending && reply.id === this.cancelPending.request.id) {
      if (this.pending) throw fail('SCHEMA', 'Cancellation reply preceded original operation reply');
      if (!reply.ok || reply.result !== null) throw fail('SCHEMA', 'Invalid cancellation acknowledgment');
      clearTimeout(this.cancelPending.grace); this.cancelPending = null; return;
    }
    const entry = this.pending;
    if (!entry || reply.id !== entry.request.id) throw fail('SCHEMA', 'Unsolicited or incorrectly correlated response');
    if (!reply.ok) {
      this.state = 'poisoned';
      if (entry.cancelled && reply.error.code !== 'CANCELLED') throw fail('SCHEMA', 'Cancelled operation returned another outcome');
      const error = entry.cancelled ?? fail(reply.error.code, reply.error.message); this.primaryError ??= error;
      this._settle(entry, error); return;
    }
    if (entry.cancelled) throw fail('SCHEMA', 'Cancelled operation returned success');
    let result = reply.result;
    if (entry.request.op === 'hello') {
      exact(result, ['interfaceDigest', 'runtime']);
      if (result.interfaceDigest !== this.manifest.interfaceDigest || result.runtime !== this.runtime) throw fail('HANDSHAKE', 'Worker identity does not match the trusted public port');
    } else if (entry.request.op === 'observe') result = decodeFields(this.manifest.observations, result);
    else if (result !== null) throw fail('SCHEMA', 'Operation result must be null');
    this._settle(entry, null, result);
  }

  _fatal(error) {
    if (this.terminalError) return;
    this.terminalError = error instanceof ProtocolError ? error : fail('CLOSED', error?.message ?? 'Worker transport failed');
    this.primaryError ??= this.terminalError; this.state = 'poisoned';
    if (this.pending) this._settle(this.pending, this.terminalError);
    if (this.cancelPending) { clearTimeout(this.cancelPending.grace); this.cancelPending = null; }
    this._stop().catch(() => {});
  }

  _stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => this.transport.terminate()).then(() => this.transport.closed),
          new Promise((_, reject) => { timer = setTimeout(() => reject(fail('CLEANUP', 'Supervisor cleanup deadline exceeded')), this.cleanupTimeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    })();
    return this.stopPromise;
  }

  /** At-most-once remote disposal, followed by bounded and awaited supervisor cleanup. */
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      if (this.pending) this._cancel(this.pending, fail('CANCELLED', 'Worker is closing'));
      if (this.pending || this.cancelPending) {
        await new Promise(resolve => {
          const poll = () => { if (!this.pending && !this.cancelPending) resolve(); else setTimeout(poll, 5); }; poll();
        });
      }
      const originalError = this.primaryError;
      let cleanupError;
      try {
        if (!this.terminalError && this.state !== 'awaitHello' && this.state !== 'disposed') await this._call('dispose');
      } catch (error) { cleanupError = error; }
      finally {
        this.state = 'disposed';
        try { this.transport.writable.end(); } catch {}
        try { await this._stop(); } catch (error) { cleanupError ??= error; }
      }
      // A cleanup failure must never replace a previously reported operation failure.
      if (cleanupError && !originalError) throw cleanupError;
    })();
    return this.closePromise;
  }
  dispose() { return this.close(); }
}

/** This proxy maps stable IDs only; a generated port wrapper supplies native names. */
export function createPortProxy(client) {
  if (!(client instanceof WorkerClient)) throw fail('SCHEMA', 'Expected an admitted WorkerClient');
  return Object.freeze({
    invoke: (id, inputs, options) => client.invoke(id, inputs, options),
    observe: options => client.observe(options),
    dispose: () => client.close(),
  });
}
