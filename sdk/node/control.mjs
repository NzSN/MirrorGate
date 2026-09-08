import {spawn} from 'node:child_process';
import {lstat} from 'node:fs/promises';
import net from 'node:net';
import {isAbsolute, normalize, parse as parsePath, resolve as resolvePath} from 'node:path';
import {EventEmitter} from 'node:events';
import {LIMITS as WORKER_LIMITS, parseJson as parseWorkerJson, validateManifest} from './protocol.mjs';

export const CONTROL_LIMITS = Object.freeze({
  frameBytes: 1_048_576,
  jsonDepth: 128,
  jsonNodes: 16_384,
  pendingOutputBytes: 4 * 1_048_576,
  inflightRequests: 16,
  errorMessageBytes: 1_024,
  outputChunkBytes: 16_384,
  attachmentFrameBytes: 4_096,
});

const CATALOG_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const HANDLE = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ASCII = /^[\x20-\x7e]*$/;
const ERROR_CODES = new Set([
  'VERSION_UNSUPPORTED', 'CAPABILITY_UNAVAILABLE', 'ARGUMENT_INVALID', 'POLICY_DENIED',
  'HANDLE_INVALID', 'STATE_INVALID', 'LIMIT_EXCEEDED', 'PREPARATION_FAILED',
  'BUILD_FAILED', 'NEGOTIATION_ATTESTATION_INVALID', 'BACKEND_ADMISSION_FAILED',
  'ATTACHMENT_FAILED', 'WORKER_PROTOCOL_FAILED', 'WORKER_EXITED', 'CANCELLED',
  'DEADLINE_EXCEEDED', 'CLEANUP_FAILED', 'OPERATION_UNKNOWN',
]);
const ERROR_STAGES = new Set(['bootstrap', 'policy', 'authoring', 'prepare', 'build', 'authorize', 'attach', 'worker', 'cleanup']);
const PHASES = new Set(['open', 'authoring', 'preparing', 'prepared', 'authorized', 'reserved', 'starting', 'running', 'closing', 'closed', 'cleanupFailed']);
const CLEANUP_STATUSES = new Set(['notStarted', 'pending', 'succeeded', 'failed']);
const REASONS = new Set(['normal', 'user-cancel', 'deadline', 'client-failure', 'worker-failure']);
const OUTCOME_STATUSES = new Set(['passed', 'mismatch', 'failed', 'cancelled', 'timedOut']);
const SCOPES = new Set(['connection', 'session', 'command', 'process', 'host-uid', 'host', 'none']);
const EVENT_NAMES = new Set(['operation.finished', 'authoring.output', 'build.output', 'worker.started', 'worker.ready', 'worker.exited', 'worker.closing', 'session.closed']);
const HELLO_LIMITS = ['maxFrameBytes', 'maxJsonDepth', 'maxJsonNodes', 'maxPendingOutputBytes', 'maxSessionsPerConnection', 'maxInflightRequestsPerConnection', 'maxCompletedOperationsPerSession', 'helloTimeoutMs', 'requestAckTimeoutMs', 'workerAttachmentTimeoutMs', 'sessionWallMs', 'gracefulStopMs', 'teardownMs'];
const TIGHTENED_LIMITS = ['sessionWallMs', 'executionWallMs', 'commandCpuSeconds', 'addressSpaceBytes', 'uidProcesses', 'openFiles', 'fileBytes', 'stdoutBytes', 'stderrBytes', 'snapshotFiles', 'snapshotBytes', 'tmpBytes', 'scratchBytes'];
const CAPABILITY_LIMITS = new Set([...HELLO_LIMITS, ...TIGHTENED_LIMITS]);

const scalarString = value => typeof value === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const byteLength = value => Buffer.byteLength(value, 'utf8');
const safePositive = value => Number.isSafeInteger(value) && value > 0;
const safeNonnegative = value => Number.isSafeInteger(value) && value >= 0;

export class ControlProtocolError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ControlProtocolError';
    this.code = code;
  }
}

export class ControlError extends Error {
  constructor({code, stage, message, operationId}) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
    this.stage = stage;
    if (operationId !== undefined) this.operationId = operationId;
  }
}

const protocolFailure = (code, message, options) => new ControlProtocolError(code, message, options);
const bad = (message, code = 'CONTROL_PROTOCOL_ERROR') => { throw protocolFailure(code, message); };
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function exact(value, required, optional = []) {
  if (!object(value)) bad('Expected a JSON object');
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !allowed.has(key))) bad('Unexpected object fields');
  return value;
}
function oneOf(value, choices, label) { if (!choices.has(value)) bad(`Invalid ${label}`); return value; }
function handle(value, label = 'handle') { if (typeof value !== 'string' || !HANDLE.test(value)) bad(`Invalid ${label}`); return value; }
function digest(value, label = 'digest') { if (typeof value !== 'string' || !DIGEST.test(value)) bad(`Invalid ${label}`); return value; }
function catalogId(value, label = 'identifier') { if (typeof value !== 'string' || !CATALOG_ID.test(value)) bad(`Invalid ${label}`); return value; }
function positive(value, label) { if (!safePositive(value)) bad(`Invalid ${label}`); return value; }
function nonnegative(value, label) { if (!safeNonnegative(value)) bad(`Invalid ${label}`); return value; }
function safeInteger(value, label) { if (!Number.isSafeInteger(value)) bad(`Invalid ${label}`); return value; }
function bool(value, label) { if (typeof value !== 'boolean') bad(`Invalid ${label}`); return value; }
function string(value, label, maxBytes, {ascii = false, nonempty = false} = {}) {
  if (!scalarString(value) || (ascii && !ASCII.test(value)) || (nonempty && value.length === 0) || byteLength(value) > maxBytes) bad(`Invalid ${label}`);
  return value;
}

