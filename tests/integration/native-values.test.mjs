import test from 'node:test';
import {strict as assert} from 'node:assert';
import {toGateNative, toMirrorNative} from '../../integrations/mirrorecma/native-values.mjs';
import {publicManifest} from '../../integrations/mirrorecma/public-manifest.mjs';

test('nested sets/maps convert without exposing private descriptor fields', () => {
  const type = {kind: 'record', fields: [{wireName: '__proto__', type: {kind: 'map', key: {kind: 'str'}, value: {kind: 'set', element: {kind: 'tuple', elements: [{kind: 'int'}, {kind: 'variant', cases: [{tag: 'x', payload: {kind: 'seq', element: {kind: 'bool'}}}]}]}}}}]};
  const original = Object.fromEntries([['__proto__', [['a', [[9007199254740993n, {tag: 'x', value: [true, false]}]]]]]]);
  const gate = toGateNative(type, original);
  assert(gate.__proto__ instanceof Map);
  assert(gate.__proto__.get('a') instanceof Set);
  assert.deepEqual(toMirrorNative(type, gate), original);
  assert.equal(Object.getPrototypeOf(gate), Object.prototype);
});

test('public exporter carries only declared IDs/types and trusted interface identity', () => {
  const descriptor = {model: {source: '/private/spec.tla'}, invariant: 'SecretInvariant', initializers: [{id: 'Initialize', inputs: [], wireAction: 'hidden_init'}], actions: [{id: 'Tick', wireAction: 'secret_tick', inputs: [{id: 'Stride', type: {kind: 'int'}, from: {root: 'stepParameters', path: ['/private/projection']}}]}], observations: [{id: 'Count', type: {kind: 'int'}, wireName: 'secret_count'}]};
  const manifest = publicManifest(descriptor, '1'.repeat(64));
  assert.deepEqual(Object.keys(manifest).sort(), ['schema', 'interfaceDigest', 'initializers', 'actions', 'observations'].sort());
  assert(!JSON.stringify(manifest).includes('private'));
  assert(!JSON.stringify(manifest).includes('secret'));
  assert(!JSON.stringify(manifest).includes('SecretInvariant'));
});
