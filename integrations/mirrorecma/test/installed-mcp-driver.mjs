import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline';
const receiptPath = resolve('private-mcp-receipt.json');
const child = spawn(process.execPath, ['tool.mjs', 'mcp-correct.json', '--receipt', receiptPath], {stdio: ['pipe', 'pipe', 'pipe']});
const pending = new Map(); let nextId = 0, stderr = '', transcript = '';
child.stderr.on('data', chunk => {stderr += chunk;});
const lines = createInterface({input: child.stdout});
lines.on('line', line => {
  transcript += `${line}\n`;
  const message = JSON.parse(line);
  const request = pending.get(message.id);
  if (request) {pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);}
});
const exited = new Promise((resolveExit, reject) => {
  child.once('error', reject); child.once('close', (code, signal) => resolveExit({code, signal}));
});
function request(method, params) {
  const id = ++nextId;
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => {pending.delete(id); reject(new Error(`MCP ${method} timed out: ${stderr}`));}, 30_000);
    pending.set(id, {resolve: resolveRequest, reject, timer});
    child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, ...(params === undefined ? {} : {params})})}\n`);
  });
}
async function tool(name, args) {
  const result = await request('tools/call', {name, arguments: args});
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
try {
  const initialized = await request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'installed-acceptance', version: '1'}});
  assert.equal(initialized.serverInfo.name, 'mirrorgate-hosting-tool');
  assert.equal((await request('tools/list', {})).tools.length, 3);
  const start = await tool('hosting_start', {taskRef: 'counter-correct'});
  let status;
  const deadline = performance.now() + 45_000;
  do {
    status = await tool('hosting_status', {runRef: start.runRef});
    if (status.sessionCleanup) break;
    assert(performance.now() < deadline, 'MCP Counter did not settle');
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  } while (true);
  assert.equal(status.evaluation.phase, 'finished', JSON.stringify(status));
  assert.equal(status.sessionCleanup.status, 'succeeded');
  assert.equal(status.result, undefined, 'private callback result must not be exposed by MCP');
  const outcome = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(outcome.receipt.model.status, 'passed');
  assert.equal(outcome.receipt.cleanup.status, 'confirmed');
  assert.equal(outcome.receipt.hosting.submission.sourceHash, outcome.receipt.implementation.sourceHash);
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
  assert(!transcript.includes('private-mcp-receipt.json'));
  assert(!transcript.includes('GATE_WORKFLOW_SECRET'));
  console.log('SHIPPED COUNTER MCP ENTRYPOINT + PRIVATE RECEIPT GREEN');
} finally {
  child.stdin.end();
  let timer;
  try {
    const result = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => {child.kill('SIGTERM'); reject(new Error('MCP example cleanup deadline exceeded'));}, 15_000);
    })]);
    assert.equal(result.code, 0, stderr); assert.equal(result.signal, null);
  } finally {clearTimeout(timer); for (const entry of pending.values()) clearTimeout(entry.timer); lines.close();}
}
