import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {generateAdapterKit, checkAdapterKit, checkAdapterStructure} from '../../sdk/node/adapter-kit.mjs';
const manifest = JSON.parse(await readFile(new URL('../../conformance/manifests/counter.json', import.meta.url)));
async function temporary(t) { const dir = await mkdtemp(join(tmpdir(), 'gate-kit-')); t.after(() => rm(dir, {recursive:true, force:true})); return dir; }

test('kit is deterministic, typed, public only, preserves seeds and detects staleness', async t => {
  const directory = await temporary(t);
  const first = await generateAdapterKit(manifest, {directory, behavior:'Approved behavior'});
  assert.equal((await checkAdapterKit(manifest, {directory})).current, true);
  const checked = spawnSync(process.env.MIRRORGATE_TSC ?? 'tsc', [ '--noEmit', '--allowJs', '--checkJs', '--target', 'es2022', '--module', 'nodenext', '--strict', join(directory, 'adapter.mjs')], {encoding:'utf8'});
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  await writeFile(join(directory, 'adapter.mjs'), 'authored');
  await writeFile(join(directory, 'PUBLIC-CONTRACT.md'), 'authored prose');
  assert.deepEqual(await generateAdapterKit(manifest, {directory, behavior:'replacement'}), first);
  assert.equal(await readFile(join(directory, 'adapter.mjs'), 'utf8'), 'authored');
  assert.equal(await readFile(join(directory, 'PUBLIC-CONTRACT.md'), 'utf8'), 'authored prose');
  await writeFile(join(directory, 'adapter.d.ts'), 'authored collision');
  assert.deepEqual((await checkAdapterKit(manifest, {directory})).stale, ['adapter.d.ts']);
  await assert.rejects(generateAdapterKit(manifest, {directory}), /modified/);
});
test('unknown/private manifest fields, collisions, and symlink paths are rejected', async t => {
  const directory = await temporary(t);
  await assert.rejects(generateAdapterKit({...manifest, privateModel:'SECRET'}, {directory}));
  await writeFile(join(directory, 'port.json'), 'unowned');
  await assert.rejects(generateAdapterKit(manifest, {directory}), /unowned/);
  const target = await temporary(t);
  await symlink(target, join(directory, 'linked'));
  await assert.rejects(generateAdapterKit(manifest, {directory:join(directory, 'linked')}), /symlink/);
});
test('quoted IDs and every recursive native shape survive declaration generation', async t => {
  const directory = await temporary(t);
  const m = structuredClone(manifest);
  m.initializers[0].id = 'public.init';
  m.observations = [{id:'public.value', type:{kind:'record',fields:[{wireName:'__proto__',type:{kind:'tuple',elements:[
    {kind:'map', key:{kind:'str'},value:{kind:'set',element:{kind:'int'}}},
    {kind:'variant',cases:[{tag:'ok',payload:{kind:'seq',element:{kind:'bool'}}},{tag:'empty',payload:{kind:'null'}}]},
  ]}}]}}];
  await generateAdapterKit(m, {directory});
  const declaration = await readFile(join(directory,'adapter.d.ts'),'utf8');
  assert.match(declaration,/Map<string, Set<bigint>>/);
  assert.match(declaration,/"__proto__"/);
  const checked = spawnSync(process.env.MIRRORGATE_TSC ?? 'tsc', [ '--noEmit', '--allowJs', '--checkJs', '--target', 'es2022', '--module', 'nodenext', '--strict', join(directory, 'adapter.mjs')], {encoding:'utf8'});
  assert.equal(checked.status,0,checked.stdout + checked.stderr);
});
test('structural checker uses public samples, invokes factory twice and selected disposal', async () => {
  const m={schema:'mirrorgate.port/v1',interfaceDigest:'a'.repeat(64),initializers:[{id:'init',inputs:[{id:'n',type:{kind:'int'}}]}],actions:[],observations:[{id:'n',type:{kind:'int'}}]};
  let factories=0, disposed=0;
  const module={createAdapter(){factories++;let n;return {actions:{init(inputs){n=inputs.n;}},observe(){return {n};},dispose(){disposed++;}};}};
  assert.deepEqual(await checkAdapterStructure(m,module,{samples:[{action:'init',inputs:{n:{'#bigint':'4'}}}],dispose:true}),{structural:true,resets:2,calls:2,disposalExercised:true});
  assert.equal(factories,2);assert.equal(disposed,2);
  await assert.rejects(checkAdapterStructure(m,module,{samples:[{action:'init',inputs:{n:4}}]}));
  await assert.rejects(checkAdapterStructure(m,{createAdapter(){throw new Error('unimplemented');}},{samples:[{action:'init',inputs:{n:{'#bigint':'4'}}}]}),/unimplemented/);
});
