import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {startEvaluationService} from '../service/index.mjs';
import {connectEvaluationService,newEvaluationStartKey} from '../service/proxy.mjs';
import {projectEvaluationReceipt,type EvaluationOutcome,type TrustedEvaluationReceipt} from '../src/receipt.js';
const token='a'.repeat(64),otherToken='b'.repeat(64);
const input=()=>({startKey:newEvaluationStartKey(),suiteRef:'Counter.v1',implementationRef:'correct.v1'});
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
function outcome(status:'passed'|'cancelled'='passed'):EvaluationOutcome{
  const receipt={schema:'mirrorgate.evaluation-receipt/v1',runId:randomUUID(),taskRef:'private-task',status,
    suite:{id:'Counter',revision:'private-revision',modelRevision:'private-model'},model:{status:'notRun'},
    primaryFailure:{stage:'evaluate',family:'adapter',error:new Error('/private/trace expected=99 SECRET')},
    cleanup:{status:'confirmed',remainingResources:[],failures:[]}} as unknown as TrustedEvaluationReceipt;
  return {receipt,publicResult:projectEvaluationReceipt(receipt)};
}
const services:Awaited<ReturnType<typeof startEvaluationService>>[]=[];
afterEach(async()=>{await Promise.all(services.splice(0).map(service=>service.close()));});
async function fixture(evaluate:(options:{signal:AbortSignal})=>Promise<EvaluationOutcome>,limits={}){
  const binding={suiteRef:'Counter.v1',implementationRef:'correct.v1',evaluate};
  const service=await startEvaluationService({callers:[{id:'alice',token,bindings:[binding]},{id:'bob',token:otherToken,bindings:[binding]}],limits});
  services.push(service);const proxy=await connectEvaluationService({origin:service.origin,token});return {service,proxy};
}
async function raw(origin:string,body:string,bearer=token){
  const response=await fetch(`${origin}/v1/evaluations`,{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json'},body});
  return {status:response.status,body:await response.json() as any};
}
test('real HTTP proxy preserves fixed callback results and duplicate/lost-start correlation',async()=>{
  const expected=outcome();let calls=0;const f=await fixture(async()=>{calls++;return expected;});const request=input();
  const first=await f.proxy.start(request),duplicate=await f.proxy.start(request);
  expect(first.runId).toBe(duplicate.runId);expect((await f.proxy.get({startKey:request.startKey})).runId).toBe(first.runId);
  const result=await f.proxy.wait(first.runId,{pollMs:5});expect(result.result).toEqual(expected.publicResult);expect(calls).toBe(1);
  expect(JSON.stringify(result)).not.toMatch(/SECRET|private|expected=99|receipt|primaryFailure/);
  await expect(f.proxy.start({...request,implementationRef:'different'})).rejects.toMatchObject({code:'START_CONFLICT'});
});
test('authentication, caller ownership, approved references and stale epochs fail closed',async()=>{
  const f=await fixture(async()=>outcome());const first=await f.proxy.start(input());
  const other=await connectEvaluationService({origin:f.service.origin,token:otherToken});
  await expect(other.get({runId:first.runId})).rejects.toMatchObject({code:'RUN_UNKNOWN'});
  await expect(other.cancel(first.runId)).rejects.toMatchObject({code:'RUN_UNKNOWN'});
  await expect(f.proxy.start({...input(),suiteRef:'unknown'})).rejects.toMatchObject({code:'REFERENCE_UNKNOWN'});
  await expect(connectEvaluationService({origin:f.service.origin,token:'c'.repeat(64)})).rejects.toMatchObject({code:'UNAUTHORIZED'});
  const stale=await raw(f.service.origin,JSON.stringify({v:1,requestId:newEvaluationStartKey(),op:'start',args:{...input(),serviceEpoch:'1'.repeat(32)}}));
  expect(stale.status).toBe(409);expect(stale.body.error.code).toBe('STALE_EPOCH');
});
test('strict JSON, closed records and body limits reject malformed input before callback',async()=>{
  let calls=0;const f=await fixture(async()=>{calls++;return outcome();});
  const message={v:1,requestId:newEvaluationStartKey(),op:'start',args:{...input(),serviceEpoch:f.service.serviceEpoch}};
  for(const body of [JSON.stringify({...message,args:{...message.args,path:'/private/evil.js'}}),
    JSON.stringify(message).replace('"v":1','"v":1,"v":1'),JSON.stringify(message).replace('"v":1','"v":1.5'),
    JSON.stringify(message).replace('"v":1','"v":9007199254740992'),'{"x":"\\ud800"}']){
    const result=await raw(f.service.origin,body);expect(result.status).toBe(400);expect(result.body.ok).toBe(false);expect(JSON.stringify(result.body)).not.toContain('/private');
  }
  const large=await raw(f.service.origin,' '.repeat(16385));expect(large.status).toBe(429);expect(calls).toBe(0);
});
test('cancellation acknowledgement precedes shared callback cleanup',async()=>{
  let cleaned=false;
  const f=await fixture(async({signal})=>{await new Promise<void>(resolve=>{signal.addEventListener('abort',()=>resolve(),{once:true});if(signal.aborted)resolve();});await delay(25);cleaned=true;return outcome('cancelled');});
  const started=await f.proxy.start(input()),ack=await f.proxy.cancel(started.runId);
  expect(ack.phase).toBe('cancelling');expect(cleaned).toBe(false);
  const result=await f.proxy.wait(started.runId,{pollMs:5});expect(result.phase).toBe('finished');expect(result.result?.cleanup).toBe('confirmed');expect(cleaned).toBe(true);
});
test('HTTP disconnect preserves service ownership and recovery by start key',async()=>{
  const entered=deferred<void>(),finish=deferred<EvaluationOutcome>();let aborts=0,calls=0;
  const f=await fixture(async({signal})=>{calls++;signal.addEventListener('abort',()=>aborts++);entered.resolve();return finish.promise;});
  const start=input(),message={v:1,requestId:newEvaluationStartKey(),op:'start',args:{...start,serviceEpoch:f.service.serviceEpoch}};
  const req=http.request(`${f.service.origin}/v1/evaluations`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}},res=>res.resume());
  req.on('error',()=>{});req.end(JSON.stringify(message));await entered.promise;req.destroy();
  const recovered=await f.proxy.get({startKey:start.startKey});expect(recovered.phase).toBe('running');expect(aborts).toBe(0);expect(calls).toBe(1);
  finish.resolve(outcome());expect((await f.proxy.wait(recovered.runId,{pollMs:5})).phase).toBe('finished');
});
test('unsettled callbacks retain capacity and never fabricate a cleanup receipt',async()=>{
  const pending=deferred<EvaluationOutcome>();const f=await fixture(async()=>pending.promise,{activeRuns:1,activeRunsPerCaller:1,evaluationMs:20,cleanupGraceMs:20});
  const started=await f.proxy.start(input()),result=await f.proxy.wait(started.runId,{pollMs:5});
  expect(result.phase).toBe('unconfirmed');expect(result.result).toBeUndefined();expect(result.failure?.code).toBe('WORKFLOW_UNSETTLED');
  await expect(f.proxy.start(input())).rejects.toMatchObject({code:'LIMIT_EXCEEDED'});
  pending.resolve(outcome());await delay(5);expect((await f.proxy.get({runId:started.runId})).phase).toBe('unconfirmed');
  expect((await f.service.close()).cleanup).toBe('unconfirmed');
});
test('expired records retain tombstones and lifetime admission remains bounded',async()=>{
  let calls=0;const f=await fixture(async()=>{calls++;return outcome();},{retainedRuns:1,lifetimeStarts:2});
  const one=input(),first=await f.proxy.start(one);await f.proxy.wait(first.runId,{pollMs:5});
  const second=await f.proxy.start(input());await f.proxy.wait(second.runId,{pollMs:5});
  await expect(f.proxy.get({startKey:one.startKey})).rejects.toMatchObject({code:'RUN_EXPIRED'});
  await expect(f.proxy.start(one)).rejects.toMatchObject({code:'RUN_EXPIRED'});
  await expect(f.proxy.start(input())).rejects.toMatchObject({code:'LIMIT_EXCEEDED'});expect(calls).toBe(2);
});
test('malformed public projection and thrown exceptions never disclose trusted data',async()=>{
  const bad={...outcome(),publicResult:{...outcome().publicResult,privateReport:'SECRET'}};
  const f=await fixture(async()=>bad as EvaluationOutcome),first=await f.proxy.start(input());
  const result=await f.proxy.wait(first.runId,{pollMs:5});expect(result.phase).toBe('unconfirmed');expect(result.failure?.code).toBe('WORKFLOW_FAILED');expect(JSON.stringify(result)).not.toContain('SECRET');
  const g=await fixture(async()=>{throw new Error('/secret/private-script.js');}),second=await g.proxy.start(input());
  expect(JSON.stringify(await g.proxy.wait(second.runId,{pollMs:5}))).not.toContain('/secret');
});
test('fixed request rates and literal-loopback-only URLs reject floods and unsafe endpoints',async()=>{
  const f=await fixture(async()=>outcome(),{requestsPerMinute:2});await f.proxy.start(input());
  await expect(f.proxy.get({runId:'1'.repeat(32)})).rejects.toMatchObject({code:'LIMIT_EXCEEDED'});
  for(const origin of ['https://127.0.0.1','http://localhost','http://192.0.2.1','http://127.0.0.1/private','http://user@127.0.0.1'])
    await expect(connectEvaluationService({origin,token})).rejects.toMatchObject({code:'ARGUMENT_INVALID'});
  await expect(startEvaluationService({host:'0.0.0.0' as '127.0.0.1',callers:[]})).rejects.toMatchObject({code:'ARGUMENT_INVALID'});
});
test('shutdown aborts active R3 callback and joins its independent cleanup',async()=>{
  const entered=deferred<void>();let cleaned=false;
  const f=await fixture(async({signal})=>{entered.resolve();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));await delay(15);cleaned=true;return outcome('cancelled');});
  await f.proxy.start(input());await entered.promise;
  expect(await f.service.close()).toEqual({cleanup:'confirmed',activeRuns:0});expect(cleaned).toBe(true);
});

