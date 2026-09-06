import {spawn} from 'node:child_process';
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkerClient} from '../../sdk/node/index.mjs';
import {FrameDecoder, frame} from '../../sdk/node/protocol.mjs';
export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const manifest = JSON.parse(await readFile(join(root, 'conformance/manifests/counter.json'), 'utf8'));
export async function rawWorker(t, {source, adapter = 'runtimes/node/examples/counter.mjs', publicManifest = manifest} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mirrorgate-node-'));
  const manifestPath = join(directory, 'port.json'); await writeFile(manifestPath, JSON.stringify(publicManifest));
  const adapterPath = source ? join(directory, 'adapter.mjs') : join(root, adapter);
  if (source) await writeFile(adapterPath, source.replaceAll('__TEST_DIR__', JSON.stringify(directory)));
  const child = spawn(process.execPath, [join(root, 'runtimes/node/worker.mjs'), '--manifest', manifestPath, '--adapter', adapterPath], {stdio: ['pipe', 'pipe', 'pipe']});
  const closed = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const queue = []; const waiters = [];
  const decoder = new FrameDecoder(message => { if (waiters.length) waiters.shift()(message); else queue.push(message); });
  child.stdout.on('data', data => decoder.push(data));
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing worker response: ${stderr}`)), 2000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
  t.after(async () => { child.kill('SIGKILL'); await closed; await rm(directory, {recursive: true, force: true}); });
  let id = 0;
  return {
    child, directory, closed, next, queue, stderr: () => stderr,
    send: request => child.stdin.write(frame(request)),
    request: (op, fields = {}) => { child.stdin.write(frame({v: 1, id: ++id, op, ...fields})); return next(); },
    async admit() { await this.request('hello', {interfaceDigest: publicManifest.interfaceDigest, runtime: 'node-v1'}); return this.request('create'); },
  };
}
/** Deliberately process-only unit transport; does not claim any sandbox restriction. */
export async function clientWorker(t, options = {}) {
  const worker = await rawWorker(t, options);
  // The raw helper decoder is a passive test observer; only WorkerClient sends requests.
  const client = await WorkerClient.fromIsolatedTransport({
    readable: worker.child.stdout, writable: worker.child.stdin, closed: worker.closed,
    terminate: () => worker.child.kill('SIGKILL'),
    onClose: callback => worker.child.once('exit', () => callback(new Error('Worker exited'))),
  }, {manifest: options.publicManifest ?? manifest, runtime: 'node-v1', timeoutMs: 1500, cancellationGraceMs: 200});
  t.after(() => client.close().catch(() => {}));
  return {client, worker};
}
export const hello = id => ({v: 1, id, op: 'hello', interfaceDigest: manifest.interfaceDigest, runtime: 'node-v1'});
