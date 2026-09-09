import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {ControlClient} from '../../sdk/node/control.mjs';
import {createHostingTool} from '../../integrations/agent-host/index.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixtureScript = join(root, 'tests/cpp/hosting_controller_fixture.py');
const python = process.env.MIRRORGATE_PYTHON ?? '/usr/bin/python3';
const manifestJson = await readFile(join(root, 'conformance/manifests/counter.json'), 'utf8');
const manifest = JSON.parse(manifestJson);
const openArgs = {policyId: 'test.node', runtime: 'node-v1', manifestJson,
  submission: {kind: 'source', input: {rootId: 'submission', relativePath: 'source'}, buildPlanId: 'copy', authoring: true}};
const agent = {profileId: 'author', publicTask: {instructions: 'Implement the approved public Counter', files: []}};

async function fixture(t, mode, hostMode) {
  if (!process.env.MIRRORGATE_NODE_RUNTIME_ROOT) {
    if (process.env.MIRRORGATE_REQUIRE_SANDBOX === '1') throw new Error('Pinned Node runtime required');
    t.skip('Set MIRRORGATE_NODE_RUNTIME_ROOT for actual backend hosting checks'); return;
  }
  await access(join(process.env.MIRRORGATE_NODE_RUNTIME_ROOT, 'bin/node'));
  const directory = await mkdtemp(join(tmpdir(), 'gate-node-hosting-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await mkdir(join(directory, 'source')); await mkdir(join(directory, 'control'));
  await chmod(join(directory, 'control'), 0o700);
  await copyFile(join(root, 'runtimes/node/examples/counter.mjs'), join(directory, 'source/adapter.mjs'));
  const options = {controlVersion: 2, helloTimeoutMs: 10_000, requestTimeoutMs: 10_000, closeTimeoutMs: 10_000,
    requiredCapabilities: ['backend.linux-bubblewrap-v1']};
  if (mode === 'stdio') return {directory, connect: () => ControlClient.launch({...options,
    controller: {command: python, args: [fixtureScript, 'stdio', directory, hostMode], cwd: root, env: {...process.env}}})};
  const socketPath = join(directory, 'control/gate.sock');
  const server = spawn(python, [fixtureScript, 'unix', directory, hostMode, socketPath], {cwd: root, stdio: ['ignore', 'ignore', 'pipe']});
  let diagnostics = ''; server.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  const closed = new Promise(resolveClosed => server.once('close', resolveClosed));
  t.after(async () => { server.kill('SIGTERM'); await closed; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Test-only controller failed: ${diagnostics}`);
    try { if ((await stat(socketPath)).isSocket()) return {directory, server, connect: () => ControlClient.connectUnix({...options, socketPath})}; }
    catch {}
    await delay(20);
  }
  throw new Error(`Test-only controller did not create its socket: ${diagnostics}`);
}

async function exerciseSubmitted(session, run, directory) {
  assert.equal(run.outcome, 'submitted'); assert.equal(run.cleanup.status, 'succeeded');
  assert.equal((await session.status()).phase, 'submitted');
  await writeFile(join(directory, 'source/adapter.mjs'), 'throw new Error("live author source must not be built");\n');
  const prepared = await (await session.prepare()).wait({timeoutMs: 20_000});
  assert.equal(prepared.status, 'succeeded', JSON.stringify(prepared));
  assert.equal(prepared.result.sourceHash, run.submission.sourceHash);
  const authorization = await session.authorize({preparedRevision: prepared.result.preparedRevision, challenge: prepared.result.challenge,
    attestation: {registrationId: 'node-hosting-acceptance', request: 'verify', policy: 'require', status: 'matched',
      descriptorSchema: 'mirrors.model-interface-descriptor/v1', semanticDigest: manifest.interfaceDigest,
      adapterId: 'mirrorgate/node-v1', targetProfile: 'node-v1', stateComputerContractVersion: 'mirrors.state-computer/v1'}});
  const reservation = await session.acquireWorker(authorization);
  assert.equal(reservation.releaseMode, 'control-v1');
  const worker = await reservation.connect({timeoutMs: 5_000, cleanupTimeoutMs: 10_000});
  try {
    await worker.invoke('Initialize', {}); assert.deepEqual(await worker.observe(), {Count: 0n});
    await worker.invoke('Tick', {Stride: 3n}); assert.deepEqual(await worker.observe(), {Count: 3n});
  } finally { await worker.close(); }
  const status = await session.status(); assert.equal(status.phase, 'closed'); assert.equal(status.cleanup.status, 'succeeded');
}

for (const mode of ['stdio', 'unix']) for (const hostMode of ['submit', 'wait']) {
  test(`Node v2 real controller/backend with synthetic author: ${mode} ${hostMode}`, {timeout: 60_000}, async t => {
    const setup = await fixture(t, mode, hostMode); if (!setup) return;
    const client = await setup.connect(); t.after(() => client.close().catch(() => {}));
    const session = await client.openSession(openArgs);
    assert.equal(await session.agentStatus(), null);
    const run = await session.startAgent(agent);
    const foreign = await setup.connect();
    try {
      await assert.rejects(foreign._request('agent.status', {sessionId: session.id, runId: run.id}), {code: 'HANDLE_INVALID'});
      await assert.rejects(foreign._request('agent.cancel', {sessionId: session.id, runId: run.id, reason: 'user-cancel'}), {code: 'HANDLE_INVALID'});
    } finally { await foreign.close(); }
    if (hostMode === 'submit') {
      const submitted = await run.wait({timeoutMs: 10_000});
      assert.deepEqual((await run.cancel()).submission, submitted.submission, 'postcommit cancellation must preserve source');
      await exerciseSubmitted(session, submitted, setup.directory);
    } else {
      const cancelled = await run.cancel();
      assert.equal(cancelled.outcome, 'cancelled'); assert.equal(cancelled.submission, undefined);
      assert.equal(cancelled.cleanup.status, 'succeeded');
      const cleanup = await (await session.close()).wait({timeoutMs: 10_000});
      assert.equal(cleanup.status, 'succeeded'); assert.equal(cleanup.result.cleanupStatus, 'succeeded');
    }
    await client.close();
    if (setup.server) {
      assert.equal(setup.server.exitCode, null);
      const survivor = await setup.connect(); await survivor.close();
    }
  });
}

test('hosting-tool trusted callback uses the original owner through actual frozen build/worker cleanup', {timeout: 60_000}, async t => {
  const setup = await fixture(t, 'unix', 'submit'); if (!setup) return;
  let callbacks = 0;
  const tool = createHostingTool({connect: setup.connect, tasks: {counter: {session: openArgs, agent}},
    onSubmitted: async ({client, session, run, completeCleanup}) => {
      callbacks++; assert.equal(session.client, client);
      await exerciseSubmitted(session, run, setup.directory);
      const cleanup = await session.status();
      await client.close();
      completeCleanup({status: cleanup.cleanup.status});
      return {privateEvaluationMarker: 'DO-NOT-EXPOSE'};
    }});
  t.after(() => tool.close());
  const accepted = await tool.call('hosting_start', {taskRef: 'counter'});
  const result = await tool.completion(accepted.runRef);
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(callbacks, 1, JSON.stringify(result.hosting));
  assert.equal(result.cleanup.status, 'succeeded');
  assert.equal(result.result.privateEvaluationMarker, 'DO-NOT-EXPOSE');
  assert.equal(JSON.stringify(await tool.call('hosting_status', {runRef: accepted.runRef})).includes('DO-NOT-EXPOSE'), false);
  await tool.close(); assert.equal(setup.server.exitCode, null);
  const survivor = await setup.connect(); await survivor.close();
});
