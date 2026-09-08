import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access, chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {ControlClient} from '../../sdk/node/control.mjs';
import {manifest} from './helpers.mjs';

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const python = process.env.MIRRORGATE_PYTHON ?? '/usr/bin/python3';
const rustWorker = process.env.MIRRORGATE_RUST_WORKER ?? join(root, 'runtimes/rust/target/debug/mirrorgate-counter-worker');
const manifestJson = JSON.stringify(manifest);

async function prerequisite(t) {
  const nodeRuntime = process.env.MIRRORGATE_NODE_RUNTIME_ROOT;
  try {
    if (!nodeRuntime) throw new Error('MIRRORGATE_NODE_RUNTIME_ROOT is unset');
    await access(join(nodeRuntime, 'bin/node'));
    await access(rustWorker);
    const version = (await run(join(nodeRuntime, 'bin/node'), ['--version'])).stdout.trim();
    assert.equal(version, 'v24.15.0', 'real backend acceptance requires the pinned worker runtime');
    return true;
  } catch (error) {
    if (process.env.MIRRORGATE_REQUIRE_SANDBOX === '1') throw error;
    t.skip(`real control backend prerequisites unavailable: ${error.message}`);
    return false;
  }
}

async function prepareFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mirrorgate-node-control-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const inputs = join(directory, 'inputs');
  await mkdir(inputs);
  for (const [name, adapter] of [['node-correct', 'counter.mjs'], ['node-faulty', 'faulty-counter.mjs']]) {
    const submission = join(inputs, name);
    await mkdir(submission);
    await copyFile(join(root, 'runtimes/node/examples', adapter), join(submission, 'adapter.mjs'));
    if (adapter === 'faulty-counter.mjs') await copyFile(join(root, 'runtimes/node/examples/counter.mjs'), join(submission, 'counter.mjs'));
  }
  const pendingSubmission = join(inputs, 'node-pending');
  await mkdir(pendingSubmission);
  await writeFile(join(pendingSubmission, 'adapter.mjs'), `
    let running = false;
    export function createAdapter() {
      return {
        actions: {
          Initialize() {},
          Tick() { running = true; return new Promise(resolve => setTimeout(() => { running = false; resolve(); }, 10000)); },
        },
        observe() { return {Count: 0n}; },
        dispose() { if (running) throw new Error('dispose raced a running callback'); },
      };
    }
  `);
  for (const name of ['rust-correct', 'rust-faulty']) {
    const submission = join(inputs, name);
    await mkdir(submission);
    await copyFile(rustWorker, join(submission, 'worker'));
    await chmod(join(submission, 'worker'), 0o755);
  }
  const policy = join(directory, 'policy.json');
  await run(python, [join(root, 'tests/control_policy_fixture.py'), policy, inputs, '--runtime', 'shared', '--faulty'], {cwd: root, env: {...process.env, PYTHONPATH: join(root, 'supervisor')}});
  return {directory, inputs, policy};
}

function attestation(runtime) {
  return {
    registrationId: `registration-${runtime}`,
    request: 'verify', policy: 'require', status: 'matched',
    descriptorSchema: 'mirrors.model-interface-descriptor/v1',
    semanticDigest: manifest.interfaceDigest,
    adapterId: `mirrorgate/${runtime}`,
    targetProfile: runtime,
    stateComputerContractVersion: 'mirrors.state-computer/v1',
  };
}

async function drive(client, {policyId, runtime, relativePath, faulty}) {
  const session = await client.openSession({
    policyId,
    submission: {kind: 'prebuilt', input: {rootId: 'submission', relativePath}},
    runtime,
    manifestJson,
  });
  const preparedOutcome = await (await session.prepare()).wait({timeoutMs: 20_000});
  assert.equal(preparedOutcome.status, 'succeeded', JSON.stringify(preparedOutcome));
  const prepared = preparedOutcome.result;
  const authorization = await session.authorize({
    preparedRevision: prepared.preparedRevision,
    challenge: prepared.challenge,
    attestation: attestation(runtime),
  });
  const reservation = await session.acquireWorker(authorization);
  const worker = await reservation.connect({timeoutMs: 5_000, cleanupTimeoutMs: 10_000});
  await worker.invoke('Initialize', {});
  assert.deepEqual(await worker.observe(), {Count: 0n});
  await worker.invoke('Tick', {Stride: 3n});
  assert.deepEqual(await worker.observe(), {Count: faulty ? 2n : 3n});
  await worker.close();
  const status = await session.status();
  assert.equal(status.phase, 'closed');
  assert.equal(status.cleanup.status, 'succeeded');
  return session;
}

async function drivePendingCancellation(client) {
  const session = await client.openSession({policyId: 'test.node', submission: {kind: 'prebuilt', input: {rootId: 'submission', relativePath: 'node-pending'}}, runtime: 'node-v1', manifestJson});
  const preparation = await (await session.prepare()).wait({timeoutMs: 20_000});
  assert.equal(preparation.status, 'succeeded', JSON.stringify(preparation));
  const authorization = await session.authorize({preparedRevision: preparation.result.preparedRevision, challenge: preparation.result.challenge, attestation: attestation('node-v1')});
  const reservation = await session.acquireWorker(authorization);
  const worker = await reservation.connect({timeoutMs: 5_000, cleanupTimeoutMs: 10_000});
  await worker.invoke('Initialize', {}); await worker.observe();
  const cancellation = new AbortController();
  const started = Date.now();
  const pending = worker.invoke('Tick', {Stride: 1n}, {signal: cancellation.signal});
  await delay(25); cancellation.abort();
  await assert.rejects(pending, {code: 'CANCELLED'});
  await worker.close();
  assert.ok(Date.now() - started < 7_000, 'Gate did not terminate an uncooperative callback within its cleanup deadline');
  const status = await session.status();
  assert.equal(status.phase, 'closed');
  assert.equal(status.cleanup.status, 'succeeded');
}

