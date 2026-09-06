import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorkerClient} from '../sdk/node/index.mjs';

export const gateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const counterManifest = JSON.parse(await readFile(join(gateRoot, 'conformance/manifests/counter.json'), 'utf8'));

/** Assemble public runtime code and submission only; never mount the evaluator checkout. */
export async function prepareWorker(runtime, {faulty = false, manifest = counterManifest, adapterSource, extraFiles = {}} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mirrorgate-public-bundle-'));
  try {
    await writeFile(join(directory, 'port.json'), JSON.stringify(manifest));
    let command;
    if (runtime === 'node-v1') {
      await mkdir(join(directory, 'runtimes/node'), {recursive: true});
      await mkdir(join(directory, 'sdk/node'), {recursive: true});
      await cp(join(gateRoot, 'runtimes/node/worker.mjs'), join(directory, 'runtimes/node/worker.mjs'));
      await cp(join(gateRoot, 'sdk/node/protocol.mjs'), join(directory, 'sdk/node/protocol.mjs'));
      await cp(join(gateRoot, 'runtimes/node/examples/counter.mjs'), join(directory, 'counter.mjs'));
      if (adapterSource !== undefined) await writeFile(join(directory, 'adapter.mjs'), adapterSource);
      else await cp(join(gateRoot, `runtimes/node/examples/${faulty ? 'faulty-counter' : 'counter'}.mjs`), join(directory, 'adapter.mjs'));
      for (const [name, bytes] of Object.entries(extraFiles)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Extra fixture files must be flat public files');
        await writeFile(join(directory, name), bytes);
      }
      command = ['/usr/local/bin/node', '/artifact/runtimes/node/worker.mjs', '--manifest', '/artifact/port.json', '--adapter', '/artifact/adapter.mjs'];
    } else if (runtime === 'rust-v1') {
      const binary = process.env.MIRRORGATE_RUST_WORKER ?? join(gateRoot, 'runtimes/rust/target/debug/mirrorgate-counter-worker');
      await cp(binary, join(directory, 'worker'));
      command = ['/artifact/worker', '--manifest', '/artifact/port.json', ...(faulty ? ['--faulty'] : [])];
    } else throw new Error(`Unsupported fixture runtime ${runtime}`);
    return {
      directory, manifest, runtime,
      supervisor: {
        command: process.env.MIRRORGATE_PYTHON ?? '/usr/bin/python3',
        args: ['-m', 'mirrorgate.cli', 'run', '--profile', 'execution', '--workspace', directory, '--wall-seconds', '30', '--', ...command],
        cwd: gateRoot,
        env: {...process.env, PYTHONPATH: join(gateRoot, 'supervisor')},
      },
      cleanup: () => rm(directory, {recursive: true, force: true}),
    };
  } catch (error) {
    await rm(directory, {recursive: true, force: true});
    throw error;
  }
}

export async function launchWorker(runtime, options = {}) {
  const bundle = await prepareWorker(runtime, options);
  try {
    const client = await WorkerClient.launch({supervisor: bundle.supervisor, manifest: bundle.manifest, runtime, timeoutMs: 5000});
    return {client, bundle, async close() { try { await client.close(); } finally { await bundle.cleanup(); } }};
  } catch (error) {
    await bundle.cleanup();
    throw error;
  }
}