/** Strict bounded JSON parser for the independent control-v1 limits. */
export function parseControlJson(text, maxBytes = CONTROL_LIMITS.frameBytes) {
  if (typeof text !== 'string' || byteLength(text) > maxBytes) bad('JSON byte limit exceeded', 'CONTROL_LIMIT_EXCEEDED');
  let pos = 0;
  let nodes = 0;
  const ws = () => { while (pos < text.length && /[ \t\r\n]/.test(text[pos])) pos++; };
  const parseString = () => {
    const start = pos++;
    while (pos < text.length) {
      const c = text[pos++];
      if (c === '"') {
        let result;
        try { result = JSON.parse(text.slice(start, pos)); } catch { bad('Malformed JSON string'); }
        if (!scalarString(result)) bad('Non-scalar Unicode string');
        return result;
      }
      if (c === '\\') pos++;
    }
    bad('Unterminated JSON string');
  };
  const parseValue = depth => {
    if (depth > CONTROL_LIMITS.jsonDepth || ++nodes > CONTROL_LIMITS.jsonNodes) bad('JSON structural limit exceeded', 'CONTROL_LIMIT_EXCEEDED');
    ws();
    const c = text[pos];
    if (c === '"') return parseString();
    if (c === '{') {
      pos++; ws();
      const entries = [];
      const seen = new Set();
      if (text[pos] === '}') { pos++; return {}; }
      while (pos < text.length) {
        ws();
        if (text[pos] !== '"') bad('Expected object key');
        const key = parseString();
        if (seen.has(key)) bad('Duplicate JSON object key');
        seen.add(key);
        ws();
        if (text[pos++] !== ':') bad('Expected colon');
        entries.push([key, parseValue(depth + 1)]);
        ws();
        const separator = text[pos++];
        if (separator === '}') return Object.fromEntries(entries);
        if (separator !== ',') bad('Expected object separator');
      }
      bad('Unterminated JSON object');
    }
    if (c === '[') {
      pos++; ws();
      const result = [];
      if (text[pos] === ']') { pos++; return result; }
      while (pos < text.length) {
        result.push(parseValue(depth + 1));
        ws();
        const separator = text[pos++];
        if (separator === ']') return result;
        if (separator !== ',') bad('Expected array separator');
      }
      bad('Unterminated JSON array');
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, pos)) { pos += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(pos));
    if (!match) bad('Malformed JSON value');
    const token = match[0];
    pos += token.length;
    const parts = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
    let digits = (parts[2] + (parts[3] ?? '')).replace(/^0+/, '');
    const exponent = Number(parts[4] ?? '0');
    if (!Number.isSafeInteger(exponent)) bad('Unsafe JSON number');
    const scale = exponent - (parts[3]?.length ?? 0);
    if (!digits) return 0;
    if (scale < 0) {
      const removed = -scale;
      if (removed >= digits.length || !digits.endsWith('0'.repeat(Math.min(removed, digits.length)))) bad('Fractional JSON number');
      digits = digits.slice(0, digits.length - removed);
    } else {
      if (digits.length + scale > 16) bad('Unsafe JSON number');
      digits += '0'.repeat(scale);
    }
    const result = Number(parts[1] + digits);
    if (!Number.isSafeInteger(result)) bad('Unsafe JSON number');
    return result;
  };
  const result = parseValue(0);
  ws();
  if (pos !== text.length) bad('Trailing JSON content');
  return result;
}

export class ControlFrameDecoder {
  constructor(onMessage, {maxBytes = CONTROL_LIMITS.frameBytes} = {}) {
    if (typeof onMessage !== 'function' || !safePositive(maxBytes)) bad('Invalid frame decoder options');
    this.onMessage = onMessage;
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
  }
  push(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < data.length) {
      const end = data.indexOf(10, start);
      const part = data.subarray(start, end < 0 ? data.length : end);
      if (this.buffer.length + part.length > this.maxBytes) bad('Frame byte limit exceeded', 'CONTROL_LIMIT_EXCEEDED');
      this.buffer = Buffer.concat([this.buffer, part]);
      if (end < 0) return;
      if (this.buffer.length === 0) bad('Empty JSONL frame');
      if (this.buffer.length >= 3 && this.buffer[0] === 0xef && this.buffer[1] === 0xbb && this.buffer[2] === 0xbf) bad('UTF-8 BOM is forbidden in JSONL frames');
      if (this.buffer.includes(13)) bad('CR is forbidden in JSONL frames');
      let line;
      try { line = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(this.buffer); }
      catch { bad('Invalid UTF-8'); }
      this.buffer = Buffer.alloc(0);
      const message = parseControlJson(line, this.maxBytes);
      if (!object(message)) bad('A frame must contain an object');
      this.onMessage(message);
      start = end + 1;
    }
  }
  end() { if (this.buffer.length !== 0) bad('Unterminated JSONL frame'); }
}

export function controlFrame(value, maxBytes = CONTROL_LIMITS.frameBytes) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch (error) { throw protocolFailure('CONTROL_PROTOCOL_ERROR', 'Control frame is not JSON encodable', {cause: error}); }
  if (encoded === undefined || byteLength(encoded) > maxBytes) bad('Frame byte limit exceeded', 'CONTROL_LIMIT_EXCEEDED');
  const checked = parseControlJson(encoded, maxBytes);
  if (!object(checked)) bad('A frame must contain an object');
  return Buffer.from(`${encoded}\n`, 'utf8');
}

function validateReason(value) { return oneOf(value, REASONS, 'cleanup reason'); }
function validateControlError(value) {
  exact(value, ['code', 'stage', 'message'], ['operationId']);
  oneOf(value.code, ERROR_CODES, 'control error code');
  oneOf(value.stage, ERROR_STAGES, 'control error stage');
  string(value.message, 'control error message', CONTROL_LIMITS.errorMessageBytes);
  if (value.operationId !== undefined) positive(value.operationId, 'operation ID');
  return value;
}
function validateCounts(value) {
  exact(value, ['authoringProcesses', 'buildProcesses', 'workers', 'snapshots']);
  for (const key of Object.keys(value)) nonnegative(value[key], key);
  return value;
}
function validateRemainingResources(value) {
  if (!Array.isArray(value) || value.length > 64) bad('Invalid remaining resources');
  for (const item of value) catalogId(item, 'remaining resource');
  if (new Set(value).size !== value.length) bad('Duplicate remaining resource');
  return value;
}
function validateCleanup(value) {
  exact(value, ['status', 'remainingResources']);
  oneOf(value.status, CLEANUP_STATUSES, 'cleanup status');
  validateRemainingResources(value.remainingResources);
  return value;
}
function validateCleanupResult(value) {
  exact(value, ['phase', 'cleanupStatus', 'remainingResources']);
  oneOf(value.phase, new Set(['closed', 'cleanupFailed']), 'terminal session phase');
  oneOf(value.cleanupStatus, new Set(['succeeded', 'failed']), 'terminal cleanup status');
  validateRemainingResources(value.remainingResources);
  if ((value.phase === 'closed') !== (value.cleanupStatus === 'succeeded') || (value.phase === 'closed' && value.remainingResources.length)) bad('Incoherent terminal cleanup result');
  return value;
}
function validateOperationOutcome(value, terminalValidator, {terminal = false, expectedId} = {}) {
  if (!object(value)) bad('Invalid operation outcome');
  if (value.status === 'pending') {
    exact(value, ['operationId', 'status']);
  } else if (value.status === 'succeeded') {
    exact(value, ['operationId', 'status', 'result']);
    if (terminalValidator) terminalValidator(value.result);
  } else if (value.status === 'failed') {
    exact(value, ['operationId', 'status', 'error']);
    validateControlError(value.error);
  } else bad('Invalid operation status');
  positive(value.operationId, 'operation ID');
  if (expectedId !== undefined && value.operationId !== expectedId) bad('Operation status correlation mismatch');
  if (terminal && value.status === 'pending') bad('Terminal operation event cannot be pending');
  if (value.status === 'failed' && value.error.operationId !== undefined && value.error.operationId !== value.operationId) bad('Operation error correlation mismatch');
  return value;
}
function validateOutputEvent(value) {
  exact(value, ['operationId', 'stream', 'chunk', 'bytesBase64']);
  positive(value.operationId, 'operation ID');
  oneOf(value.stream, new Set(['stdout', 'stderr']), 'output stream');
  positive(value.chunk, 'output chunk');
  if (typeof value.bytesBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bytesBase64)) bad('Invalid base64 output');
  const decoded = Buffer.from(value.bytesBase64, 'base64');
  if (decoded.length > CONTROL_LIMITS.outputChunkBytes || decoded.toString('base64') !== value.bytesBase64) bad('Invalid base64 output');
  return value;
}