function controllerCommand(policy) {
  return {
    command: python,
    args: ['-m', 'mirrorgate.cli', 'control', '--stdio', '--policy-file', policy],
    cwd: root,
    env: {...process.env, PYTHONPATH: join(root, 'supervisor')},
  };
}

const capabilities = mode => [
  `control.local-${mode}-v1`, 'submission.prebuilt-v1',
  'execution.compiled-verify-v1', 'worker.managed-unix-v1',
  'worker.node-v1', 'worker.rust-v1', 'backend.linux-bubblewrap-v1',
  'cleanup.bounded-attempt-v1',
];

test('Node control SDK drives correct/faulty Node and Rust workers through owned stdio Gate', {timeout: 120_000}, async t => {
  if (!await prerequisite(t)) return;
  const fixture = await prepareFixture(t);
  const diagnostics = [];
  const client = await ControlClient.launch({controller: controllerCommand(fixture.policy), requiredCapabilities: capabilities('stdio'), requestTimeoutMs: 10_000, closeTimeoutMs: 10_000, onStderr: chunk => diagnostics.push(chunk)});
  try {
    await drive(client, {policyId: 'test.node', runtime: 'node-v1', relativePath: 'node-correct', faulty: false});
    await drive(client, {policyId: 'test.node', runtime: 'node-v1', relativePath: 'node-faulty', faulty: true});
    await drive(client, {policyId: 'test.rust', runtime: 'rust-v1', relativePath: 'rust-correct', faulty: false});
    await drive(client, {policyId: 'test.rust-faulty', runtime: 'rust-v1', relativePath: 'rust-faulty', faulty: true});
    await drivePendingCancellation(client);
  } finally {
    await client.close();
  }
  assert.equal(Buffer.concat(diagnostics).toString(), '');
});

test('attached Unix control client leaves the real daemon alive after worker/session cleanup', {timeout: 60_000}, async t => {
  if (!await prerequisite(t)) return;
  const fixture = await prepareFixture(t);
  const socketDirectory = join(fixture.directory, 'control');
  await mkdir(socketDirectory, {mode: 0o700});
  await chmod(socketDirectory, 0o700);
  const socketPath = join(socketDirectory, 'gate.sock');
  const daemon = spawn(python, ['-m', 'mirrorgate.cli', 'control', '--unix-socket', socketPath, '--policy-file', fixture.policy], {cwd: root, env: {...process.env, PYTHONPATH: join(root, 'supervisor')}, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  daemon.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => daemon.once('close', (code, signal) => resolve({code, signal})));
  t.after(async () => { if (daemon.exitCode === null) daemon.kill('SIGTERM'); await closed; });
  const deadline = Date.now() + 10_000;
  while (true) {
    try { if ((await stat(socketPath)).isSocket()) break; } catch {}
    if (Date.now() >= deadline) throw new Error(`attached controller socket did not appear: ${stderr}`);
    await delay(20);
  }
  const first = await ControlClient.connectUnix({socketPath, requiredCapabilities: capabilities('unix'), requestTimeoutMs: 10_000, closeTimeoutMs: 10_000});
  await drive(first, {policyId: 'test.node', runtime: 'node-v1', relativePath: 'node-correct', faulty: false});
  const second = await ControlClient.connectUnix({socketPath, requiredCapabilities: ['control.local-unix-v1'], requestTimeoutMs: 10_000, closeTimeoutMs: 10_000});
  const firstOwned = await first.openSession({policyId: 'test.node', submission: {kind: 'prebuilt', input: {rootId: 'submission', relativePath: 'node-correct'}}, runtime: 'node-v1', manifestJson});
  const secondOwned = await second.openSession({policyId: 'test.node', submission: {kind: 'prebuilt', input: {rootId: 'submission', relativePath: 'node-correct'}}, runtime: 'node-v1', manifestJson});
  await assert.rejects(second._request('session.status', {sessionId: firstOwned.id}), {code: 'HANDLE_INVALID'});
  assert.equal((await firstOwned.status()).phase, 'open', 'foreign request changed the true owner session');
  const firstCleanup = await (await firstOwned.close()).wait({timeoutMs: 10_000});
  assert.equal(firstCleanup.status, 'succeeded');
  await first.close();
  assert.equal(daemon.exitCode, null, `attached daemon exited: ${stderr}`);
  assert.equal((await secondOwned.status()).phase, 'open', 'closing another connection changed this session');
  const secondCleanup = await (await secondOwned.close()).wait({timeoutMs: 10_000});
  assert.equal(secondCleanup.status, 'succeeded');
  await second.close();
  assert.equal(daemon.exitCode, null, `attached daemon exited after second client: ${stderr}`);
});
