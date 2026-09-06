import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FrameDecoder, parseJson, validateManifest, validateType, validateRequest, validateResponse, encodeValue, decodeValue} from '../../sdk/node/protocol.mjs';

const vectors = (await readFile(new URL('../../conformance/vectors.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(JSON.parse);
for (const vector of vectors) test(`shared ${vector.kind}: ${vector.name}`, () => {
  const check = () => {
    switch (vector.kind) {
      case 'manifest': return validateManifest(vector.value);
      case 'request': return validateRequest(vector.value);
      case 'response': return validateResponse(vector.value);
      case 'value': validateType(vector.type); return decodeValue(vector.type, vector.value);
      case 'frame': { let count = 0; const decoder = new FrameDecoder(() => count++); decoder.push(Buffer.from(vector.hex, 'hex')); decoder.end(); assert.equal(count, 1); return; }
      default: throw new Error(`Unknown shared vector kind ${vector.kind}`);
    }
  };
  if (vector.valid) {
    const decoded = check();
    if (vector.kind === 'value') assert.deepEqual(encodeValue(vector.type, decoded), vector.value);
  } else assert.throws(check);
});

test('native sets reject structurally duplicate objects and nested unordered sets', () => {
  const type = {kind: 'set', element: {kind: 'set', element: {kind: 'int'}}};
  assert.throws(() => encodeValue(type, new Set([new Set([1n, 2n]), new Set([2n, 1n])])), {code: 'VALUE'});
});

test('JSON parser preserves ordinary prototype-looking field names', () => {
  const value = parseJson('{"__proto__":{"x":1},"constructor":"a"}');
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.deepEqual(value.__proto__, {x: 1});
});

test('framer handles arbitrary UTF-8 fragmentation with bounded buffers', () => {
  const actual = []; const decoder = new FrameDecoder(value => actual.push(value));
  const encoded = Buffer.from('{"hello":"你好"}\n');
  for (const byte of encoded) decoder.push(Buffer.from([byte]));
  decoder.end(); assert.deepEqual(actual, [{hello: '你好'}]);
});

test('ordinary marker-looking record fields retain sequence order in set equality', () => {
  const type = {kind: 'set', element: {kind: 'record', fields: [{wireName: '#set', type: {kind: 'seq', element: {kind: 'int'}}}]}};
  const value = new Set([{'#set': [1n, 2n]}, {'#set': [2n, 1n]}]);
  assert.equal(decodeValue(type, encodeValue(type, value)).size, 2);
});

test('native sparse sequences are rejected instead of silently emitting null', () => {
  assert.throws(() => encodeValue({kind: 'seq', element: {kind: 'int'}}, new Array(1)), {code: 'VALUE'});
});