const TERMINAL_VALIDATORS = Object.freeze({
  CommandResult(value) {
    exact(value, ['exitCode', 'stdoutBytes', 'stderrBytes']);
    safeInteger(value.exitCode, 'exit code');
    nonnegative(value.stdoutBytes, 'stdout bytes');
    nonnegative(value.stderrBytes, 'stderr bytes');
  },
  Prepared(value) {
    exact(value, ['preparedRevision', 'artifactId', 'artifactHash', 'manifestHash', 'runtime', 'policyId', 'challenge'], ['sourceHash']);
    if (value.preparedRevision !== 1) bad('Invalid prepared revision');
    handle(value.artifactId, 'artifact ID');
    digest(value.artifactHash, 'artifact hash');
    if (value.sourceHash !== undefined) digest(value.sourceHash, 'source hash');
    digest(value.manifestHash, 'manifest hash');
    catalogId(value.runtime, 'runtime');
    catalogId(value.policyId, 'policy ID');
    handle(value.challenge, 'authorization challenge');
  },
  CleanupResult: validateCleanupResult,
});
const TERMINAL_BY_OPERATION = Object.freeze({
  'authoring.exec': TERMINAL_VALIDATORS.CommandResult,
  'session.prepare': TERMINAL_VALIDATORS.Prepared,
  'worker.release': TERMINAL_VALIDATORS.CleanupResult,
  'session.cancel': TERMINAL_VALIDATORS.CleanupResult,
  'session.close': TERMINAL_VALIDATORS.CleanupResult,
});

function validateHello(value, requiredCapabilities) {
  exact(value, ['controlVersion', 'instanceId', 'capabilities', 'limits']);
  if (value.controlVersion !== 1) bad('Unsupported selected control version', 'CONTROL_HANDSHAKE_FAILED');
  handle(value.instanceId, 'instance ID');
  if (!Array.isArray(value.capabilities) || value.capabilities.length > 64) bad('Invalid capability report');
  const ids = new Set();
  for (const capability of value.capabilities) {
    exact(capability, ['id', 'available', 'enforcedScope', 'limits'], ['reason']);
    catalogId(capability.id, 'capability ID');
    if (ids.has(capability.id)) bad('Duplicate capability report');
    ids.add(capability.id);
    bool(capability.available, 'capability availability');
    oneOf(capability.enforcedScope, SCOPES, 'enforced scope');
    exact(capability.limits, [], [...CAPABILITY_LIMITS]);
    for (const [key, limit] of Object.entries(capability.limits)) nonnegative(limit, key);
    if (capability.available) {
      if (capability.reason !== undefined || capability.enforcedScope === 'none') bad('Invalid available capability');
    } else {
      catalogId(capability.reason, 'capability unavailable reason');
      if (capability.enforcedScope !== 'none') bad('Invalid unavailable capability scope');
    }
  }
  for (const capability of requiredCapabilities) {
    const reported = value.capabilities.find(item => item.id === capability);
    if (!reported?.available) bad(`Required capability was not reported available: ${capability}`, 'CONTROL_HANDSHAKE_FAILED');
  }
  exact(value.limits, HELLO_LIMITS);
  for (const key of HELLO_LIMITS) positive(value.limits[key], key);
  return value;
}
function validateSessionStatus(value) {
  exact(value, ['phase', 'resources', 'cleanup']);
  oneOf(value.phase, PHASES, 'session phase');
  validateCounts(value.resources);
  validateCleanup(value.cleanup);
  if (value.phase === 'closed' || value.phase === 'cleanupFailed') validateCleanupResult({phase: value.phase, cleanupStatus: value.cleanup.status, remainingResources: value.cleanup.remainingResources});
  return value;
}
function validateResult(op, value, context) {
  switch (op) {
    case 'hello': return validateHello(value, context.requiredCapabilities);
    case 'session.open': exact(value, ['sessionId']); handle(value.sessionId, 'session ID'); return value;
    case 'authoring.exec': case 'session.prepare': case 'session.cancel': case 'session.close':
      exact(value, ['operationId']); positive(value.operationId, 'operation ID'); return value;
    case 'worker.release':
      exact(value, ['operationId', 'cleanupMode']); positive(value.operationId, 'operation ID');
      oneOf(value.cleanupMode, new Set(['dispose-then-terminate', 'terminate-only']), 'worker cleanup mode'); return value;
    case 'session.authorize': exact(value, ['authorizationId']); handle(value.authorizationId, 'authorization ID'); return value;
    case 'worker.acquire':
      exact(value, ['workerId', 'endpoint', 'attachmentToken', 'attachmentTimeoutMs', 'releaseMode']);
      handle(value.workerId, 'worker ID');
      exact(value.endpoint, ['kind', 'path']);
      string(value.endpoint.path, 'worker endpoint', 107, {nonempty: true});
      if (value.endpoint.kind !== 'unix' || !isAbsolute(value.endpoint.path) || value.endpoint.path.includes('\0') || normalize(value.endpoint.path) !== value.endpoint.path || value.endpoint.path.slice(1).split('/').some(part => part === '' || part === '.' || part === '..')) bad('Invalid worker endpoint');
      if (typeof value.attachmentToken !== 'string' || !/^[0-9a-f]{64}$/.test(value.attachmentToken)) bad('Invalid attachment token');
      positive(value.attachmentTimeoutMs, 'attachment timeout');
      if (value.releaseMode !== 'control-v1') bad('Unsupported worker release mode');
      return value;
    case 'session.status': return validateSessionStatus(value);
    case 'operation.status': return validateOperationOutcome(value, context.terminalValidator, {expectedId: context.operationId});
    default: bad('Unknown response operation');
  }
}

