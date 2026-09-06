import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, access} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {clientWorker, rawWorker, manifest, hello} from './helpers.mjs';

const bigint = n => ({'#bigint': String(n)});

test('real Counter preserves arbitrary integers, reset, and exact stable IDs', async t => {
  const {client} = await clientWorker(t);
  await assert.rejects(client.invoke('Tick', {Stride: 1n}), {code: 'LIFECYCLE'});
  await client.invoke('Initialize', {}); assert.deepEqual(await client.observe(), {Count: 0n});
  await assert.rejects(client.invoke('Tick', {stride: 1n}), {code: 'VALUE'});
  await assert.rejects(client.invoke('tick', {Stride: 1n}), {code: 'VALUE'});
  await client.invoke('Tick', {Stride: 90071992547409931234567890n});
  assert.deepEqual(await client.observe(), {Count: 90071992547409931234567890n});
  await client.invoke('Initialize', {}); assert.deepEqual(await client.observe(), {Count: 0n});
  await client.close(); await client.close();
});

test('faulty implementation is visible through a faithful observer', async t => {
  const {client} = await clientWorker(t, {adapter: 'runtimes/node/examples/faulty-counter.mjs'});
  await client.invoke('Initialize', {}); await client.observe();
  await client.invoke('Tick', {Stride: 2n});
  assert.deepEqual(await client.observe(), {Count: 1n});
});

test('manifest admission and hello happen before submitted module import', async t => {
  const source = `import {writeFileSync} from 'node:fs'; writeFileSync(__TEST_DIR__ + '/imported', 'yes'); export function createAdapter() { throw Error('not reached'); }`;
  const worker = await rawWorker(t, {source});
  await delay(40); await assert.rejects(access(join(worker.directory, 'imported')));
  const reply = await worker.request('hello', {interfaceDigest: '0'.repeat(64), runtime: 'node-v1'});
  assert.equal(reply.error.code, 'HANDSHAKE'); await assert.rejects(access(join(worker.directory, 'imported')));
  assert.equal((await worker.request('dispose')).ok, true);
});

test('unsupported manifest is rejected before module import', async t => {
  const badManifest = structuredClone(manifest); badManifest.observations[0].type = {kind: 'opaqueItf'};
  const worker = await rawWorker(t, {publicManifest: badManifest, source: `import {writeFileSync} from 'node:fs'; writeFileSync(__TEST_DIR__ + '/imported', 'yes');`});
  assert.equal((await worker.closed).code, 2); await assert.rejects(access(join(worker.directory, 'imported')));
});

test('callbacks receive only public input IDs and AbortSignal context; console goes to stderr', async t => {
  const {client, worker} = await clientWorker(t, {source: `
    let count = 0n;
    function context(ctx) { if (Object.keys(ctx).join() !== 'signal' || !(ctx.signal instanceof AbortSignal)) throw Error('private context'); }
    export function createAdapter() { console.log('adapter log'); return {
      actions: {Initialize(inputs, ctx) { context(ctx); if (Object.keys(inputs).length) throw Error('private inputs'); count=0n; }, Tick({Stride},ctx) { context(ctx); count += Stride; }},
      observe(ctx) { context(ctx); return {Count: count}; },
    }; }`});
  await client.invoke('Initialize', {}); assert.deepEqual(await client.observe(), {Count: 0n});
  assert.match(worker.stderr(), /adapter log/);
});

test('malformed input is rejected before the callback and poisons observation', async t => {
  const worker = await rawWorker(t); await worker.admit();
  const response = await worker.request('invoke', {action: 'Initialize', inputs: {private: 'no'}});
  assert.equal(response.error.code, 'VALUE'); assert.equal((await worker.request('observe')).error.code, 'LIFECYCLE');
  await worker.request('dispose');
});

test('every mutation must be followed by observation', async t => {
  const worker = await rawWorker(t); await worker.admit();
  await worker.request('invoke', {action: 'Initialize', inputs: {}});
  assert.equal((await worker.request('invoke', {action: 'Tick', inputs: {Stride: bigint(2)}})).error.code, 'LIFECYCLE');
});

