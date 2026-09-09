import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {manifest} from './helpers.mjs';

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// Test-only controller; it exercises actual installed MCP -> SDK control framing,
// not sandbox admission or an agent runtime. Production adapter has no such fallback.
const syntheticController = `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const log = process.argv[2];
const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
const sessionId='2'.repeat(32), runId='3'.repeat(32); let seq=0;
const limits={maxFrameBytes:1048576,maxJsonDepth:128,maxJsonNodes:16384,maxPendingOutputBytes:4194304,maxSessionsPerConnection:4,maxInflightRequestsPerConnection:16,maxCompletedOperationsPerSession:128,helloTimeoutMs:5000,requestAckTimeoutMs:10000,workerAttachmentTimeoutMs:5000,sessionWallMs:600000,gracefulStopMs:1000,teardownMs:5000};
const hosted={runId,phase:'finished',outcome:'submitted',cleanup:{status:'succeeded',remainingResources:[]},limits:{wallMs:300000,stdoutBytes:1048576,stderrBytes:1048576,progressRecords:256,progressBytes:262144,progressRecordBytes:16384},progress:{firstSeq:1,nextSeq:1,truncated:false,records:[]},submission:{submissionId:'4'.repeat(32),sourceHash:'a'.repeat(64),sourceRevision:1}};
const cleanup={phase:'closed',cleanupStatus:'succeeded',remainingResources:[]};
const operations=new Map();
const input=createInterface({input:process.stdin});
input.on('line',line=>{
  const q=JSON.parse(line);appendFileSync(log,JSON.stringify(q)+'\\n');
  const respond=result=>write({v:q.op==='hello'?1:2,kind:'response',id:q.id,ok:true,result});
  if(q.op==='hello')respond({controlVersion:2,instanceId:'1'.repeat(32),capabilities:q.args.requiredCapabilities.map(id=>({id,available:true,enforcedScope:'session',limits:{}})),limits});
  else if(q.op==='session.open')respond({sessionId});
  else if(q.op==='agent.start'){respond({runId});write({v:2,kind:'event',seq:++seq,sessionId,event:'agent.finished',data:{run:hosted}});}
  else if(q.op==='agent.status'||q.op==='agent.cancel')respond({run:hosted});
  else if(q.op==='session.close'||q.op==='session.cancel'){
    const outcome={operationId:q.id,status:'succeeded',result:cleanup};operations.set(q.id,outcome);respond({operationId:q.id});
    write({v:2,kind:'event',seq:++seq,sessionId,event:'operation.finished',data:outcome});
  }else if(q.op==='operation.status')respond(operations.get(q.args.operationId));
});
input.on('close',()=>appendFileSync(log,JSON.stringify({event:'owner.eof'})+'\\n'));
`;

