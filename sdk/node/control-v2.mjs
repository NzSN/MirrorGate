// Hosting control v2 reuses frozen v1 codecs for unchanged records and framing.
import {
  ControlProtocolError, controlFrame, validateControlRequest as requestV1,
  validateControlResponse as responseV1, validateControlEvent as eventV1,
  validateOperationRecord,
} from './control.mjs';

export const HOSTING_CAPABILITY = 'hosting.fresh-agent-v1';
export const HOSTING_LIMITS = Object.freeze({wallMs: 300_000, stdoutBytes: 1_048_576,
  stderrBytes: 1_048_576, progressRecords: 256, progressBytes: 262_144, progressRecordBytes: 16_384});
const HANDLE = /^[0-9a-f]{32}$/;
const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const REASONS = new Set(['normal', 'user-cancel', 'deadline', 'client-failure', 'worker-failure']);
const RUN_PHASES = new Set(['starting', 'running', 'submitting', 'cleaning', 'finished']);
const OUTCOMES = new Set(['submitted', 'failed', 'cancelled', 'timedOut']);
const fail = message => { throw new ControlProtocolError('CONTROL_PROTOCOL_ERROR', message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
function exact(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('Invalid hosting record fields');
}
function text(value, limit, nonempty = true) {
  if (typeof value !== 'string' || (nonempty && value.length === 0) || Buffer.byteLength(value) > limit ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail('Invalid hosting text');
}
function handle(value) { if (typeof value !== 'string' || !HANDLE.test(value)) fail('Invalid hosting handle'); }
function bounds(value) { controlFrame(value); }

export function validatePublicTask(value) {
  bounds(value);
  exact(value, ['instructions', 'files']); text(value.instructions, 65_536);
  if (!Array.isArray(value.files) || value.files.length > 128) fail('Invalid public file count');
  const paths = new Set();
  let bytes = 0;
  for (const file of value.files) {
    exact(file, ['path', 'text']); text(file.path, 1_024); text(file.text, 262_144, false);
    const parts = file.path.split('/');
    if (file.path.includes('\\') || file.path.includes('\0') || parts.some(part => ['', '.', '..'].includes(part)) ||
        parts[0] === '.mirrorgate' || paths.has(file.path) ||
        [...paths].some(path => file.path.startsWith(`${path}/`) || path.startsWith(`${file.path}/`))) fail('Invalid or colliding public file path');
    paths.add(file.path); bytes += Buffer.byteLength(file.text);
    if (bytes > 262_144) fail('Public files exceed aggregate text bound');
  }
  return value;
}

export function validateHostingLimits(value, {complete = false} = {}) {
  exact(value, complete ? Object.keys(HOSTING_LIMITS) : [], complete ? [] : Object.keys(HOSTING_LIMITS));
  for (const [key, limit] of Object.entries(value)) if (!positive(limit) || limit > HOSTING_LIMITS[key]) fail('Invalid hosting limit');
  return value;
}

export function validateHostingError(value) {
  exact(value, ['code', 'stage', 'message'], ['operationId']);
  const substitute = {...value};
  if (['AGENT_START_FAILED', 'AGENT_EXITED', 'AUDIT_UNAVAILABLE'].includes(substitute.code)) substitute.code = 'STATE_INVALID';
  if (substitute.stage === 'hosting') substitute.stage = 'authoring';
  responseV1({v: 1, kind: 'response', id: 1, ok: false, error: substitute});
  return value;
}

export function validateHostedRun(value) {
  bounds(value);
  exact(value, ['runId', 'phase', 'cleanup', 'limits', 'progress'], ['outcome', 'submission', 'error']);
  handle(value.runId);
  if (!RUN_PHASES.has(value.phase)) fail('Invalid hosted phase');
  validateHostingLimits(value.limits, {complete: true});
  exact(value.cleanup, ['status', 'remainingResources']);
  const expectedCleanup = {starting: ['notStarted'], running: ['notStarted'], submitting: ['notStarted'],
    cleaning: ['pending'], finished: ['succeeded', 'failed']}[value.phase];
  if (!expectedCleanup.includes(value.cleanup.status)) fail('Hosted cleanup disagrees with phase');
  const remaining = value.cleanup.remainingResources;
  if (!Array.isArray(remaining) || remaining.length > 64 || remaining.some(id => typeof id !== 'string' || !ID.test(id)) ||
      new Set(remaining).size !== remaining.length ||
      (['notStarted', 'succeeded'].includes(value.cleanup.status) && remaining.length)) fail('Invalid hosted remaining resources');
  const terminal = ['cleaning', 'finished'].includes(value.phase);
  if (terminal !== Object.hasOwn(value, 'outcome') || (terminal && !OUTCOMES.has(value.outcome))) fail('Hosted outcome disagrees with phase');
  if ((value.outcome === 'submitted') !== Object.hasOwn(value, 'submission')) fail('Hosted submission disagrees with outcome');
  if (value.submission !== undefined) {
    exact(value.submission, ['submissionId', 'sourceHash', 'sourceRevision']);
    handle(value.submission.submissionId);
    if (typeof value.submission.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.submission.sourceHash) ||
        value.submission.sourceRevision !== 1) fail('Invalid committed submission');
  }
  if (['failed', 'cancelled', 'timedOut'].includes(value.outcome) !== Object.hasOwn(value, 'error')) fail('Hosted error disagrees with outcome');
  if (value.error !== undefined) validateHostingError(value.error);
  const p = value.progress;
  exact(p, ['firstSeq', 'nextSeq', 'truncated', 'records']);
  if (!positive(p.firstSeq) || !positive(p.nextSeq) || p.truncated !== (p.firstSeq > 1) ||
      !Array.isArray(p.records) || p.records.length > value.limits.progressRecords ||
      p.nextSeq !== p.firstSeq + p.records.length) fail('Invalid hosted progress window');
  let bytes = 0;
  for (let i = 0; i < p.records.length; i++) {
    const record = p.records[i];
    exact(record, ['seq', 'message']);
    if (record.seq !== p.firstSeq + i) fail('Noncontiguous hosted progress');
    text(record.message, value.limits.progressRecordBytes, false);
    const size = controlFrame(record).length - 1;
    if (size > value.limits.progressRecordBytes) fail('Hosted progress record exceeds encoded byte bound');
    bytes += size;
  }
  if (bytes > value.limits.progressBytes) fail('Hosted progress exceeds encoded byte bound');
  return value;
}

export function validateControlV2Request(message) {
  bounds(message);
  exact(message, ['v', 'kind', 'id', 'op', 'args']);
  if (message.op === 'hello') return requestV1(message);
  if (message.v !== 2 || message.kind !== 'request' || !positive(message.id)) fail('Invalid v2 request envelope');
  if (!['agent.start', 'agent.status', 'agent.cancel'].includes(message.op)) {
    requestV1({...message, v: 1}); return message;
  }
  const args = message.args;
  if (message.op === 'agent.start') {
    exact(args, ['sessionId', 'profileId', 'publicTask'], ['limits']);
    if (typeof args.profileId !== 'string' || !ID.test(args.profileId)) fail('Invalid hosting profile');
    validatePublicTask(args.publicTask);
    if (args.limits !== undefined) validateHostingLimits(args.limits);
  } else if (message.op === 'agent.status') exact(args, ['sessionId'], ['runId']);
  else { exact(args, ['sessionId', 'runId', 'reason']); if (!REASONS.has(args.reason)) fail('Invalid cancellation reason'); }
  handle(args.sessionId);
  if (Object.hasOwn(args, 'runId')) handle(args.runId);
  return message;
}

export function validateControlV2Response(message, {request, operation, terminalValidator} = {}) {
  bounds(message);
  if (!request) fail('V2 response requires its originating request');
  validateControlV2Request(request);
  if (message.ok === true) exact(message, ['v', 'kind', 'id', 'ok', 'result']);
  else if (message.ok === false) exact(message, ['v', 'kind', 'id', 'ok', 'error']);
  else fail('Invalid v2 response status');
  if (message.v !== (request.op === 'hello' ? 1 : 2) || message.kind !== 'response' || message.id !== request.id) fail('Uncorrelated v2 response');
  if (!message.ok) { validateHostingError(message.error); return message; }
  const result = message.result;
  if (request.op === 'hello') {
    if (!object(result) || ![1, 2].includes(result.controlVersion) ||
        !request.args.controlVersions.includes(result.controlVersion)) fail('Selected control version was not offered');
    responseV1({...message, result: {...result, controlVersion: 1}}, {request});
    if (result.controlVersion === 1 && result.capabilities.some(cap => cap.id.startsWith('hosting.'))) fail('V1 hello exposes hosting capabilities');
  } else if (request.op === 'agent.start') { exact(result, ['runId']); handle(result.runId); }
  else if (request.op === 'agent.status' || request.op === 'agent.cancel') {
    exact(result, ['run']);
    if (result.run === null) {
      if (request.op !== 'agent.status' || Object.hasOwn(request.args, 'runId')) fail('Explicit hosted run cannot be absent');
    } else {
      validateHostedRun(result.run);
      if (request.args.runId !== undefined && result.run.runId !== request.args.runId) fail('Hosted run correlation mismatch');
      if (request.op === 'agent.cancel' && result.run.phase !== 'finished') fail('Cancel must join terminal host cleanup');
    }
  } else {
    const legacyResult = request.op === 'session.status' && result?.phase === 'submitted'
      ? {...result, phase: 'authoring'} : result;
    responseV1({...message, v: 1, result: legacyResult}, {request: {...request, v: 1}, operation, terminalValidator});
    if (request.op === 'session.status' && result.phase === 'submitted' && result.cleanup.status !== 'notStarted') fail('Submitted session is already closing');
  }
  return message;
}

export function validateControlV2Event(message, context = {}) {
  bounds(message);
  exact(message, ['v', 'kind', 'seq', 'sessionId', 'event', 'data']);
  if (message.v !== 2 || message.kind !== 'event' || !positive(message.seq)) fail('Invalid v2 event envelope');
  handle(message.sessionId);
  if (message.event === 'agent.updated' || message.event === 'agent.finished') {
    exact(message.data, ['run']); validateHostedRun(message.data.run);
    if ((message.data.run.phase === 'finished') !== (message.event === 'agent.finished')) fail('Hosted event disagrees with phase');
  } else eventV1({...message, v: 1}, context);
  return message;
}

export {validateOperationRecord};
