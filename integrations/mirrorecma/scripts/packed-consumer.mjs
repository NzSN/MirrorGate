import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const gate = resolve(root, '../..');
const ecma = resolve(process.env.MIRRORECMA_ROOT ?? join(gate, '../MirrorECMA'));
const scratch = mkdtempSync(join(tmpdir(), 'gate-mbt-packed-'));
const run = (command, args, cwd = scratch) => {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', env: process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
};
try {
  run(join(root, 'node_modules/.bin/tsc'), ['-p', join(root, 'tsconfig.json')]);
  run(join(ecma, 'node_modules/.bin/tsc'), ['-p', join(ecma, 'tsconfig.json')]);
  for (const [name, source] of [['mirrorecma', ecma], ['mirrorgate', gate], ['mirrorgate-mirrorecma', root]]) {
    const archive = run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', scratch, '--cache', join(scratch, 'npm-cache')], source).split('\n').at(-1);
    const target = join(scratch, 'node_modules', name); mkdirSync(target, {recursive: true});
    run('tar', ['-xzf', join(scratch, archive), '--strip-components=1', '-C', target]);
  }
  writeFileSync(join(scratch, 'package.json'), '{"type":"module","private":true}\n');
  writeFileSync(join(scratch, 'consumer.mts'), `
import {createPreparedImplementationProvider, evaluateImplementation, evaluateHostedSubmission, createHostedEvaluationHandler, projectEvaluationReceipt, type PreparedImplementationProvider, type EvaluationOutcome} from 'mirrorgate-mirrorecma';
import {evaluateSandboxed, createSandboxCompiledModel} from 'mirrorgate-mirrorecma/legacy';
import type {ControlSession, Prepared} from 'mirrorgate/control';
import {AsyncCompiledAdapterRegistry, type AsyncAdapterFactory} from 'mirrorecma';
declare const session: ControlSession;
declare const prepared: Prepared;
declare const model: Parameters<typeof createPreparedImplementationProvider>[0]['model'];
const provider: Promise<PreparedImplementationProvider> = createPreparedImplementationProvider({session, prepared, model, runtime:'node-v1', policyId:'approved'});
const generic: Promise<AsyncAdapterFactory> = provider.then(p => p.factory);
void [generic, AsyncCompiledAdapterRegistry, evaluateSandboxed, createSandboxCompiledModel, evaluateImplementation, evaluateHostedSubmission, createHostedEvaluationHandler, projectEvaluationReceipt];
declare const outcome: EvaluationOutcome;
const publicOnly: string = JSON.stringify(outcome.publicResult);
void publicOnly;
`);
  run(join(root, 'node_modules/.bin/tsc'), [join(scratch, 'consumer.mts'), '--noEmit', '--strict', '--target', 'ES2022',
    '--module', 'Node16', '--moduleResolution', 'Node16', '--types', 'node', '--typeRoots', join(ecma, 'node_modules/@types')]);
  const js = `import assert from 'node:assert/strict';
import * as integration from 'mirrorgate-mirrorecma';
import * as legacy from 'mirrorgate-mirrorecma/legacy';
import {AsyncCompiledAdapterRegistry} from 'mirrorecma';
assert.equal(typeof integration.createPreparedImplementationProvider, 'function');
assert.equal(typeof legacy.evaluateSandboxed, 'function');
assert.equal(typeof AsyncCompiledAdapterRegistry, 'function');
assert.equal(legacy.evaluateSandboxedWithDependencies, undefined);
await assert.rejects(import('mirrorgate-mirrorecma/dist/sandbox.js'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
console.log('PACKED JS + TS CONSUMERS GREEN');`;
  writeFileSync(join(scratch, 'consumer.mjs'), js);
  console.log(run(process.execPath, [join(scratch, 'consumer.mjs')]));
  // Generated fixture stays compiler-owned. Compile an unchanged copy against
  // packed public MirrorECMA declarations, then exercise real sandbox admission.
  copyFileSync(join(root, 'test/fixtures/model-interface/counter/generated-async/CounterMirror.generated.ts'), join(scratch, 'CounterMirror.generated.ts'));
  run(join(root, 'node_modules/.bin/tsc'), [join(scratch, 'CounterMirror.generated.ts'), '--strict', '--target', 'ES2022',
    '--module', 'Node16', '--moduleResolution', 'Node16', '--types', 'node', '--typeRoots', join(ecma, 'node_modules/@types')]);
  if (process.argv.includes('--sandbox')) {
    assert.equal(process.version, 'v24.15.0', 'sandbox evidence requires pinned Node');
    copyFileSync(join(root, 'scripts/prepared-smoke.mjs'), join(scratch, 'prepared-smoke.mjs'));
    console.log(run(process.execPath, [join(scratch, 'prepared-smoke.mjs'), gate, ecma]));
  }
} finally {
  if (process.env.KEEP_GATE_MBT_CONSUMER === '1') console.log(`consumer retained: ${scratch}`);
  else rmSync(scratch, {recursive: true, force: true});
}
