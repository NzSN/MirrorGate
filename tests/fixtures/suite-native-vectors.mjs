// Shared executable contract for mirrors.node-native/v1. Copy unchanged across
// repositories and pin its SHA-256; never import Gate in a generated local bundle.
import assert from 'node:assert/strict';

export function validateNativeConversions(toNative, fromNative) {
  const int = {kind: 'int'};
  const record = {kind: 'record', fields: [
    {wireName: '__proto__', type: int},
    {wireName: 'nested', type: {kind: 'set', element: {kind: 'tuple', elements: [int, {kind: 'bool'}]}}},
  ]};
  const shape = {kind: 'map', key: {kind: 'str'}, value: {kind: 'variant', cases: [
    {tag: 'present', payload: record}, {tag: 'absent', payload: {kind: 'null'}},
  ]}};
  const huge = (1n << 180n) + 7n;
  const generated = [['__proto__', {tag: 'present', value: Object.fromEntries([
    ['__proto__', huge], ['nested', [[huge, true], [-huge, false]]],
  ])}], ['empty', {tag: 'absent', value: null}]];
  const native = toNative(shape, generated);
  assert(native instanceof Map);
  assert(native.get('__proto__').value.nested instanceof Set);
  assert.equal(native.get('__proto__').value.__proto__, huge);
  assert(Object.hasOwn(native.get('__proto__').value, '__proto__'));
  assert.deepEqual(fromNative(shape, native), generated);
  assert.equal(Object.prototype.polluted, undefined);

  const nestedSets = {kind: 'set', element: {kind: 'set', element: int}};
  assert.throws(() => toNative(nestedSets, [[1n, 2n], [2n, 1n]]));
  assert.throws(() => fromNative(nestedSets, new Set([new Set([1n, 2n]), new Set([2n, 1n])])));
  const composite = {kind: 'set', element: record};
  const item = generated[0][1].value;
  assert.throws(() => toNative(composite, [item, structuredClone(item)]));
  assert.throws(() => fromNative(composite, new Set([toNative(record, item), toNative(record, item)])));
  assert.throws(() => toNative(shape, [['x', generated[0][1]], ['x', generated[0][1]]]));
  assert.throws(() => toNative({kind: 'tuple', elements: [int]}, [1n, 2n]));
  assert.throws(() => fromNative({kind: 'tuple', elements: [int]}, []));
  assert.throws(() => toNative(int, 1));
  assert.throws(() => fromNative(int, '1'));
  assert.throws(() => toNative(shape.value, {tag: 'other', value: null}));
  assert.throws(() => fromNative(record, {__proto__: huge, nested: new Set()}));
  assert.throws(() => toNative(record, {...item, extra: true}));
  assert.throws(() => fromNative({kind: 'set', element: int}, [1n]));
  assert.throws(() => toNative({kind: 'map', key: int, value: int}, [[1n, 2n]]));
  assert.throws(() => fromNative({kind: 'opaqueItf', description: 'unsupported'}, {}));
  const sequence = {kind: 'seq', element: {kind: 'str'}};
  assert.deepEqual(fromNative(sequence, toNative(sequence, ['a', 'b'])), ['a', 'b']);
  return 20;
}
