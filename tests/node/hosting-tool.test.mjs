import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createHostingTool, serveHostingToolMcp} from '../../integrations/agent-host/index.mjs';
import {HOSTING_CAPABILITY, HOSTING_LIMITS} from '../../sdk/node/control-v2.mjs';
import {manifest} from './helpers.mjs';

const approved = {counter: {session: {policyId: 'default', submission: {kind: 'source', input: {rootId: 'source', relativePath: 'counter'}, buildPlanId: 'node-build', authoring: true}, runtime: 'node-v1', manifestJson: JSON.stringify(manifest)}, agent: {profileId: 'restricted-codex', publicTask: {instructions: 'Approved Counter instructions', files: [{path: 'contract.txt', text: 'Only public operations.'}]}}}};
function fixture({onSubmitted, capability = true, failed = false, waiting = false} = {}) {
  const counts = {connect: 0, open: 0, start: 0, cancel: 0, close: 0, sessionCleanup: 0};
  const run = {runId: '3'.repeat(32), phase: 'finished', outcome: failed ? 'failed' : 'submitted', cleanup: {status: 'succeeded', remainingResources: []}, limits: {...HOSTING_LIMITS}, progress: {firstSeq: 1, nextSeq: 2, truncated: false, records: [{seq: 1, message: 'Submission received.'}]},
    ...(failed ? {error: {code: 'AGENT_EXITED', stage: 'hosting', message: 'PRIVATE-CONTROLLER-DIAGNOSTIC'}} : {submission: {submissionId: '4'.repeat(32), sourceHash: 'a'.repeat(64), sourceRevision: 1}})};
  let cleanupPromise;
  const cleanup = () => { cleanupPromise ??= (counts.sessionCleanup++, Promise.resolve({wait: async () => ({status: 'succeeded', result: {cleanupStatus: 'succeeded'}})})); return cleanupPromise; };
  let finish;
  const hosted = waiting ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(run);
  const handle = {id: run.runId, latest: waiting ? {...run, phase: 'running', outcome: undefined, submission: undefined,
    cleanup: {status: 'notStarted', remainingResources: []}} : run,
    status: async () => handle.latest, wait: async () => hosted,
    cancel: async () => {
      counts.cancel++;
      if (waiting) {
        handle.latest = {...run, outcome: 'cancelled', submission: undefined,
          error: {code: 'CANCELLED', stage: 'hosting', message: 'PRIVATE-CANCELLATION-DETAIL'}};
        finish(handle.latest);
      }
      return handle.latest;
    }};
  const session = {id: '2'.repeat(32), startAgent: async args => { assert.deepEqual(args, approved.counter.agent); counts.start++; return handle; }, close: cleanup, cancel: cleanup};
  const client = {hello: {controlVersion: 2, capabilities: [{id: HOSTING_CAPABILITY, available: capability}]},
    openSession: async args => { assert.deepEqual(args, approved.counter.session); counts.open++; return session; },
    close: async () => { counts.close++; }};
  const tool = createHostingTool({tasks: approved, connect: async () => { counts.connect++; return client; }, onSubmitted});
  return {tool, counts, client, session, run};
}

function dispatcher(t, tool) {
  const input = new PassThrough(), output = new PassThrough();
  const server = serveHostingToolMcp(tool, {input, output});
  let buffer = '', id = 0;
  const pending = new Map(); const transcript = [];
  output.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      transcript.push(value); pending.get(value.id)?.(value); pending.delete(value.id);
    }
  });
  const request = (method, params, explicitId) => new Promise(resolve => {
    const requestId = explicitId ?? ++id; pending.set(requestId, resolve);
    input.write(`${JSON.stringify({jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : {params})})}\n`);
  });
  t.after(async () => { await server.close(); input.destroy(); output.destroy(); });
  return {input, server, request, transcript};
}
async function initialize(rpc) {
  const result = await rpc.request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'synthetic-coordinator', version: '1', title: 'Synthetic coordinator'}, _meta: {}});
  assert.equal(result.result.serverInfo.name, 'mirrorgate-hosting-tool');
}
const callResult = response => JSON.parse(response.result.content[0].text);

test('real Codex initialization and tools/list progress metadata register the hosting tools', async t => {
  const {tool, counts} = fixture(); const rpc = dispatcher(t, tool);
  // Exact initialization/list parameters captured from the outside Codex client.
  const initialization = await rpc.request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {elicitation: {form: {}, url: {}}},
    clientInfo: {name: 'codex-mcp-client', title: 'Codex', version: '0.153.4'},
  }, 0);
  assert.equal(initialization.id, 0);
  assert.equal(initialization.result.serverInfo.name, 'mirrorgate-hosting-tool');
  rpc.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const listed = await rpc.request('tools/list', {_meta: {progressToken: 0}}, 1);
  assert.equal(listed.id, 1);
  assert.equal(listed.error, undefined);
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['hosting_start', 'hosting_status', 'hosting_cancel']);
  assert.equal(counts.connect, 0, 'listing metadata cannot allocate a Gate owner');
});

