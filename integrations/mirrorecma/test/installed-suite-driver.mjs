import assert from 'node:assert/strict';
import {existsSync, readFileSync, mkdirSync, statSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {defineSuite, semanticDescriptorDigest, decodeSemanticDescriptor} from 'mirrorecma';
import {evaluateSuite, createSandboxPublicManifest} from 'mirrorgate-mirrorecma';
import {checkAdapterKit} from 'mirrorgate/adapter-kit';
import {CounterModel} from './generated/Counter.suite.js';

const iteration = process.argv[2];
for (const hidden of JSON.parse(process.env.GATE_SUITE_HIDDEN_ROOTS)) {
  assert(!existsSync(resolve(hidden, 'package.json')), 'source checkout must be unavailable');
}
assert(!existsSync(process.env.GATE_SUITE_ORIGINAL_INSTALL), 'original installation must be unavailable');
const operator = resolve('../operator');
const kit = resolve('public-kit');
assert.equal((await checkAdapterKit(CounterModel.publicManifest, {directory: kit})).current, true);
const receipts = resolve(`receipts-${iteration}`); mkdirSync(receipts, {mode: 0o700});
const config = {specPath: resolve('private/Counter.tla'), invariant: 'TraceComplete', constInit: 'CInit', lengthBound: 6, paramVars: 'parameters'};
const suite = defineSuite({id: 'counter', adapterId: 'suite.counter', model: CounterModel,
  replay: {kind: 'corpus', config, traces: [resolve('private/counter.itf.json')]}, acceptance: {requiredActions: ['Tick']}});
const environment = {taskRef: 'counter', policyId: 'suite.counter', runtime: 'node-v1',
  gate: {kind: 'owned', launcher: {command: resolve(operator, 'bin/mirrorgate')}, policyFile: resolve('operator.json')}};
const options = variant => ({environment, mirror: resolve(operator, 'bin/mirror'),
  submission: {kind: 'source', input: {rootId: 'submission', relativePath: variant}, buildPlanId: 'node', authoring: false},
  timeouts: {registrationMs: 30000, actionMs: 3000, receiveMs: 30000, cleanupMs: 10000}});

for (const variant of ['correct', 'faulty', 'crash', 'hang', 'dispose-failure']) {
  const receiptPath = resolve(receipts, `${variant}.json`);
  const result = await evaluateSuite(suite, {...options(variant), receipt: {path: receiptPath}});
  const expected = variant === 'correct' ? 'passed' : variant === 'faulty' ? 'mismatch' : variant === 'hang' ? 'timedOut' : 'failed';
  assert.equal(result.outcome, expected, JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? String(value) : value));
  assert.equal(result.persistence.status, 'written');
  assert.equal(result.receipt.cleanup.remainingResources.length, 0);
  if (variant !== 'dispose-failure') assert.equal(result.receipt.cleanup.status, 'confirmed');
  else assert.notEqual(result.receipt.cleanup.status, 'confirmed');
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(receiptPath)).schema, 'mirrorgate.suite-receipt/v1');
  assert.deepEqual(Object.keys(result.publicResult).sort(), ['cleanup', 'runRef', 'schema', 'status']);
  assert(!JSON.stringify(result.publicResult).match(/private|traceIndex|expected|Tick/));
  console.log(JSON.stringify({iteration, variant, outcome: result.outcome, conformance: result.suiteResult?.conformance, cleanup: result.receipt.cleanup.status}));
}

// One Tick cannot satisfy a required adjacent pair, although every observation matches.
const unmet = defineSuite({...suite, replay: {...suite.replay, traces: [resolve('private/one-tick.itf.json')]}, acceptance: {requiredPairs: [['Tick', 'Tick']]}});
const unmetResult = await evaluateSuite(unmet, options('correct'));
assert.equal(unmetResult.outcome, 'failed'); assert.equal(unmetResult.suiteResult.conformance, 'matched');
assert.equal(unmetResult.suiteResult.failure.code, 'coverage_unmet'); assert.equal(unmetResult.receipt.cleanup.status, 'confirmed');

const wrongDescriptor = structuredClone(CounterModel.descriptor);
wrongDescriptor.runProfile.itfParamVars = ['ghost']; wrongDescriptor.runProfile.effectiveParamVars = ['ghost', 'parameters'];
const digest = semanticDescriptorDigest(decodeSemanticDescriptor(wrongDescriptor));
const wrongModel = {...CounterModel, descriptor: wrongDescriptor, semanticDigest: digest,
  metadata: {...CounterModel.metadata, semanticDigest: digest}, publicManifest: createSandboxPublicManifest(wrongDescriptor, digest)};
const denied = await evaluateSuite(defineSuite({...suite, model: wrongModel}), options('correct'));
assert.equal(denied.outcome, 'failed'); assert.equal(denied.suiteResult.conformance, 'not_evaluated');
assert.equal(denied.receipt.cleanup.status, 'confirmed');

const abort = new AbortController();
const pending = evaluateSuite(suite, {...options('hang'), signal: abort.signal});
const timer = setTimeout(() => abort.abort('private cancellation reason'), 1500);
const cancelled = await pending; clearTimeout(timer);
assert.equal(cancelled.outcome, 'cancelled'); assert.equal(cancelled.receipt.cleanup.status, 'confirmed');
const occupied = resolve(receipts, 'occupied.json'); writeFileSync(occupied, 'existing', {mode: 0o600});
const persistenceFailure = await evaluateSuite(suite, {...options('correct'), receipt: {path: occupied}});
assert.equal(persistenceFailure.outcome, 'failed'); assert.equal(persistenceFailure.persistence.status, 'failed');
assert.equal(persistenceFailure.suiteResult.outcome, 'passed'); assert.equal(persistenceFailure.receipt.cleanup.status, 'confirmed');
assert.equal(readFileSync(occupied, 'utf8'), 'existing');
console.log(JSON.stringify({iteration, coverage: 'unmet preserved', negotiation: 'denied', cancellation: 'joined', persistence: 'independent'}));
