import {randomBytes} from 'node:crypto';
import {ControlError, ControlProtocolError, parseControlJson} from '../../sdk/node/control.mjs';
import {HOSTING_CAPABILITY, validateControlV2Request} from '../../sdk/node/control-v2.mjs';

const TASK = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const RUN = /^run_[0-9a-f]{32}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function exact(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new HostingToolError('INVALID_ARGUMENT');
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export class HostingToolError extends Error {
  constructor(code, runRef) { super(code); this.name = 'HostingToolError'; this.code = code; if (runRef) this.runRef = runRef; }
}

const refSchema = field => ({type: 'object', properties: {[field]: {type: 'string', pattern: field === 'taskRef' ? TASK.source : RUN.source}}, required: [field], additionalProperties: false});
export const HOSTING_TOOLS = freeze([
  {name: 'hosting_start', description: 'Start a restricted implementer for an operator-approved task.', inputSchema: refSchema('taskRef')},
  {name: 'hosting_status', description: 'Inspect a run, or recover its reference after a lost start reply.', inputSchema: {type: 'object', oneOf: [refSchema('runRef'), refSchema('taskRef')]}},
  {name: 'hosting_cancel', description: 'Cancel implementation work and join its cleanup.', inputSchema: refSchema('runRef')},
]);

export function validateApprovedTasks(tasks) {
  if (!object(tasks) || Object.keys(tasks).length === 0 || Object.keys(tasks).length > 128) throw new HostingToolError('INVALID_CONFIGURATION');
  for (const [ref, task] of Object.entries(tasks)) {
    if (!TASK.test(ref)) throw new HostingToolError('INVALID_CONFIGURATION');
    exact(task, ['session', 'agent']);
    validateControlV2Request({v: 2, kind: 'request', id: 1, op: 'session.open', args: task.session});
    if (task.session.submission.kind !== 'source' || task.session.submission.authoring !== true) throw new HostingToolError('INVALID_CONFIGURATION');
    exact(task.agent, ['profileId', 'publicTask'], ['limits']);
    validateControlV2Request({v: 2, kind: 'request', id: 1, op: 'agent.start', args: {sessionId: '0'.repeat(32), ...task.agent}});
  }
  return freeze(parseControlJson(JSON.stringify(tasks)));
}

function publicStatus(record) {
  const hosted = record.run?.latest ?? record.hosting;
  const result = {runRef: record.runRef, taskRef: record.taskRef, phase: hosted?.phase ?? record.phase};
  if (hosted) {
    result.cleanup = {status: hosted.cleanup.status, remainingResourceCount: hosted.cleanup.remainingResources.length};
    if (hosted.outcome) result.outcome = hosted.outcome;
    if (hosted.submission) result.submission = {sourceHash: hosted.submission.sourceHash, sourceRevision: hosted.submission.sourceRevision};
    // Gate progress is already public. Tighten it for the coordinator's tool.
    const records = []; let bytes = 0;
    for (const record of [...hosted.progress.records].reverse()) {
      const size = Buffer.byteLength(JSON.stringify(record));
      if (size > 4096 || bytes + size > 16_384 || records.length >= 32) break;
      records.unshift({...record}); bytes += size;
    }
    result.progress = {firstSeq: records[0]?.seq ?? hosted.progress.nextSeq, nextSeq: hosted.progress.nextSeq,
      truncated: hosted.progress.truncated || records.length !== hosted.progress.records.length, records};
    if (hosted.error) result.failure = {code: 'HOSTING_FAILED'};
  }
  if (record.failure) result.failure = {code: record.failure};
  if (record.evaluationPhase) result.evaluation = {phase: record.evaluationPhase};
  if (record.cleanup) result.sessionCleanup = {status: record.cleanup.status};
  return freeze(result);
}

/** One dedicated owner connection per task, retained through trusted evaluation. */
export function createHostingTool({connect, tasks, onSubmitted, maxRuns = 16}) {
  if (typeof connect !== 'function' || (onSubmitted !== undefined && typeof onSubmitted !== 'function') ||
      !Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 128) throw new HostingToolError('INVALID_CONFIGURATION');
  const approved = validateApprovedTasks(tasks);
  const runs = new Map(), taskRuns = new Map();
  let closed = false, closePromise;

  function lookup(args, allowTask = false) {
    if (allowTask && object(args) && Object.hasOwn(args, 'taskRef')) {
      exact(args, ['taskRef']);
      if (typeof args.taskRef !== 'string' || !Object.hasOwn(approved, args.taskRef)) throw new HostingToolError('TASK_UNKNOWN');
      const record = taskRuns.get(args.taskRef);
      if (!record) throw new HostingToolError('RUN_NOT_STARTED');
      return record;
    }
    exact(args, ['runRef']);
    if (typeof args.runRef !== 'string' || !RUN.test(args.runRef) || !runs.has(args.runRef)) throw new HostingToolError('RUN_UNKNOWN');
    return runs.get(args.runRef);
  }

  function cleanup(record, reason = 'normal') {
    if (record.cleanupPromise) return record.cleanupPromise;
    record.cleanupPromise = (async () => {
      let failure;
      if (record.evaluationRunning) {
        let timer;
        const settled = await Promise.race([record.evaluationDone.then(() => true),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), 7_000); })]);
        clearTimeout(timer);
        if (!settled) failure = new Error('Trusted callback cleanup did not settle');
      }
      if (record.claimedCleanup?.status === 'failed') failure ??= new Error('Trusted integration reported unconfirmed cleanup');
      if (record.session && !record.claimedCleanup) {
        try {
          const op = reason === 'normal' ? await record.session.close() : await record.session.cancel(reason);
          const outcome = await op.wait({timeoutMs: 7_000});
          if (outcome.status !== 'succeeded' || outcome.result.cleanupStatus !== 'succeeded') failure = new Error('Session cleanup unconfirmed');
        } catch (error) { failure = error; }
      }
      try { await record.client?.close(); } catch (error) { failure ??= error; }
      record.cleanup = {status: failure ? 'failed' : 'succeeded'};
      if (failure) record.cleanupError = failure;
      return record.cleanup;
    })();
    return record.cleanupPromise;
  }

  async function monitor(record) {
    try {
      record.hosting = await record.run.wait();
      if (record.hosting.outcome === 'submitted' && record.hosting.cleanup.status === 'succeeded' && !record.cancelRequested) {
        if (onSubmitted) {
          record.evaluationPhase = 'running';
          record.evaluationRunning = true;
          record.evaluationDone = new Promise(resolve => { record.resolveEvaluationDone = resolve; });
          try {
            record.result = await onSubmitted({client: record.client, session: record.session, run: record.hosting,
              taskRef: record.taskRef, signal: record.abort.signal,
              completeCleanup(receipt) {
                exact(receipt, ['status']);
                if (!['succeeded', 'failed'].includes(receipt.status) || record.claimedCleanup || !record.evaluationRunning) {
                  throw new HostingToolError('INVALID_CLEANUP_HANDOFF');
                }
                record.claimedCleanup = Object.freeze({status: receipt.status});
              },
            });
            record.evaluationPhase = record.cancelRequested ? 'cancelled' : 'finished';
          } catch (error) {
            record.error = error;
            record.evaluationPhase = record.cancelRequested ? 'cancelled' : 'failed';
          } finally {
            record.evaluationRunning = false; record.resolveEvaluationDone();
            await cleanup(record, record.cancelRequested ? 'user-cancel' : 'normal');
          }
        }
        // With no callback, retain submitted source for trusted local handoff.
      } else await cleanup(record, record.cancelRequested ? 'user-cancel' : 'client-failure');
    } catch (error) {
      record.error = error; record.failure = 'HOSTING_FAILED';
      await cleanup(record, 'client-failure');
    } finally {
      record.resolveCompletion({hosting: record.hosting, result: record.result, error: record.error, cleanup: record.cleanup});
    }
  }

  async function start(args) {
    exact(args, ['taskRef']);
    if (closed) throw new HostingToolError('ADAPTER_CLOSED');
    if (typeof args.taskRef !== 'string' || !Object.hasOwn(approved, args.taskRef)) throw new HostingToolError('TASK_UNKNOWN');
    if (taskRuns.has(args.taskRef)) throw new HostingToolError('TASK_ALREADY_STARTED', taskRuns.get(args.taskRef).runRef);
    if (runs.size >= maxRuns) throw new HostingToolError('RUN_LIMIT');
    const record = {taskRef: args.taskRef, runRef: `run_${randomBytes(16).toString('hex')}`, phase: 'starting', abort: new AbortController(), cancelRequested: false};
    record.ready = new Promise(resolve => { record.resolveReady = resolve; });
    record.completion = new Promise(resolve => { record.resolveCompletion = resolve; });
    runs.set(record.runRef, record); taskRuns.set(record.taskRef, record);
    try {
      record.client = await connect();
      if (record.client.hello?.controlVersion !== 2 || !record.client.hello.capabilities.some(cap => cap.id === HOSTING_CAPABILITY && cap.available)) throw new Error('Hosting capability unavailable');
      if (closed || record.cancelRequested) throw new Error('Adapter closed during start');
      const task = approved[record.taskRef];
      record.session = await record.client.openSession(task.session);
      if (closed || record.cancelRequested) throw new Error('Adapter closed during session allocation');
      record.run = await record.session.startAgent(task.agent);
      record.monitor = monitor(record);
      return {...publicStatus(record), accepted: true};
    } catch (error) {
      record.error = error; record.phase = 'finished'; record.failure = 'START_FAILED';
      await cleanup(record, 'client-failure');
      record.resolveCompletion({error, cleanup: record.cleanup});
      throw new HostingToolError('START_FAILED', record.runRef);
    } finally { record.resolveReady(); }
  }

  async function status(args) {
    const record = lookup(args, true);
    if (record.run && !record.cleanup && record.run.latest?.phase !== 'finished') {
      try { record.hosting = await record.run.status(); }
      catch { record.failure = 'HOSTING_FAILED'; }
    }
    return publicStatus(record);
  }

  async function cancel(args) {
    const record = lookup(args);
    record.cancelRequested = true; record.abort.abort(new Error('Implementation cancelled'));
    await record.ready;
    if (!record.cancelPromise) record.cancelPromise = (async () => {
      try { if (record.run && !record.cleanup && record.run.latest?.phase !== 'finished') record.hosting = await record.run.cancel('user-cancel'); }
      catch { record.failure = 'CANCELLATION_UNCONFIRMED'; }
      await cleanup(record, 'user-cancel');
      return publicStatus(record);
    })();
    return record.cancelPromise;
  }

  return Object.freeze({
    tools: HOSTING_TOOLS,
    async call(name, args) {
      if (name === 'hosting_start') return start(args);
      if (name === 'hosting_status') return status(args);
      if (name === 'hosting_cancel') return cancel(args);
      throw new HostingToolError('TOOL_UNKNOWN');
    },
    completion(runRef) { return lookup({runRef}).completion; },
    close() {
      if (!closePromise) {
        closed = true;
        closePromise = Promise.all([...runs.values()].map(record => cancel({runRef: record.runRef})))
          .then(() => ({cleanupStatus: [...runs.values()].some(record => record.cleanup?.status !== 'succeeded') ? 'failed' : 'succeeded'}));
      }
      return closePromise;
    },
  });
}

export function publicToolError(error) {
  if (error instanceof HostingToolError) return {code: error.code, ...(error.runRef ? {runRef: error.runRef} : {})};
  if (error instanceof ControlError || error instanceof ControlProtocolError) return {code: 'HOSTING_UNAVAILABLE'};
  return {code: 'TOOL_FAILED'};
}