test('tools/list permits inert metadata objects but rejects malformed metadata and unsupported arguments', async t => {
  const {tool, counts} = fixture(); const rpc = dispatcher(t, tool); await initialize(rpc);
  for (const params of [undefined, {}, {_meta: {}}, {_meta: {progressToken: 'list-1', clientExtension: {inert: true}}}]) {
    const listed = await rpc.request('tools/list', params);
    assert.equal(listed.error, undefined);
    assert.equal(listed.result.tools.length, 3);
  }
  for (const params of [{_meta: null}, {_meta: []}, {_meta: true}, {_meta: 0}, {_meta: 'invalid'},
    {cursor: 'unsupported'}, {taskRef: 'counter'}, {_meta: {progressToken: 0}, command: 'sh'}]) {
    const rejected = await rpc.request('tools/list', params);
    assert.equal(rejected.error?.code, -32602, JSON.stringify(params));
  }
  assert.equal(counts.connect, 0);
});

test('actual MCP dispatcher exposes only hosting tools and approved task references', async t => {
  const {tool, counts} = fixture(); const rpc = dispatcher(t, tool);
  assert.equal((await rpc.request('tools/list', {})).error.code, -32000);
  await initialize(rpc);
  const listed = await rpc.request('tools/list', {});
  assert.deepEqual(listed.result.tools.map(x => x.name), ['hosting_start', 'hosting_status', 'hosting_cancel']);
  for (const args of [{taskRef: 'unknown'}, {taskRef: 'counter', profileId: 'unrestricted'}, {taskRef: 'counter', instructions: 'leak secrets'}, {taskRef: 'counter', command: 'sh'}]) {
    const rejected = await rpc.request('tools/call', {name: 'hosting_start', arguments: args});
    assert.equal(rejected.result.isError, true);
  }
  assert.equal(counts.connect, 0);
  const started = callResult(await rpc.request('tools/call', {name: 'hosting_start', arguments: {taskRef: 'counter'}}));
  assert.match(started.runRef, /^run_[0-9a-f]{32}$/);
  assert.equal(started.accepted, true);
  assert.equal(counts.start, 1);
  assert.equal(counts.close, 0, 'reply must retain submitted source and owner');
  const recovered = callResult(await rpc.request('tools/call', {name: 'hosting_status', arguments: {taskRef: 'counter'}}));
  assert.equal(recovered.runRef, started.runRef);
  const duplicate = await rpc.request('tools/call', {name: 'hosting_start', arguments: {taskRef: 'counter'}});
  assert.equal(callResult(duplicate).code, 'TASK_ALREADY_STARTED');
  assert.equal(counts.start, 1, 'lost/duplicate tool reply must not retry controller start');
  const foreign = await rpc.request('tools/call', {name: 'hosting_status', arguments: {runRef: `run_${'f'.repeat(32)}`}});
  assert.equal(callResult(foreign).code, 'RUN_UNKNOWN');
  const wire = JSON.stringify(rpc.transcript);
  for (const privateValue of ['2'.repeat(32), '3'.repeat(32), '4'.repeat(32), 'manifestJson', 'rootId', 'profileId', 'PRIVATE-CONTROLLER-DIAGNOSTIC']) assert.equal(wire.includes(privateValue), false);
  rpc.input.end();
  assert.equal((await rpc.server.done).cleanupStatus, 'succeeded');
  assert.equal(counts.close, 1); assert.equal(counts.sessionCleanup, 1);
});

test('public status never reveals controller errors or trusted evaluation results', async t => {
  const failed = fixture({failed: true}); t.after(() => failed.tool.close());
  const start = await failed.tool.call('hosting_start', {taskRef: 'counter'});
  await failed.tool.completion(start.runRef);
  const status = await failed.tool.call('hosting_status', {runRef: start.runRef});
  assert.equal(JSON.stringify(status).includes('PRIVATE-CONTROLLER-DIAGNOSTIC'), false);
  assert.equal(status.failure.code, 'HOSTING_FAILED');
  let context;
  const good = fixture({onSubmitted: async value => { context = value; return {privateCanary: 'PRIVATE-EVALUATOR-RESULT'}; }});
  t.after(() => good.tool.close());
  const accepted = await good.tool.call('hosting_start', {taskRef: 'counter'});
  const completed = await good.tool.completion(accepted.runRef);
  assert.equal(context.client, good.client); assert.equal(context.session, good.session);
  assert.equal(context.taskRef, 'counter'); assert.equal(context.run.sourceHash, undefined);
  assert.equal(completed.result.privateCanary, 'PRIVATE-EVALUATOR-RESULT');
  const safe = await good.tool.call('hosting_status', {runRef: accepted.runRef});
  assert.equal(safe.evaluation.phase, 'finished');
  assert.equal(JSON.stringify(safe).includes('PRIVATE-EVALUATOR-RESULT'), false);
  assert.equal(good.counts.sessionCleanup, 1); assert.equal(good.counts.close, 1);
});