function relativePath(value, label) {
  string(value, label, 1_024, {nonempty: true});
  if (value.includes('\0') || isAbsolute(value) || (value !== '.' && (normalize(value) !== value || value.split('/').some(part => part === '..' || part === '.' || part === '')))) bad(`Invalid ${label}`);
  return value;
}
function inputRef(value) { exact(value, ['rootId', 'relativePath']); catalogId(value.rootId, 'root ID'); relativePath(value.relativePath, 'input path'); return value; }
function submission(value) {
  if (!object(value)) bad('Invalid submission');
  if (value.kind === 'prebuilt') { exact(value, ['kind', 'input']); inputRef(value.input); }
  else if (value.kind === 'source') { exact(value, ['kind', 'input', 'buildPlanId', 'authoring']); inputRef(value.input); catalogId(value.buildPlanId, 'build plan ID'); bool(value.authoring, 'authoring mode'); }
  else bad('Invalid submission kind');
  return value;
}
function validateLimits(value) {
  exact(value, [], TIGHTENED_LIMITS);
  for (const [key, limit] of Object.entries(value)) positive(limit, key);
  return value;
}
function validateAttestation(value) {
  exact(value, ['registrationId', 'request', 'policy', 'status', 'descriptorSchema', 'semanticDigest', 'adapterId', 'targetProfile', 'stateComputerContractVersion']);
  string(value.registrationId, 'registration ID', 128, {nonempty: true});
  if (value.request !== 'verify' || value.policy !== 'require' || value.status !== 'matched') bad('Invalid attestation result');
  if (value.descriptorSchema !== 'mirrors.model-interface-descriptor/v1') bad('Invalid descriptor schema');
  digest(value.semanticDigest, 'semantic digest');
  for (const key of ['adapterId', 'targetProfile', 'stateComputerContractVersion']) string(value[key], key, 128, {nonempty: true});
  return value;
}
function validateOutcomeSummary(value) {
  exact(value, ['status'], ['failureFamily']);
  oneOf(value.status, OUTCOME_STATUSES, 'outcome status');
  if (value.failureFamily !== undefined) catalogId(value.failureFamily, 'failure family');
  return value;
}
function validateOpenArgs(value) {
  exact(value, ['policyId', 'submission', 'runtime', 'manifestJson'], ['limits', 'modelRevisionId']);
  catalogId(value.policyId, 'policy ID'); submission(value.submission); catalogId(value.runtime, 'runtime');
  string(value.manifestJson, 'manifest JSON', WORKER_LIMITS.manifestBytes);
  try { validateManifest(parseWorkerJson(value.manifestJson, WORKER_LIMITS.manifestBytes)); }
  catch { bad('Invalid public manifest'); }
  if (value.limits !== undefined) validateLimits(value.limits);
  if (value.modelRevisionId !== undefined) string(value.modelRevisionId, 'model revision ID', 128, {ascii: true, nonempty: true});
  const outer = {...value}; delete outer.manifestJson;
  if (byteLength(JSON.stringify(outer)) > 65_535) bad('Session envelope exceeds its independent limit', 'CONTROL_LIMIT_EXCEEDED');
  return value;
}
function validateArgs(op, value) {
  switch (op) {
    case 'hello': {
      exact(value, ['controlVersions', 'requiredCapabilities']);
      if (!Array.isArray(value.controlVersions) || value.controlVersions.length < 1 || value.controlVersions.length > 8 || value.controlVersions.some(version => !safePositive(version)) || new Set(value.controlVersions).size !== value.controlVersions.length) bad('Invalid control versions');
      if (!Array.isArray(value.requiredCapabilities) || value.requiredCapabilities.length > 64) bad('Invalid required capabilities');
      for (const capability of value.requiredCapabilities) catalogId(capability, 'capability ID');
      if (new Set(value.requiredCapabilities).size !== value.requiredCapabilities.length) bad('Duplicate required capability');
      return value;
    }
    case 'session.open': return validateOpenArgs(value);
    case 'authoring.exec': {
      exact(value, ['sessionId', 'toolId', 'arguments', 'cwd']); handle(value.sessionId, 'session ID'); catalogId(value.toolId, 'tool ID');
      if (!Array.isArray(value.arguments) || value.arguments.length > 256) bad('Invalid tool arguments');
      let bytes = 0;
      for (const argument of value.arguments) { string(argument, 'tool argument', 65_535); if (argument.includes('\0')) bad('Invalid tool argument'); bytes += byteLength(argument); }
      if (bytes > 65_535) bad('Tool arguments exceed byte limit', 'CONTROL_LIMIT_EXCEEDED');
      relativePath(value.cwd, 'working directory'); return value;
    }
    case 'session.prepare': case 'session.status': exact(value, ['sessionId']); handle(value.sessionId, 'session ID'); return value;
    case 'session.authorize':
      exact(value, ['sessionId', 'preparedRevision', 'challenge', 'attestation']); handle(value.sessionId, 'session ID'); positive(value.preparedRevision, 'prepared revision'); handle(value.challenge, 'challenge'); validateAttestation(value.attestation); return value;
    case 'worker.acquire': exact(value, ['sessionId', 'authorizationId']); handle(value.sessionId, 'session ID'); handle(value.authorizationId, 'authorization ID'); return value;
    case 'worker.release': exact(value, ['sessionId', 'workerId', 'reason']); handle(value.sessionId, 'session ID'); handle(value.workerId, 'worker ID'); validateReason(value.reason); return value;
    case 'session.cancel': exact(value, ['sessionId', 'reason']); handle(value.sessionId, 'session ID'); validateReason(value.reason); return value;
    case 'session.close': exact(value, ['sessionId'], ['outcomeSummary']); handle(value.sessionId, 'session ID'); if (value.outcomeSummary !== undefined) validateOutcomeSummary(value.outcomeSummary); return value;
    case 'operation.status': exact(value, ['sessionId', 'operationId']); handle(value.sessionId, 'session ID'); positive(value.operationId, 'operation ID'); return value;
    default: bad('Unknown control operation');
  }
}

export function validateControlRequest(message) {
  exact(message, ['v', 'kind', 'id', 'op', 'args']);
  if (message.v !== 1 || message.kind !== 'request') bad('Invalid control request envelope');
  positive(message.id, 'request ID');
  if (typeof message.op !== 'string') bad('Invalid control operation');
  validateArgs(message.op, message.args);
  return message;
}

export function validateControlResponse(message, {request, op = request?.op, requiredCapabilities = request?.args?.requiredCapabilities ?? [], terminalValidator, operation} = {}) {
  if (!object(message)) bad('Invalid control response envelope');
  if (message.ok === true) exact(message, ['v', 'kind', 'id', 'ok', 'result']);
  else if (message.ok === false) exact(message, ['v', 'kind', 'id', 'ok', 'error']);
  else bad('Invalid control response status');
  if (message.v !== 1 || message.kind !== 'response') bad('Invalid control response envelope');
  positive(message.id, 'response ID');
  if (request !== undefined) {
    validateControlRequest(request);
    if (message.id !== request.id) bad('Uncorrelated control response');
  }
  if (message.ok === false) validateControlError(message.error);
  else {
    if (typeof op !== 'string') bad('Response validation requires its request operation');
    const checkedTerminal = terminalValidator ?? (operation ? TERMINAL_BY_OPERATION[operation] : undefined);
    validateResult(op, message.result, {requiredCapabilities, terminalValidator: checkedTerminal, operationId: request?.args?.operationId});
  }
  return message;
}

export function validateControlEventEnvelope(message) {
  exact(message, ['v', 'kind', 'seq', 'sessionId', 'event', 'data']);
  if (message.v !== 1 || message.kind !== 'event') bad('Invalid control event envelope');
  positive(message.seq, 'event sequence'); handle(message.sessionId, 'event session ID');
  oneOf(message.event, EVENT_NAMES, 'event name');
  if (!object(message.data)) bad('Invalid event data');
  return message;
}

