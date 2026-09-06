import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {rawWorker, manifest} from './helpers.mjs';

const fixtures = JSON.parse(await readFile(new URL('../../conformance/lifecycle.json', import.meta.url), 'utf8'));
for (const scenario of fixtures.cases) test(`shared lifecycle: ${scenario.name}`, async t => {
  const worker = await rawWorker(t);
  for (const step of scenario.steps) {
    const {expect, op, ...fields} = step;
    if (op === 'hello') Object.assign(fields, {interfaceDigest: manifest.interfaceDigest, runtime: 'node-v1'});
    const response = await worker.request(op, fields);
    assert.equal(response.ok, expect.ok, `${scenario.name}: ${op}`);
    if (Object.hasOwn(expect, 'result')) assert.deepEqual(response.result, expect.result);
    if (Object.hasOwn(expect, 'code')) assert.equal(response.error.code, expect.code);
  }
});