test('invalid native observation poisons worker', async t => {
  const {client} = await clientWorker(t, {source: `export function createAdapter() { return {actions:{Initialize(){},Tick(){}},observe(){return {Count: 3};}}; }`});
  await client.invoke('Initialize', {}); await assert.rejects(client.observe(), {code: 'VALUE'});
  await assert.rejects(client.invoke('Tick', {Stride: 1n}), {code: 'LIFECYCLE'});
});

test('cancel reply order, no late success or observation, at-most-once disposal', async t => {
  const worker = await rawWorker(t, {source: `
    import {appendFileSync} from 'node:fs';
    export function createAdapter() { return {
      actions:{Initialize(){},Tick(inputs,{signal}) { signal.addEventListener('abort',()=>appendFileSync(__TEST_DIR__+'/events','abort\\n')); return new Promise(r=>setTimeout(()=>{appendFileSync(__TEST_DIR__+'/events','late\\n');r();},80)); }},
      observe(){appendFileSync(__TEST_DIR__+'/events','observe\\n');return {Count:0n};},
      dispose(){appendFileSync(__TEST_DIR__+'/events','dispose\\n');}
    }; }`});
  await worker.admit(); await worker.request('invoke', {action: 'Initialize', inputs: {}}); await worker.request('observe');
  worker.send({v: 1, id: 5, op: 'invoke', action: 'Tick', inputs: {Stride: bigint(1)}});
  await delay(15); worker.send({v: 1, id: 6, op: 'cancel', requestId: 5});
  assert.deepEqual(await worker.next(), {v: 1, id: 5, ok: false, error: {code: 'CANCELLED', message: 'Operation cancelled'}});
  assert.deepEqual(await worker.next(), {v: 1, id: 6, ok: true, result: null});
  await delay(110); assert.equal(worker.queue.length, 0);
  worker.send({v: 1, id: 7, op: 'observe'}); assert.equal((await worker.next()).error.code, 'LIFECYCLE');
  worker.send({v: 1, id: 8, op: 'dispose'}); assert.equal((await worker.next()).ok, true); await worker.closed;
  assert.equal(await readFile(join(worker.directory, 'events'), 'utf8'), 'observe\nabort\nlate\ndispose\n');
});

test('invalid factory output cleans up once and preserves original failure', async t => {
  const worker = await rawWorker(t, {source: `import {appendFileSync} from 'node:fs'; export function createAdapter(){return {actions:{},observe(){},dispose(){appendFileSync(__TEST_DIR__+'/disposed','x'); throw Error('cleanup failure');}};}`});
  await worker.request('hello', {interfaceDigest: manifest.interfaceDigest, runtime: 'node-v1'});
  const reply = await worker.request('create'); assert.equal(reply.error.code, 'APPLICATION'); assert.match(reply.error.message, /actions/);
  await worker.request('dispose'); await worker.closed;
  assert.equal(await readFile(join(worker.directory, 'disposed'), 'utf8'), 'x');
});

for (const [name, bytes] of [
  ['duplicate JSON keys', '{"v":1,"id":1,"id":2,"op":"create"}\n'],
  ['extra request fields', JSON.stringify({...hello(1), private: true})+'\n'],
  ['unknown operation', '{"v":1,"id":1,"op":"readPrivate"}\n'],
  ['invalid UTF8', Buffer.from([0xff, 10])],
  ['CR framing', JSON.stringify(hello(1))+'\r\n'],
  ['oversized frame', ' '.repeat(65536)+'\n'],
]) test(`worker closes on ${name}`, async t => {
  const worker = await rawWorker(t); worker.child.stdin.write(bytes);
  assert.equal((await worker.closed).code, 1);
});

test('pipelining and wrong cancellation target close the worker', async t => {
  const worker = await rawWorker(t);
  worker.child.stdin.write(JSON.stringify(hello(1))+'\n'+JSON.stringify({v: 1,id: 2,op: 'cancel',requestId: 42})+'\n');
  assert.equal((await worker.closed).code, 1);
});