export function validateControlEvent(message, {operation} = {}) {
  validateControlEventEnvelope(message);
  const terminalValidator = operation ? TERMINAL_BY_OPERATION[operation] : undefined;
  switch (message.event) {
    case 'operation.finished': validateOperationOutcome(message.data, terminalValidator, {terminal: true}); break;
    case 'authoring.output': case 'build.output': validateOutputEvent(message.data); break;
    case 'worker.started': case 'worker.ready': exact(message.data, ['workerId']); handle(message.data.workerId, 'worker ID'); break;
    case 'worker.closing': exact(message.data, ['workerId', 'reason']); handle(message.data.workerId, 'worker ID'); validateReason(message.data.reason); break;
    case 'worker.exited':
      exact(message.data, ['workerId', 'reason'], ['exitCode']); handle(message.data.workerId, 'worker ID'); validateReason(message.data.reason);
      if (message.data.exitCode !== undefined) safeInteger(message.data.exitCode, 'exit code');
      break;
    case 'session.closed': validateCleanupResult(message.data); break;
    default: bad('Unknown control event');
  }
  return message;
}

export function validateOperationRecord(value, operation, {terminal = false} = {}) {
  if (typeof operation !== 'string' || !TERMINAL_BY_OPERATION[operation]) bad('Unknown long operation');
  return validateOperationOutcome(value, TERMINAL_BY_OPERATION[operation], {terminal});
}

export function validateAttachmentRecord(message, {success = false} = {}) {
  exact(message, success ? ['v', 'kind', 'sessionId', 'workerId'] : ['v', 'kind', 'sessionId', 'workerId', 'attachmentToken']);
  if (message.v !== 1 || message.kind !== (success ? 'attached' : 'attach')) bad('Invalid attachment record');
  handle(message.sessionId, 'attachment session ID'); handle(message.workerId, 'attachment worker ID');
  if (!success && (typeof message.attachmentToken !== 'string' || !/^[0-9a-f]{64}$/.test(message.attachmentToken))) bad('Invalid attachment token');
  if (controlFrame(message, CONTROL_LIMITS.attachmentFrameBytes).length > CONTROL_LIMITS.attachmentFrameBytes + 1) bad('Attachment record exceeds its frame bound');
  return message;
}

function validateLaunchOptions(controller) {
  if (!object(controller) || typeof controller.command !== 'string' || controller.command.length === 0 || !Array.isArray(controller.args) || controller.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) bad('A trusted controller command and argument vector are required');
  if (controller.cwd !== undefined && typeof controller.cwd !== 'string') bad('Invalid controller working directory');
  if (controller.env !== undefined && (!object(controller.env) || Object.values(controller.env).some(value => typeof value !== 'string'))) bad('Invalid controller environment');
}
function duration(value, fallback, label) { const checked = value ?? fallback; return positive(checked, label); }
function prepareClientOptions(options = {}) {
  const requiredCapabilities = options.requiredCapabilities ?? [];
  validateArgs('hello', {controlVersions: [1], requiredCapabilities});
  if (options.onStderr !== undefined && typeof options.onStderr !== 'function') bad('Invalid controller log consumer');
  return {
    requiredCapabilities: Object.freeze([...requiredCapabilities]),
    helloTimeoutMs: duration(options.helloTimeoutMs, 5_000, 'hello timeout'),
    requestTimeoutMs: duration(options.requestTimeoutMs, 5_000, 'request timeout'),
    closeTimeoutMs: duration(options.closeTimeoutMs, 5_000, 'close timeout'),
    stderrLimit: duration(options.stderrLimit, 65_536, 'stderr limit'),
    onStderr: options.onStderr,
  };
}

function streamTransport(readable, writable, closed, stop, onClose, ownership) {
  return {readable, writable, closed, stop, onClose, ownership};
}
async function verifyUnixSocketPath(socketPath) {
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath) || socketPath.includes('\0')) bad('Unix socket path must be absolute');
  const root = parsePath(socketPath).root;
  const relative = socketPath.slice(root.length).split('/').filter(Boolean);
  let current = root;
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  let parent;
  for (let index = 0; index < relative.length; index++) {
    current = resolvePath(current, relative[index]);
    const status = await lstat(current);
    if (status.isSymbolicLink()) bad('Unix socket path contains a symbolic link', 'CONTROL_OWNERSHIP_FAILED');
    if (index < relative.length - 1 && !status.isDirectory()) bad('Unix socket parent is not a directory', 'CONTROL_OWNERSHIP_FAILED');
    if (index === relative.length - 2) parent = status;
    if (index === relative.length - 1) {
      if (!status.isSocket() || (status.mode & 0o777) !== 0o600) bad('Unix socket must be a mode-0600 filesystem socket', 'CONTROL_OWNERSHIP_FAILED');
      if (!parent || (parent.mode & 0o777) !== 0o700) bad('Unix socket directory must have mode 0700', 'CONTROL_OWNERSHIP_FAILED');
      if (expectedUid !== undefined && (status.uid !== expectedUid || parent.uid !== expectedUid)) bad('Unix socket or its directory has a foreign owner', 'CONTROL_OWNERSHIP_FAILED');
      return {device: status.dev, inode: status.ino};
    }
  }
  bad('Invalid Unix socket path');
}

async function connectSocket(socketPath, timeoutMs) {
  const before = await verifyUnixSocketPath(socketPath);
  const socket = net.createConnection({path: socketPath});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(protocolFailure('CONTROL_CONNECT_TIMEOUT', 'Unix socket connection deadline exceeded')), timeoutMs);
    const connected = () => { clearTimeout(timer); socket.off('error', failed); resolve(); };
    const failed = error => { clearTimeout(timer); socket.off('connect', connected); reject(protocolFailure('CONTROL_DISCONNECTED', error.message, {cause: error})); };
    socket.once('connect', connected); socket.once('error', failed);
  }).catch(error => { socket.destroy(); throw error; });
  const after = await verifyUnixSocketPath(socketPath).catch(error => { socket.destroy(); throw error; });
  if (before.device !== after.device || before.inode !== after.inode) { socket.destroy(); bad('Unix socket identity changed during connection', 'CONTROL_OWNERSHIP_FAILED'); }
  const closed = new Promise(resolve => socket.once('close', resolve));
  return streamTransport(socket, socket, closed, () => { socket.destroy(); return closed; }, callback => socket.once('error', callback), 'attached');
}

const HANDLE_OWNER = Symbol('ControlHandleOwner');
const HANDLE_CONSTRUCTION = Symbol('ControlHandleConstruction');
class OwnedHandle {
  constructor(owner) { Object.defineProperty(this, HANDLE_OWNER, {value: owner}); }
  _belongsTo(owner) { return this[HANDLE_OWNER] === owner; }
}

export class OperationHandle extends OwnedHandle {
  constructor(session, id, terminalName, construction) {
    if (construction !== HANDLE_CONSTRUCTION) throw protocolFailure('HANDLE_INVALID', 'Operation handles are created by ControlSession');
    super(session);
    this.session = session;
    this.id = id;
    this.terminalName = terminalName;
    this.outcome = null;
    this.cleanupMode = undefined;
    this.waiters = new Set();
  }
  async status(options) { return this.session._operationStatus(this, options); }
  async wait(options = {}) { return this.session._waitOperation(this, options); }
  _settle(outcome) {
    if (this.outcome) bad('Duplicate operation terminal outcome');
    this.outcome = deepFreeze(outcome);
    for (const waiter of this.waiters) waiter(outcome);
    this.waiters.clear();
    this.session._pruneOperations();
  }
}

