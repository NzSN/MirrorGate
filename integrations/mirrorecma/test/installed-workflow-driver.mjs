import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {evaluateCounter, counterPlan} from './evaluate.mjs';
import {createConfiguredHostingTool} from 'mirrorgate/hosting-tool';
import {createHostedEvaluationHandler} from 'mirrorgate-mirrorecma';

for (const variant of ['correct', 'faulty']) {
  const hosted = JSON.parse(readFileSync(`hosted-${variant}.json`, 'utf8'));
  const authored = await evaluateCounter(hosted);
  assert.equal(authored.receipt.status, variant === 'correct' ? 'passed' : 'mismatch', JSON.stringify(authored.publicResult));
  assert.equal(authored.receipt.hosting.outcome, 'submitted');
  assert.equal(authored.receipt.cleanup.status, 'confirmed');
  assert.equal(authored.receipt.hosting.submission.sourceHash, authored.receipt.implementation.sourceHash);
  assert.deepEqual(authored.receipt.cleanup.remainingResources, []);
  assert(!JSON.stringify(authored.publicResult).includes('private'));
  const prebuiltConfiguration = JSON.parse(readFileSync(`prebuilt-${variant}.json`, 'utf8'));
  const prebuilt = await evaluateCounter(prebuiltConfiguration);
  const source = await evaluateCounter({...prebuiltConfiguration, submission: {
    kind: 'source', input: prebuiltConfiguration.submission.input, buildPlanId: 'copy', authoring: false,
  }});
  assert.equal(source.receipt.status, authored.receipt.status);
  assert.equal(source.receipt.cleanup.status, 'confirmed');
  const cli = spawnSync(process.execPath, ['run.mjs', `prebuilt-${variant}.json`], {encoding: 'utf8', env: process.env});
  assert.equal(cli.error, undefined);
  assert.equal(cli.status, variant === 'correct' ? 0 : 1, cli.stderr);
  const cliResult = JSON.parse(cli.stdout.trim());
  assert.equal(cliResult.status, authored.receipt.status); assert.equal(cliResult.cleanup, 'confirmed');
  assert.equal(prebuilt.receipt.status, authored.receipt.status);
  assert.equal(prebuilt.receipt.cleanup.status, 'confirmed');
  assert.equal(prebuilt.receipt.hosting, undefined);
  console.log(JSON.stringify({case: variant, hosted: authored.receipt.status, source: source.receipt.status, prebuilt: prebuilt.receipt.status, cli: cliResult.status,
    sourceHash: authored.receipt.implementation.sourceHash, cleanup: authored.receipt.cleanup.status,
    guards: 'real authoring/build/execution private file and environment denied'}));
}
const configurations = ['correct', 'faulty'].map(variant => JSON.parse(readFileSync(`tool-${variant}.json`, 'utf8')));
const plans = Object.fromEntries(configurations.map(config => [config.taskRef, counterPlan(config)]));
const endpoint = configurations[0].gate;
const tool = createConfiguredHostingTool({schema: 'mirrorgate.hosting-tool/v1',
  controller: {kind: 'owned', controller: {command: endpoint.launcher.command,
    args: [...endpoint.launcher.args, 'control', '--stdio', '--policy-file', endpoint.policyFile]}},
  tasks: Object.fromEntries(configurations.map(config => [config.taskRef, {
    session: {policyId: config.policyId, submission: config.submission, runtime: 'node-v1',
      manifestJson: JSON.stringify(plans[config.taskRef].model.publicManifest)}, agent: config.agent,
  }])),
}, {onSubmitted: createHostedEvaluationHandler(plans)});
try {
  const starts = await Promise.all(configurations.map(config => tool.call('hosting_start', {taskRef: config.taskRef})));
  const completions = await Promise.all(starts.map(start => tool.completion(start.runRef)));
  assert.deepEqual(completions.map(completion => completion.result.receipt.status), ['passed', 'mismatch']);
  assert(completions.every(completion => completion.cleanup.status === 'succeeded'));
  for (const start of starts) {
    const visible = await tool.call('hosting_status', {runRef: start.runRef});
    assert.equal(visible.sessionCleanup.status, 'succeeded');
    assert.equal(visible.evaluation.phase, 'finished');
    assert(!JSON.stringify(visible).includes('PrivateInvariant'));
    assert.equal(visible.result, undefined);
  }
  console.log('STANDARD HOSTING TOOL -> SAME-OWNER WORKFLOW HANDOFF GREEN (TWO CONCURRENT RUNS)');
} finally { assert.equal((await tool.close()).cleanupStatus, 'succeeded'); }
console.log('INSTALLED WORKFLOW CONSUMER GREEN (SYNTHETIC AUTHOR, REAL RESTRICTED TOOLS/BUILD/WORKER)');