test('actual MCP cancellation joins the active host and session once', async t => {
  const {tool, counts} = fixture({waiting: true}); const rpc = dispatcher(t, tool);
  await initialize(rpc);
  const started = callResult(await rpc.request('tools/call', {name: 'hosting_start', arguments: {taskRef: 'counter'}}));
  assert.equal(started.phase, 'running');
  const cancel = () => rpc.request('tools/call', {name: 'hosting_cancel', arguments: {runRef: started.runRef}});
  const terminal = callResult(await cancel());
  assert.equal(terminal.phase, 'finished'); assert.equal(terminal.outcome, 'cancelled');
  assert.equal(terminal.cleanup.status, 'succeeded'); assert.equal(terminal.sessionCleanup.status, 'succeeded');
  await cancel();
  assert.equal(counts.cancel, 1); assert.equal(counts.sessionCleanup, 1); assert.equal(counts.close, 1);
  assert.equal(JSON.stringify(rpc.transcript).includes('PRIVATE-CANCELLATION-DETAIL'), false);
});

test('hosting absence fails before a session or implementer is allocated', async t => {
  const {tool, counts} = fixture({capability: false}); t.after(() => tool.close());
  await assert.rejects(tool.call('hosting_start', {taskRef: 'counter'}), {code: 'START_FAILED'});
  assert.equal(counts.open, 0); assert.equal(counts.start, 0); assert.equal(counts.close, 1);
});

test('explicit trusted cleanup receipt skips duplicate session cleanup without assuming disconnect means success', async t => {
  for (const status of ['succeeded', 'failed']) {
    let callback;
    const {tool, counts} = fixture({onSubmitted: async context => {
      callback = context;
      context.completeCleanup({status});
      assert.throws(() => context.completeCleanup({status}), {code: 'INVALID_CLEANUP_HANDOFF'});
      return 'private receipt';
    }});
    t.after(() => tool.close());
    const accepted = await tool.call('hosting_start', {taskRef: 'counter'});
    const result = await tool.completion(accepted.runRef);
    assert.equal(result.cleanup.status, status);
    assert.equal(counts.sessionCleanup, 0);
    assert.equal(counts.close, 1);
    assert.throws(() => callback.completeCleanup({status}), {code: 'INVALID_CLEANUP_HANDOFF'});
  }
});

test('EOF cancels the same owner and signals an active trusted callback', async t => {
  let entered; const running = new Promise(resolve => { entered = resolve; });
  let signalSeen = false;
  const {tool, counts} = fixture({onSubmitted: async ({signal}) => {
    entered(); await new Promise(resolve => signal.addEventListener('abort', () => { signalSeen = true; resolve(); }, {once: true}));
  }});
  const rpc = dispatcher(t, tool); await initialize(rpc);
  const start = callResult(await rpc.request('tools/call', {name: 'hosting_start', arguments: {taskRef: 'counter'}}));
  await running; rpc.input.end();
  assert.equal((await rpc.server.done).cleanupStatus, 'succeeded');
  await tool.completion(start.runRef);
  assert.equal(signalSeen, true); assert.equal(counts.sessionCleanup, 1); assert.equal(counts.close, 1);
});

test('malformed framing closes the adapter without passing a tool request', async t => {
  const {tool, counts} = fixture(); const rpc = dispatcher(t, tool);
  rpc.input.write('{"jsonrpc":"2.0","id":1,"id":2}\n');
  await rpc.server.done;
  assert.equal(counts.connect, 0);
});

test('an uncooperative trusted callback cannot prevent bounded owner cleanup', {timeout: 15_000}, async t => {
  let entered; const running = new Promise(resolve => { entered = resolve; });
  const {tool, counts} = fixture({onSubmitted: async () => { entered(); return new Promise(() => {}); }});
  t.after(() => tool.close());
  await tool.call('hosting_start', {taskRef: 'counter'}); await running;
  const result = await tool.close();
  assert.equal(result.cleanupStatus, 'failed', 'unsettled callback must not be reported clean');
  assert.equal(counts.sessionCleanup, 1); assert.equal(counts.close, 1);
});