export class AuthorizationHandle extends OwnedHandle {
  constructor(session, id, construction) {
    if (construction !== HANDLE_CONSTRUCTION) throw protocolFailure('HANDLE_INVALID', 'Authorization handles are created by ControlSession');
    super(session); this.session = session; this.id = id; Object.freeze(this);
  }
}

export class WorkerReservation extends OwnedHandle {
  constructor(session, descriptor, construction) {
    if (construction !== HANDLE_CONSTRUCTION) throw protocolFailure('HANDLE_INVALID', 'Worker reservations are created by ControlSession');
    super(session);
    this.session = session;
    this.id = descriptor.workerId;
    this.endpoint = Object.freeze({...descriptor.endpoint});
    this.attachmentToken = descriptor.attachmentToken;
    this.attachmentTimeoutMs = descriptor.attachmentTimeoutMs;
    this.releaseMode = descriptor.releaseMode;
    this.releaseOperation = null;
    this.releasePromise = null;
    this.connectPromise = null;
    this.attached = false;
  }
  connect(options = {}) {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = import('./managed-worker.mjs').then(({createManagedWorker}) => createManagedWorker({reservation: this, manifest: options.manifest ?? this.session.manifest, runtime: options.runtime ?? this.session.runtime, ...options}));
    return this.connectPromise;
  }
  release(reason = 'normal', options) { return this.session.releaseWorker(this, reason, options); }
}

export class ControlSession extends OwnedHandle {
  constructor(client, id, openArgs, construction) {
    if (construction !== HANDLE_CONSTRUCTION) throw protocolFailure('HANDLE_INVALID', 'Sessions are created by ControlClient');
    super(client);
    this.client = client;
    this.id = id;
    this.runtime = openArgs.runtime;
    this.manifestJson = openArgs.manifestJson;
    this.manifest = deepFreeze(validateManifest(parseWorkerJson(openArgs.manifestJson, WORKER_LIMITS.manifestBytes)));
    this.operations = new Map();
    this.workers = new Map();
    this.eventHistory = [];
    this.eventHistoryBytes = 0;
    this.eventEmitter = new EventEmitter();
    this.outputChunks = new Map();
    this.closing = false;
    this.cleanupRequest = null;
  }
  _owned(value, Type, label) {
    if (!(value instanceof Type) || !value._belongsTo(this)) throw protocolFailure('HANDLE_INVALID', `Foreign ${label}`);
    return value;
  }
  _registerOperation(result, terminalName) {
    let operation = this.operations.get(result.operationId);
    if (operation) {
      if (operation.terminalName !== terminalName) bad('Operation ID was reused for another operation');
      return operation;
    }
    operation = new OperationHandle(this, result.operationId, terminalName, HANDLE_CONSTRUCTION);
    this.operations.set(operation.id, operation);
    return operation;
  }
  _pruneOperations() {
    const completed = [...this.operations.values()].filter(operation => operation.outcome);
    while (completed.length > 128) {
      const oldest = completed.shift();
      this.operations.delete(oldest.id);
      for (const key of [...this.outputChunks.keys()]) if (key.startsWith(`${oldest.id}:`)) this.outputChunks.delete(key);
    }
  }
  async authoringExec({toolId, arguments: args, cwd = '.'}, options) {
    const result = await this.client._request('authoring.exec', {sessionId: this.id, toolId, arguments: args, cwd}, {...options, session: this, terminalName: 'CommandResult'});
    return this.operations.get(result.operationId);
  }
  async prepare(options) {
    const result = await this.client._request('session.prepare', {sessionId: this.id}, {...options, session: this, terminalName: 'Prepared'});
    return this.operations.get(result.operationId);
  }
  async authorize({preparedRevision, challenge, attestation}, options) {
    const result = await this.client._request('session.authorize', {sessionId: this.id, preparedRevision, challenge, attestation}, options);
    return new AuthorizationHandle(this, result.authorizationId, HANDLE_CONSTRUCTION);
  }
  async acquireWorker(authorization, options) {
    this._owned(authorization, AuthorizationHandle, 'authorization handle');
    const result = await this.client._request('worker.acquire', {sessionId: this.id, authorizationId: authorization.id}, options);
    const reservation = new WorkerReservation(this, result, HANDLE_CONSTRUCTION);
    this.workers.set(reservation.id, reservation);
    return reservation;
  }
  async releaseWorker(reservation, reason = 'normal', options) {
    this._owned(reservation, WorkerReservation, 'worker handle');
    if (reservation.releaseOperation) return reservation.releaseOperation;
    if (!reservation.releasePromise) reservation.releasePromise = (async () => {
      const result = await this.client._request('worker.release', {sessionId: this.id, workerId: reservation.id, reason}, {...options, session: this, terminalName: 'CleanupResult'});
      reservation.releaseOperation = this.operations.get(result.operationId);
      reservation.releaseOperation.cleanupMode = result.cleanupMode;
      return reservation.releaseOperation;
    })();
    return reservation.releasePromise;
  }
  status(options) { return this.client._request('session.status', {sessionId: this.id}, options); }
  async cancel(reason = 'user-cancel', options) {
    if (this.cleanupRequest) return this.cleanupRequest;
    this.closing = true;
    this.cleanupRequest = (async () => {
      const result = await this.client._request('session.cancel', {sessionId: this.id, reason}, {...options, session: this, terminalName: 'CleanupResult'});
      return this.operations.get(result.operationId);
    })();
    return this.cleanupRequest;
  }
  async close(outcomeSummary, options) {
    if (this.cleanupRequest) return this.cleanupRequest;
    this.closing = true;
    const args = {sessionId: this.id};
    if (outcomeSummary !== undefined) args.outcomeSummary = outcomeSummary;
    this.cleanupRequest = (async () => {
      const result = await this.client._request('session.close', args, {...options, session: this, terminalName: 'CleanupResult'});
      return this.operations.get(result.operationId);
    })();
    return this.cleanupRequest;
  }
  onEvent(listener, {replay = true} = {}) {
    if (typeof listener !== 'function') throw protocolFailure('CONTROL_PROTOCOL_ERROR', 'Event listener must be a function');
    if (replay) for (const event of this.eventHistory) listener(event);
    this.eventEmitter.on('event', listener);
    return () => this.eventEmitter.off('event', listener);
  }
  _rememberEvent(event) {
    const size = byteLength(JSON.stringify(event));
    this.eventHistory.push(event); this.eventHistoryBytes += size;
    while (this.eventHistory.length > 256 || this.eventHistoryBytes > CONTROL_LIMITS.pendingOutputBytes) {
      const removed = this.eventHistory.shift(); this.eventHistoryBytes -= byteLength(JSON.stringify(removed));
    }
    this.eventEmitter.emit('event', event);
  }
  async _operationStatus(operation, options) {
    this._owned(operation, OperationHandle, 'operation handle');
    if (operation.outcome) return operation.outcome;
    const result = await this.client._request('operation.status', {sessionId: this.id, operationId: operation.id}, {...options, terminalValidator: TERMINAL_VALIDATORS[operation.terminalName]});
    if (result.operationId !== operation.id) bad('Operation status ID mismatch');
    if (result.status !== 'pending' && !operation.outcome) operation._settle(result);
    return operation.outcome ?? result;
  }
  async _waitOperation(operation, {signal, timeoutMs} = {}) {
    this._owned(operation, OperationHandle, 'operation handle');
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw protocolFailure('CONTROL_PROTOCOL_ERROR', 'Expected an AbortSignal');
    if (signal?.aborted) throw protocolFailure('CONTROL_WAIT_CANCELLED', 'Operation wait was cancelled');
    const status = await this._operationStatus(operation, {signal, timeoutMs: timeoutMs ?? this.client.requestTimeoutMs});
    if (status.status !== 'pending') return status;
    return new Promise((resolve, reject) => {
      let timer;
      const settled = outcome => { cleanup(); resolve(outcome); };
      const aborted = () => { cleanup(); reject(protocolFailure('CONTROL_WAIT_CANCELLED', 'Operation wait was cancelled')); };
      const timedOut = async () => {
        cleanup();
        try {
          const final = await this._operationStatus(operation, {timeoutMs: this.client.requestTimeoutMs});
          if (final.status !== 'pending') resolve(final);
          else reject(protocolFailure('CONTROL_WAIT_TIMEOUT', 'Operation wait deadline exceeded'));
        } catch (error) { reject(error); }
      };
      const cleanup = () => {
        operation.waiters.delete(settled);
        signal?.removeEventListener('abort', aborted);
        clearTimeout(timer);
      };
      operation.waiters.add(settled);
      signal?.addEventListener('abort', aborted, {once: true});
      if (timeoutMs !== undefined) { positive(timeoutMs, 'wait timeout'); timer = setTimeout(timedOut, timeoutMs); }
      if (operation.outcome) settled(operation.outcome);
    });
  }
  _receiveEvent(event) {
    switch (event.event) {
      case 'operation.finished': {
        const operationId = event.data?.operationId;
        const operation = this.operations.get(operationId);
        if (!operation) bad('Event references an unknown operation');
        validateOperationOutcome(event.data, TERMINAL_VALIDATORS[operation.terminalName]);
        if (event.data.status === 'pending') bad('Terminal event reported a pending operation');
        operation._settle(event.data);
        break;
      }
      case 'authoring.output': case 'build.output': {
        validateOutputEvent(event.data);
        const operation = this.operations.get(event.data.operationId);
        if (!operation) bad('Output event references an unknown operation');
        const key = `${event.data.operationId}:${event.data.stream}`;
        const expected = (this.outputChunks.get(key) ?? 0) + 1;
        if (event.data.chunk !== expected) bad('Output event chunk sequence is not contiguous');
        this.outputChunks.set(key, event.data.chunk);
        break;
      }
      case 'worker.started': case 'worker.ready':
        exact(event.data, ['workerId']); handle(event.data.workerId, 'worker ID');
        if (!this.workers.has(event.data.workerId)) bad('Worker event references an unknown worker');
        break;
      case 'worker.exited':
        exact(event.data, ['workerId', 'reason'], ['exitCode']); handle(event.data.workerId, 'worker ID'); validateReason(event.data.reason);
        if (event.data.exitCode !== undefined) safeInteger(event.data.exitCode, 'exit code');
        if (!this.workers.has(event.data.workerId)) bad('Worker event references an unknown worker');
        break;
      case 'worker.closing':
        exact(event.data, ['workerId', 'reason']); handle(event.data.workerId, 'worker ID'); validateReason(event.data.reason);
        if (!this.workers.has(event.data.workerId)) bad('Worker event references an unknown worker');
        break;
      case 'session.closed': validateCleanupResult(event.data); break;
      default: bad('Unknown control event');
    }
    this._rememberEvent(deepFreeze(event));
  }
}