test('oversized output returns LIMIT and disallows further operations', async t => {
  const publicManifest = structuredClone(manifest); publicManifest.observations[0].type = {kind: 'str'};
  const worker = await rawWorker(t, {publicManifest, source: `export function createAdapter(){return {actions:{Initialize(){},Tick(){}},observe(){return {Count:'x'.repeat(65536)};}};}`});
  await worker.admit(); await worker.request('invoke', {action: 'Initialize', inputs: {}});
  assert.equal((await worker.request('observe')).error.code, 'LIMIT');
  assert.equal((await worker.request('invoke', {action: 'Tick', inputs: {Stride: bigint(1)}})).error.code, 'LIFECYCLE');
});

test('cancelled creation disposes eventual factory resources exactly once', async t => {
  const worker = await rawWorker(t, {source: `import {appendFileSync} from 'node:fs'; export async function createAdapter(){await new Promise(r=>setTimeout(r,60));return {actions:{Initialize(){},Tick(){}},observe(){return {Count:0n};},dispose(){appendFileSync(__TEST_DIR__+'/disposed','x');}};}`});
  await worker.request('hello', {interfaceDigest: manifest.interfaceDigest, runtime: 'node-v1'});
  worker.send({v: 1, id: 2, op: 'create'}); await delay(15);
  worker.send({v: 1, id: 3, op: 'cancel', requestId: 2});
  assert.equal((await worker.next()).error.code, 'CANCELLED'); assert.equal((await worker.next()).ok, true);
  worker.send({v: 1, id: 4, op: 'dispose'}); assert.equal((await worker.next()).ok, true); await worker.closed;
  assert.equal(await readFile(join(worker.directory, 'disposed'), 'utf8'), 'x');
});

test('disposal failure closes lifecycle and cannot be invoked twice', async t => {
  const worker = await rawWorker(t, {source: `import {appendFileSync} from 'node:fs'; export function createAdapter(){return {actions:{Initialize(){},Tick(){}},observe(){return {Count:0n};},dispose(){appendFileSync(__TEST_DIR__+'/disposed','x');throw Error('failed cleanup');}};}`});
  await worker.admit(); const response = await worker.request('dispose');
  assert.equal(response.error.code, 'APPLICATION'); assert.equal((await worker.closed).code, 1);
  assert.equal(await readFile(join(worker.directory, 'disposed'), 'utf8'), 'x');
});

test('pending disposal cannot be cancelled', async t => {
  const worker = await rawWorker(t, {source: `export function createAdapter(){return {actions:{Initialize(){},Tick(){}},observe(){return {Count:0n};},dispose(){return new Promise(()=>{});}};}`});
  await worker.admit(); worker.send({v: 1, id: 3, op: 'dispose'}); await delay(10);
  worker.send({v: 1, id: 4, op: 'cancel', requestId: 3}); assert.equal((await worker.closed).code, 1);
});

for (const [name, result] of [
  ['null', 'null'],
  ['number', '1'],
  ['resolved promise value', 'Promise.resolve(1)'],
  ['resolved thenable value', '{then(resolve){resolve(1);}}'],
]) test(`nonvoid action result ${name} fails before observation`, async t => {
  const worker = await rawWorker(t, {source: `import {writeFileSync} from 'node:fs'; export function createAdapter(){return {actions:{Initialize(){return ${result};},Tick(){}},observe(){writeFileSync(__TEST_DIR__+'/observed','yes');return {Count:0n};}};}`});
  await worker.admit();
  const response = await worker.request('invoke', {action: 'Initialize', inputs: {}});
  assert.equal(response.error.code, 'APPLICATION'); assert.match(response.error.message, /return undefined/);
  assert.equal((await worker.request('observe')).error.code, 'LIFECYCLE');
  await assert.rejects(access(join(worker.directory, 'observed')));
  assert.equal((await worker.request('dispose')).ok, true);
});

test('promise resolving undefined satisfies the void action contract', async t => {
  const {client} = await clientWorker(t, {source: `export function createAdapter(){return {actions:{Initialize(){return Promise.resolve();},Tick(){return {then(resolve){resolve(undefined);}};}},observe(){return {Count:0n};}};}`});
  await client.invoke('Initialize', {}); assert.deepEqual(await client.observe(), {Count: 0n});
  await client.invoke('Tick', {Stride: 1n}); assert.deepEqual(await client.observe(), {Count: 0n});
});
