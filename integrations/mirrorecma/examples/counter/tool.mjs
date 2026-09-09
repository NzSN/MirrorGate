import { constants } from 'node:fs';
import { readFile, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createConfiguredHostingTool, serveHostingToolMcp } from 'mirrorgate/hosting-tool';
import { createHostedEvaluationHandler } from 'mirrorgate-mirrorecma';
import { counterPlan } from './evaluate.mjs';

const [configFile, flag, receiptFile, ...extra] = process.argv.slice(2);
if (!configFile || extra.length || (flag !== undefined && (flag !== '--receipt' || !receiptFile || !isAbsolute(receiptFile)))) {
  throw new Error('Usage: node tool.mjs <approved-config.json> [--receipt /private/new-receipt.json]');
}
const configuration = JSON.parse(await readFile(configFile, 'utf8'));
const plan = counterPlan(configuration);
if (!configuration.agent || plan.submission.kind !== 'source' || !plan.submission.authoring) {
  throw new Error('The hosting tool requires an approved managed-agent source configuration');
}
const endpoint = plan.gate;
if (endpoint.kind === 'attached' && (typeof process.getuid !== 'function' || endpoint.expectedOwner !== process.getuid())) {
  throw new Error('Attached hosting tools require the approved socket owner to be the current UID');
}
const controller = endpoint.kind === 'attached' ? {kind: 'attached', socketPath: endpoint.socketPath}
  : {kind: 'owned', controller: {
    command: endpoint.launcher.command,
    args: [...(endpoint.launcher.args ?? []), 'control', '--stdio', '--policy-file', endpoint.policyFile],
    ...(endpoint.launcher.cwd === undefined ? {} : {cwd: endpoint.launcher.cwd}),
    ...(endpoint.launcher.env === undefined ? {} : {env: endpoint.launcher.env}),
  }};
const evaluate = createHostedEvaluationHandler({[plan.taskRef]: plan});
const tool = createConfiguredHostingTool({schema: 'mirrorgate.hosting-tool/v1', controller,
  tasks: {[plan.taskRef]: {
    session: {policyId: plan.policyId, submission: plan.submission, runtime: plan.runtime,
      manifestJson: JSON.stringify(plan.model.publicManifest), modelRevisionId: plan.suite.modelRevision,
      ...(plan.limits === undefined ? {} : {limits: plan.limits})},
    agent: configuration.agent,
  }},
}, {onSubmitted: async context => {
  const outcome = await evaluate(context);
  if (receiptFile !== undefined) {
    // Operator-only diagnostic output. It is never part of an MCP tool result.
    // Exclusive creation avoids following/replacing an existing receipt path.
    const seen = new WeakSet();
    const json = JSON.stringify(outcome, (_key, value) => {
      if (typeof value === 'bigint') return value.toString();
      if (value !== null && typeof value === 'object') {
        if (seen.has(value)) return '[Repeated or cyclic diagnostic reference]';
        seen.add(value);
      }
      if (value instanceof Error) return {...value, name: value.name, message: value.message,
        ...(value.cause === undefined ? {} : {cause: value.cause})};
      return value;
    }, 2);
    const file = await open(receiptFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await file.writeFile(`${json}\n`); } finally { await file.close(); }
  }
  return outcome;
}});
const server = serveHostingToolMcp(tool);
process.exitCode = (await server.done).cleanupStatus === 'succeeded' ? 0 : 1;