test('incomplete authenticated body expires within the fixed transport budget',async()=>{
  let calls=0;const f=await fixture(async()=>{calls++;return outcome();});const started=Date.now();
  const result=await new Promise<{status:number;body:any}>((resolve,reject)=>{
    const req=http.request(`${f.service.origin}/v1/evaluations`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','content-length':100}},res=>{
      const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{req.destroy();resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())});});
    });
    req.on('error',reject);req.write('{');
  });
  expect(result.status).toBe(400);expect(result.body.error.code).toBe('ARGUMENT_INVALID');
  expect(Date.now()-started).toBeLessThan(6500);expect(calls).toBe(0);
},10000);

test.each([
  [302,'application/json','SERVICE_UNAVAILABLE'],
  [200,'text/plain','ARGUMENT_INVALID'],
] as const)('proxy closes stalled rejected response %s/%s and preserves its original error',async(status,contentType,code)=>{
  const sockets=new Set<import('node:net').Socket>();let requests=0;
  const server=http.createServer((req,res)=>{
    requests++;req.resume();res.writeHead(status,{'content-type':contentType});res.write('body never finishes');
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as import('node:net').AddressInfo;
  try{
    await expect(connectEvaluationService({origin:`http://127.0.0.1:${address.port}`,token,requestTimeoutMs:500})).rejects.toMatchObject({code});
    const deadline=Date.now()+500;
    while(sockets.size&&Date.now()<deadline)await delay(5);
    expect(sockets.size).toBe(0);expect(requests).toBe(1);
  }finally{
    for(const socket of sockets)socket.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test('callback getter mutations are absent from the validated public snapshot',async()=>{
  const original=outcome();const live:Record<string,unknown>={...original.publicResult};
  Object.defineProperty(live,'counts',{enumerable:true,get(){
    live.privateDiagnostic='SYNTHETIC_PRIVATE_DIAGNOSTIC';
    return {acceptedTraces:0,acceptedSteps:0};
  }});
  const f=await fixture(async()=>({...original,publicResult:live} as unknown as EvaluationOutcome));
  const started=await f.proxy.start(input()),result=await f.proxy.wait(started.runId,{pollMs:5});
  expect(live.privateDiagnostic).toBe('SYNTHETIC_PRIVATE_DIAGNOSTIC');
  expect(result.phase).toBe('finished');expect(result.result?.counts).toEqual({acceptedTraces:0,acceptedSteps:0});
  expect(JSON.stringify(result)).not.toMatch(/privateDiagnostic|SYNTHETIC_PRIVATE_DIAGNOSTIC/);
});

test('invalid getter-produced snapshot yields only generic workflow failure',async()=>{
  const original=outcome();const live={...original.publicResult};
  Object.defineProperty(live,'counts',{enumerable:true,get(){
    return {acceptedTraces:0,acceptedSteps:0,privateDiagnostic:'SYNTHETIC_PRIVATE_DIAGNOSTIC'};
  }});
  const f=await fixture(async()=>({...original,publicResult:live}));
  const started=await f.proxy.start(input()),result=await f.proxy.wait(started.runId,{pollMs:5});
  expect(result.phase).toBe('unconfirmed');expect(result.failure).toEqual({code:'WORKFLOW_FAILED',cleanup:'unconfirmed'});
  expect(JSON.stringify(result)).not.toMatch(/privateDiagnostic|SYNTHETIC_PRIVATE_DIAGNOSTIC/);
});

test.each(['deadline','abort'] as const)('wait %s bounds a delayed readonly get and never cancels the evaluation',async(mode)=>{
  const reached=deferred<void>(),release=deferred<void>();const sockets=new Set<import('node:net').Socket>();
  const operations:string[]=[];let delayedSettlements=0;
  const runId='b'.repeat(32);
  const record={runId,startKey:'c'.repeat(32),suiteRef:'Counter.v1',implementationRef:'correct.v1',phase:'finished',
    progress:{firstSeq:1,nextSeq:1,truncated:false,records:[]},result:outcome().publicResult};
  const server=http.createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
    const message=JSON.parse(Buffer.concat(chunks).toString());operations.push(message.op);
    if(message.op!=='hello'){reached.resolve();await release.promise;delayedSettlements++;}
    res.writeHead(200,{'content-type':'application/json'});
    const result=message.op==='hello'?{serviceEpoch:'a'.repeat(32),limits:(await import('../service/protocol.mjs')).LIMITS}:{run:record};
    res.end(JSON.stringify({v:1,requestId:message.requestId,ok:true,result}));
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as import('node:net').AddressInfo;
  try{
    const proxy=await connectEvaluationService({origin:`http://127.0.0.1:${address.port}`,token,requestTimeoutMs:500});
    const controller=new AbortController();const started=performance.now();
    const pending=proxy.wait(runId,{timeoutMs:mode==='deadline'?20:1000,pollMs:1,signal:controller.signal});
    const observed=pending.then(value=>({kind:'value',value}),error=>({kind:'error',error}));
    await reached.promise;if(mode==='abort')controller.abort();
    const result=await Promise.race([observed,delay(250).then(()=>({kind:'unsettled'}))]);
    expect(result.kind).toBe('error');
    if(result.kind==='error')expect(result.error).toMatchObject(mode==='deadline'?{code:'SERVICE_UNAVAILABLE'}:{name:'AbortError'});
    expect(performance.now()-started).toBeLessThan(250);
    const deadline=Date.now()+100;while(sockets.size&&Date.now()<deadline)await delay(5);
    expect(sockets.size).toBe(0);expect(operations).toEqual(['hello','get']);
    release.resolve();await delay(10);expect(delayedSettlements).toBe(1);
    expect((await observed).kind).toBe('error');
  }finally{
    release.resolve();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
