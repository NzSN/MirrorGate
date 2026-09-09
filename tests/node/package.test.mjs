import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

test('packed private package exposes typed control and worker subpaths to an isolated consumer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mirrorgate-package-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const sourceMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await run('npm', ['pack', '--pack-destination', directory], {cwd: root, env: {...process.env, npm_config_cache: join(directory, 'npm-cache')}});
  const archive = join(directory, `${sourceMetadata.name}-${sourceMetadata.version}.tgz`);
  const archiveEntries = (await run('tar', ['-tzf', archive])).stdout.split('\n').filter(Boolean);
  const packageRoot = join(directory, 'consumer', 'node_modules', 'mirrorgate');
  await mkdir(packageRoot, {recursive: true});
  await run('tar', ['-xzf', archive, '--strip-components=1', '-C', packageRoot]);
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.private, true);
  assert.deepEqual(Object.keys(metadata.exports), ['./control', './worker', './hosting-tool']);
  const compatibility = JSON.parse(await readFile(join(packageRoot, 'sdk/compatibility.json'), 'utf8'));
  assert.equal(compatibility.sdkVersion, metadata.version);
  assert.deepEqual(compatibility.controlVersions, [1, 2]);
  assert.deepEqual(compatibility.workerVersions, [1]);
  assert.equal(compatibility.ownedProcessCloseReceipt, 'checked-reap-v1');
  assert.equal(compatibility.modelFacadeAcceptance, 'experimental-local-shared-matrix-verified');
  assert.equal(compatibility.productionPublication, false);
  assert.equal(archiveEntries.some(path => path.startsWith('package/supervisor/')), false);
  assert.equal(archiveEntries.some(path => path.startsWith('package/protocol/')), false);

  const consumer = join(directory, 'consumer');
  const runtime = `
    import * as control from 'mirrorgate/control';
    import * as worker from 'mirrorgate/worker';
    if (typeof control.ControlClient !== 'function') throw new Error('missing ControlClient');
    if (typeof worker.WorkerClient !== 'function') throw new Error('missing WorkerClient');
    if (typeof worker.createManagedWorker !== 'function') throw new Error('missing managed worker factory');
    if (typeof worker.createPublicManifest !== 'function') throw new Error('missing public manifest exporter');
    if (typeof worker.toWorkerValue !== 'function' || typeof worker.fromWorkerValue !== 'function') throw new Error('missing generated value bridge');
  `;
  await run(process.execPath, ['--input-type=module', '--eval', runtime], {cwd: consumer});
  await assert.rejects(run(process.execPath, ['--input-type=module', '--eval', "import 'mirrorgate'"], {cwd: consumer}), error => error.stderr.includes('ERR_PACKAGE_PATH_NOT_EXPORTED'));

  const source = `
    import {ControlClient, type ControlSession, type Prepared, type RequiredMatchAttestation} from 'mirrorgate/control';
    import {WorkerClient, createManagedWorker, createPublicManifest, toWorkerValue, fromWorkerValue, type PublicManifest, type PublicModelDescriptor} from 'mirrorgate/worker';
    const attestation: RequiredMatchAttestation = {
      registrationId: 'r', request: 'verify', policy: 'require', status: 'matched',
      descriptorSchema: 'mirrors.model-interface-descriptor/v1', semanticDigest: '0'.repeat(64),
      adapterId: 'adapter/node', targetProfile: 'node/v1', stateComputerContractVersion: 'v1'
    };
    async function drive(client: ControlClient, session: ControlSession, manifest: PublicManifest): Promise<Prepared | undefined> {
      const operation = await session.prepare();
      const outcome = await operation.wait();
      if (outcome.status !== 'succeeded') return undefined;
      const authorization = await session.authorize({preparedRevision: outcome.result.preparedRevision, challenge: outcome.result.challenge, attestation});
      const reservation = await session.acquireWorker(authorization);
      const worker: WorkerClient = await reservation.connect({manifest});
      void createManagedWorker;
      await worker.close();
      return outcome.result;
    }
    const descriptor: PublicModelDescriptor = {initializers: [{id: 'Initialize', inputs: []}], actions: [], observations: [{id: 'Count', type: {kind: 'int'}}]};
    const publicManifest = createPublicManifest(descriptor, '0'.repeat(64));
    void toWorkerValue({kind: 'int'}, 0n); void fromWorkerValue({kind: 'int'}, 0n);
    void ControlClient; void drive; void publicManifest;
  `;
  await writeFile(join(consumer, 'consumer.mts'), source);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({compilerOptions: {target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM'], strict: true, noEmit: true, skipLibCheck: false}, files: ['consumer.mts']}));
  const compiler = process.env.MIRRORGATE_TSC ?? join(root, 'node_modules/.bin/tsc');
  await run(compiler, ['--project', 'tsconfig.json'], {cwd: consumer});
});