export class ControlClient {
  static async launch({controller, ...options}) {
    validateLaunchOptions(controller);
    const checked = prepareClientOptions(options);
    const child = spawn(controller.command, controller.args, {cwd: controller.cwd, env: controller.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false});
    let exited = false;
    let killTimer;
    const closed = new Promise(resolve => child.once('close', (code, signal) => { exited = true; clearTimeout(killTimer); resolve({code, signal}); }));
    const transport = streamTransport(
      child.stdout,
      child.stdin,
      closed,
      () => {
        if (!exited) {
          child.stdin.destroy();
          child.kill('SIGTERM');
          killTimer ??= setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, Math.min(1_000, checked.closeTimeoutMs));
        }
        return closed;
      },
      callback => { child.once('error', callback); child.once('exit', (code, signal) => callback(protocolFailure('CONTROL_DISCONNECTED', `Controller exited (${signal ?? code})`))); },
      'owned',
    );
    let client;
    try {
      client = new ControlClient(transport, checked);
      let stderrBytes = 0;
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes > checked.stderrLimit) client._fatal(protocolFailure('CONTROL_LIMIT_EXCEEDED', 'Controller stderr limit exceeded'));
        else if (checked.onStderr) {
          try { checked.onStderr(chunk); } catch { client._fatal(protocolFailure('CONTROL_APPLICATION_ERROR', 'Controller log consumer failed')); }
        }
      });
      await client._hello();
      return client;
    } catch (error) {
      if (client) { client._fatal(error); await client._stop().catch(() => {}); }
      else {
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, Math.min(1_000, checked.closeTimeoutMs));
        await closed;
      }
      throw error;
    }
  }
  static async connectUnix({socketPath, ...options}) {
    const checked = prepareClientOptions(options);
    const transport = await connectSocket(socketPath, checked.helloTimeoutMs);
    const client = new ControlClient(transport, checked);
    try { await client._hello(); return client; }
    catch (error) { client._fatal(error); await client._stop().catch(() => {}); throw error; }
  }
  static async fromTransport(transport, options = {}) {
    const checked = prepareClientOptions(options);
    if (!transport?.readable || !transport.writable || typeof transport.stop !== 'function' || typeof transport.closed?.then !== 'function') bad('Invalid control transport');
    const client = new ControlClient({...transport, ownership: transport.ownership ?? 'attached'}, checked);
    try { await client._hello(); return client; }
    catch (error) { client._fatal(error); await client._stop().catch(() => {}); throw error; }
  }
  constructor(transport, checked) {
    Object.assign(this, checked);
    this.transport = transport;
    this.nextId = 1;
    this.nextEventSeq = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.terminalError = null;
    this.closing = false;
    this.closePromise = null;
    this.stopPromise = null;
    this.hello = null;
    this.decoder = new ControlFrameDecoder(message => this._receive(message));
    transport.readable.on('data', chunk => { try { this.decoder.push(chunk); } catch (error) { this._fatal(error); } });
    transport.readable.on('error', error => this._fatal(protocolFailure('CONTROL_DISCONNECTED', error.message, {cause: error})));
    transport.readable.on('end', () => {
      try { this.decoder.end(); } catch (error) { this._fatal(error); return; }
      if (!this.closing || this.pending.size) this._fatal(protocolFailure('CONTROL_DISCONNECTED', 'Control channel reached EOF'));
    });
    transport.writable.on('error', error => this._fatal(protocolFailure('CONTROL_DISCONNECTED', error.message, {cause: error})));
    transport.onClose?.(error => { if (!this.closing || this.pending.size) this._fatal(error instanceof Error ? error : protocolFailure('CONTROL_DISCONNECTED', 'Control transport closed')); });
  }
  async _hello() {
    this.hello = deepFreeze(await this._request('hello', {controlVersions: [1], requiredCapabilities: [...this.requiredCapabilities]}, {timeoutMs: this.helloTimeoutMs, bootstrap: true}));
    this.maxInflightRequests = Math.min(CONTROL_LIMITS.inflightRequests, this.hello.limits.maxInflightRequestsPerConnection);
    this.maxPendingOutputBytes = Math.min(CONTROL_LIMITS.pendingOutputBytes, this.hello.limits.maxPendingOutputBytes);
  }
  async openSession(args, options) {
    // Snapshot and validate the exact inner manifest before any session mutation.
    try { validateArgs('session.open', args); validateManifest(parseWorkerJson(args?.manifestJson, WORKER_LIMITS.manifestBytes)); }
    catch (error) { throw protocolFailure('CONTROL_ARGUMENT_INVALID', 'Invalid public manifest', {cause: error}); }
    const snapshot = deepFreeze(parseControlJson(JSON.stringify(args)));
    const result = await this._request('session.open', snapshot, options);
    if (this.sessions.has(result.sessionId)) bad('Session ID was reused');
    const session = new ControlSession(this, result.sessionId, snapshot, HANDLE_CONSTRUCTION);
    this.sessions.set(session.id, session);
    return session;
  }
  _request(op, args, {signal, timeoutMs = this.requestTimeoutMs, session, terminalName, terminalValidator, bootstrap = false} = {}) {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closing) return Promise.reject(protocolFailure('CONTROL_DISCONNECTED', 'Control client is closing'));
    if (this.pending.size >= (this.maxInflightRequests ?? CONTROL_LIMITS.inflightRequests)) return Promise.reject(protocolFailure('CONTROL_LIMIT_EXCEEDED', 'Too many in-flight control requests'));
    if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(protocolFailure('CONTROL_PROTOCOL_ERROR', 'Expected an AbortSignal'));
    if (signal?.aborted) return Promise.reject(protocolFailure('CONTROL_REQUEST_CANCELLED', 'Control request cancelled before dispatch'));
    try { positive(timeoutMs, 'request timeout'); validateArgs(op, args); } catch (error) { return Promise.reject(error); }
    if (!safePositive(this.nextId)) return Promise.reject(protocolFailure('CONTROL_LIMIT_EXCEEDED', 'Request ID space exhausted'));
    const request = {v: 1, kind: 'request', id: this.nextId++, op, args};
    let encoded;
    try { encoded = controlFrame(request); } catch (error) { return Promise.reject(error); }
    if ((this.transport.writable.writableLength ?? 0) + encoded.length > (this.maxPendingOutputBytes ?? CONTROL_LIMITS.pendingOutputBytes)) {
      const error = protocolFailure('CONTROL_LIMIT_EXCEEDED', 'Pending control output limit exceeded'); this._fatal(error); return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const entry = {request, resolve, reject, signal, abort: null, timer: null, session, terminalName, terminalValidator, bootstrap};
      this.pending.set(request.id, entry);
      entry.abort = () => this._fatal(protocolFailure('CONTROL_REQUEST_CANCELLED', 'Control request result became uncertain'));
      signal?.addEventListener('abort', entry.abort, {once: true});
      entry.timer = setTimeout(() => this._fatal(protocolFailure(bootstrap ? 'CONTROL_HANDSHAKE_TIMEOUT' : 'CONTROL_REQUEST_TIMEOUT', 'Control request acknowledgement deadline exceeded')), timeoutMs);
      try { this.transport.writable.write(encoded); }
      catch (error) { this._fatal(protocolFailure('CONTROL_DISCONNECTED', error.message, {cause: error})); }
    });
  }
  _settle(entry, error, value) {
    clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort); this.pending.delete(entry.request.id);
    if (error) entry.reject(error); else entry.resolve(value);
  }
  _receive(message) {
    if (message.kind === 'event') { validateControlEventEnvelope(message); this._receiveEvent(message); return; }
    if (!object(message) || message.kind !== 'response') bad('Unexpected control envelope kind');
    if (message.ok === true) exact(message, ['v', 'kind', 'id', 'ok', 'result']);
    else if (message.ok === false) exact(message, ['v', 'kind', 'id', 'ok', 'error']);
    else bad('Invalid control response status');
    if (message.v !== 1) bad('Unsupported control response version');
    positive(message.id, 'response ID');
    const entry = this.pending.get(message.id);
    if (!entry) bad('Unsolicited or incorrectly correlated control response');
    if (message.ok === false) {
      validateControlError(message.error);
      this._settle(entry, new ControlError(message.error));
      return;
    }
    if (message.ok !== true) bad('Invalid control response status');
    const result = validateResult(entry.request.op, message.result, {requiredCapabilities: this.requiredCapabilities, terminalValidator: entry.terminalValidator, operationId: entry.request.args.operationId});
    if (entry.session && entry.terminalName) entry.session._registerOperation(result, entry.terminalName);
    this._settle(entry, null, result);
  }
  _receiveEvent(message) {
    positive(message.seq, 'event sequence');
    if (message.seq !== this.nextEventSeq) bad('Control event sequence is not contiguous');
    this.nextEventSeq++;
    handle(message.sessionId, 'event session ID');
    oneOf(message.event, EVENT_NAMES, 'event name');
    const session = this.sessions.get(message.sessionId);
    if (!session) bad('Control event references an unknown session');
    session._receiveEvent(message);
  }
  _fatal(error) {
    if (this.terminalError) return;
    this.terminalError = error instanceof Error ? error : protocolFailure('CONTROL_DISCONNECTED', 'Control transport failed');
    for (const entry of [...this.pending.values()]) this._settle(entry, this.terminalError);
    for (const session of this.sessions.values()) for (const operation of session.operations.values()) {
      for (const waiter of operation.waiters) waiter(Promise.reject(this.terminalError));
      operation.waiters.clear();
    }
    this._stop().catch(() => {});
  }
  _stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = Promise.resolve().then(() => this.transport.stop()).then(() => this.transport.closed);
    return this.stopPromise;
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      try { this.transport.writable.end(); } catch {}
      let timer;
      try {
        await Promise.race([
          this.transport.closed,
          new Promise((_, reject) => { timer = setTimeout(() => reject(protocolFailure('CONTROL_CLEANUP_TIMEOUT', 'Control transport cleanup deadline exceeded')), this.closeTimeoutMs); }),
        ]);
      } catch (error) {
        try { await this._stop(); } catch {}
        throw error;
      } finally { clearTimeout(timer); }
    })();
    return this.closePromise;
  }
  dispose() { return this.close(); }
}

export const __testing = Object.freeze({
  validateArgs,
  validateResult,
  validateControlError,
  validateOperationOutcome,
  verifyUnixSocketPath,
  makeWorkerReservation: (session, descriptor) => new WorkerReservation(session, descriptor, HANDLE_CONSTRUCTION),
});
