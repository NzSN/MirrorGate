import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const gateRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const run = spawnSync('bash', [resolve(gateRoot, 'conformance/control-v1/run')], {
  cwd: gateRoot,
  env: process.env,
  stdio: 'inherit',
});
if (run.error) throw run.error;
if (run.status !== 0) process.exitCode = run.status ?? 1;