test('packed hosting tool provides typed v2 SDK and configuration-only real MCP dispatch', {timeout: 60_000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mirrorgate-hosting-package-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await run('npm', ['pack', '--pack-destination', directory], {cwd: root, env: {...process.env, npm_config_cache: join(directory, 'npm-cache')}});
  const consumer = join(directory, 'consumer');
  const packageRoot = join(consumer, 'node_modules/mirrorgate');
  await mkdir(packageRoot, {recursive: true});
  await run('tar', ['-xzf', join(directory, `${metadata.name}-${metadata.version}.tgz`), '--strip-components=1', '-C', packageRoot]);
  const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(installed.bin['mirrorgate-hosting-tool'], 'integrations/agent-host/cli.mjs');
  assert.equal(installed.exports['./hosting-tool'].import, './integrations/agent-host/index.mjs');
  await run(process.execPath, ['--input-type=module', '--eval', `
    import {ControlClient, HostedAgentRun} from 'mirrorgate/control';
    import {createHostingTool, createConfiguredHostingTool, serveHostingToolMcp} from 'mirrorgate/hosting-tool';
    for (const fn of [ControlClient,HostedAgentRun,createHostingTool,createConfiguredHostingTool,serveHostingToolMcp]) if(typeof fn!=='function')throw new Error('missing public export');
  `], {cwd: consumer});
  await writeFile(join(consumer, 'consumer.mts'), `
    import {ControlClient, type ControlSession, type HostedRun, type PublicTask} from 'mirrorgate/control';
    import {createHostingTool, type HostedSubmissionContext, type ApprovedHostingTask} from 'mirrorgate/hosting-tool';
    const task:PublicTask={instructions:'public',files:[]};
    async function host(session:ControlSession):Promise<Readonly<HostedRun>> {
      const run=await session.startAgent({profileId:'codex',publicTask:task});
      await session.agentStatus(); return run.cancel();
    }
    function configured(tasks:Record<string,ApprovedHostingTask>) {
      return createHostingTool({connect:()=>ControlClient.connectUnix({controlVersion:2,socketPath:'/operator/gate.sock'}),tasks,
        onSubmitted:async(context:HostedSubmissionContext)=>{context.completeCleanup({status:'succeeded'});return context.run.submission?.sourceHash;}});
    }
    void host;void configured;
  `);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({compilerOptions: {target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM'], strict: true, noEmit: true, skipLibCheck: false}, files: ['consumer.mts']}));
  await run(process.env.MIRRORGATE_TSC ?? join(root, 'node_modules/.bin/tsc'), ['--project', 'tsconfig.json'], {cwd: consumer});

  const controller = join(directory, 'synthetic-controller.mjs'), log = join(directory, 'control.jsonl');
  await writeFile(controller, syntheticController);
  const config = join(directory, 'hosting.json');
  await writeFile(config, JSON.stringify({schema: 'mirrorgate.hosting-tool/v1', controller: {kind: 'owned', controller: {command: process.execPath, args: [controller, log]}}, tasks: {
    counter: {session: {policyId: 'default', submission: {kind: 'source', input: {rootId: 'submissions', relativePath: 'counter'}, buildPlanId: 'node-build', authoring: true}, runtime: 'node-v1', manifestJson: JSON.stringify(manifest)}, agent: {profileId: 'codex', publicTask: {instructions: 'Approved public Counter brief', files: []}}},
  }}), {mode: 0o600});
  await chmod(config, 0o600);
  const child = spawn(process.execPath, [join(packageRoot, installed.bin['mirrorgate-hosting-tool']), '--config', config], {cwd: consumer, stdio: ['pipe', 'pipe', 'pipe']});
  t.after(() => child.kill('SIGKILL'));
  let id = 0, buffer = '', stderr = '';
  const pending = new Map(); const all = [];
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), response = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      all.push(response); pending.get(response.id)?.resolve(response); pending.delete(response.id);
    }
  });
  const exited = new Promise(resolveExit => child.once('close', (code, signal) => {
    for (const request of pending.values()) request.reject(new Error(`CLI exited (${code}/${signal}): ${stderr}`));
    resolveExit(code);
  }));
  const request = (method, params) => new Promise((resolveReply, reject) => {
    const requestId = ++id; pending.set(requestId, {resolve: resolveReply, reject});
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: requestId, method, params}) + '\n');
  });
  const initialization = await request('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'actual-test-dispatcher', version: '1'}});
  assert.equal(initialization.result.serverInfo.name, 'mirrorgate-hosting-tool');
  assert.equal((await request('tools/list', {_meta: {progressToken: 0}})).result.tools.length, 3);
  const accepted = await request('tools/call', {name: 'hosting_start', arguments: {taskRef: 'counter'}});
  assert.equal(accepted.result.isError, undefined);
  const started = JSON.parse(accepted.result.content[0].text);
  const queried = await request('tools/call', {name: 'hosting_status', arguments: {taskRef: 'counter'}});
  assert.equal(JSON.parse(queried.result.content[0].text).runRef, started.runRef);
  const duplicate = await request('tools/call', {name: 'hosting_start', arguments: {taskRef: 'counter'}});
  assert.equal(duplicate.result.isError, true);
  const denied = await request('tools/call', {name: 'hosting_start', arguments: {taskRef: 'counter', profileId: 'unrestricted'}});
  assert.equal(denied.result.isError, true);
  child.stdin.end();
  assert.equal(await exited, 0, stderr);
  assert.equal(stderr, '');
  const operations = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(operations.filter(x => x.op === 'hello').length, 1);
  assert.deepEqual(operations[0].args.controlVersions, [2]);
  assert.ok(operations[0].args.requiredCapabilities.includes('hosting.fresh-agent-v1'));
  assert.equal(operations.filter(x => x.op === 'agent.start').length, 1);
  assert.equal(operations.find(x => x.op === 'agent.start').args.publicTask.instructions, 'Approved public Counter brief');
  assert.ok(operations.some(x => x.op === 'session.cancel'));
  assert.equal(operations.at(-1).event, 'owner.eof');
  const publicWire = JSON.stringify(all);
  for (const forbidden of [config, controller, 'manifestJson', 'attachmentToken', '2'.repeat(32), '3'.repeat(32), '4'.repeat(32)]) assert.equal(publicWire.includes(forbidden), false);
});
