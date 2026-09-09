import http from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {EvaluationServiceError,MESSAGES,exact,fail,handle,limits as checkedLimits,parse,publicResult,reference,request} from './protocol.mjs';
export {EvaluationServiceError} from './protocol.mjs';

const id=()=>randomBytes(16).toString('hex');
const hash=token=>createHash('sha256').update(token).digest('hex');
const encoded=value=>Buffer.from(JSON.stringify(value));
const terminal=record=>record.phase==='finished'||record.phase==='unconfirmed';
function readBody(req,maxBytes){
  return new Promise((resolve,reject)=>{
    let size=0;const chunks=[];
    const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);};
    const error=()=>{cleanup();reject(new EvaluationServiceError('ARGUMENT_INVALID'));};
    const aborted=error;
    const data=chunk=>{size+=chunk.length;if(size>maxBytes){cleanup();req.resume();reject(new EvaluationServiceError('LIMIT_EXCEEDED'));}else chunks.push(chunk);};
    const end=()=>{cleanup();resolve(Buffer.concat(chunks));};
    const timer=setTimeout(error,5000);timer.unref();
    req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',aborted);
  });
}
const statusCodes={UNAUTHORIZED:401,ARGUMENT_INVALID:400,LIMIT_EXCEEDED:429,REFERENCE_UNKNOWN:404,RUN_UNKNOWN:404,
  RUN_EXPIRED:404,START_CONFLICT:409,STALE_EPOCH:409,SERVICE_UNAVAILABLE:503};

/** Local authenticated transport around installed callbacks to Gate's R3 workflow. */
export async function startEvaluationService(options){
  exact(options,['callers'],['host','port','limits']);
  const host=options.host??'127.0.0.1',port=options.port??0;
  if(!['127.0.0.1','::1'].includes(host)||!Number.isSafeInteger(port)||port<0||port>65535)fail();
  const limits=checkedLimits(options.limits),epoch=id(),callers=new Map(),callerIds=new Set();
  if(!Array.isArray(options.callers)||options.callers.length<1||options.callers.length>64)fail();
  for(const input of options.callers){
    exact(input,['id','token','bindings']);reference(input.id);
    if(typeof input.token!=='string'||!(/^[0-9a-f]{64}$/).test(input.token)||callerIds.has(input.id)||callers.has(hash(input.token)))fail();
    if(!Array.isArray(input.bindings)||input.bindings.length<1||input.bindings.length>128)fail();
    const bindings=new Map();
    for(const binding of input.bindings){
      exact(binding,['suiteRef','implementationRef','evaluate']);reference(binding.suiteRef);reference(binding.implementationRef);
      if(typeof binding.evaluate!=='function')fail();
      const key=JSON.stringify([binding.suiteRef,binding.implementationRef]);if(bindings.has(key))fail();
      bindings.set(key,binding.evaluate);
    }
    callers.set(hash(input.token),{id:input.id,bindings,starts:new Map(),active:0,requests:0,window:Date.now()});callerIds.add(input.id);
  }
  const records=new Map(),sockets=new Set();let active=0,accepted=0,inflight=0,closing=false,uncertain=false,closingPromise;
  function progress(record,message){
    const p=record.progress;p.records.push({seq:p.nextSeq++,message});
    while(p.records.length&&(p.records.length>limits.progressRecords
      ||p.records.some(r=>encoded(r).length>limits.progressRecordBytes)
      ||p.records.reduce((n,r)=>n+encoded(r).length,0)>limits.progressBytes))p.records.shift();
    p.firstSeq=p.nextSeq-p.records.length;p.truncated=p.firstSeq>1;
  }
  function snapshot(record){
    return structuredClone({runId:record.runId,startKey:record.startKey,suiteRef:record.suiteRef,
      implementationRef:record.implementationRef,phase:record.phase,progress:record.progress,
      ...(record.result===undefined?{}:{result:record.result}),...(record.failure===undefined?{}:{failure:record.failure})});
  }
  function prune(){
    const completed=[...records.values()].filter(r=>r.settled&&terminal(r)).sort((a,b)=>a.settledAt-b.settledAt);
    while(completed.length&&(completed.length>limits.retainedRuns||Date.now()-completed[0].settledAt>=limits.retentionMs)){
      const record=completed.shift();records.delete(record.runId);record.caller.starts.get(record.startKey).expired=true;
    }
  }
  function unconfirmed(record,code){
    if(terminal(record))return;
    uncertain=true;record.phase='unconfirmed';record.failure={code,cleanup:'unconfirmed'};
    progress(record,'Workflow cleanup is unconfirmed');
  }
  function cancel(record){
    if(terminal(record)||record.controller.signal.aborted)return;
    record.phase='cancelling';progress(record,'Evaluation cancellation requested');record.controller.abort();
    record.grace=setTimeout(()=>unconfirmed(record,'WORKFLOW_UNSETTLED'),limits.cleanupGraceMs);record.grace.unref();
  }
  function launch(record,evaluate){
    if(!record.controller.signal.aborted){record.phase='running';progress(record,'Evaluation workflow running');}
    record.timer=setTimeout(()=>cancel(record),limits.evaluationMs);record.timer.unref();
    // Only the registered R3 callback owns model/worker/cleanup composition.
    record.promise=Promise.resolve().then(()=>evaluate({signal:record.controller.signal})).then(outcome=>{
      if(terminal(record))return;
      record.result=publicResult(outcome?.publicResult);if(record.result.cleanup!=='confirmed')uncertain=true;record.phase='finished';progress(record,'Evaluation workflow settled');
    }).catch(()=>unconfirmed(record,'WORKFLOW_FAILED')).finally(()=>{
      clearTimeout(record.timer);clearTimeout(record.grace);record.settled=true;record.settledAt=Date.now();
      record.caller.active--;active--;prune();
    });
  }
  function dispatch(caller,message){
    prune();const args=message.args;
    if(message.op==='hello')return {serviceEpoch:epoch,limits};
    if(args.serviceEpoch!==epoch)fail('STALE_EPOCH');
    if(message.op==='start'){
      const existing=caller.starts.get(args.startKey);
      if(existing){
        if(existing.suiteRef!==args.suiteRef||existing.implementationRef!==args.implementationRef)fail('START_CONFLICT');
        if(existing.expired)fail('RUN_EXPIRED');return {run:snapshot(records.get(existing.runId))};
      }
      if(closing)fail('SERVICE_UNAVAILABLE');
      const evaluate=caller.bindings.get(JSON.stringify([args.suiteRef,args.implementationRef]));
      if(evaluate===undefined)fail('REFERENCE_UNKNOWN');
      if(active>=limits.activeRuns||caller.active>=limits.activeRunsPerCaller||accepted>=limits.lifetimeStarts)fail('LIMIT_EXCEEDED');
      const record={runId:id(),startKey:args.startKey,suiteRef:args.suiteRef,implementationRef:args.implementationRef,
        phase:'queued',progress:{firstSeq:1,nextSeq:1,truncated:false,records:[]},caller,controller:new AbortController(),settled:false};
      progress(record,'Evaluation accepted');records.set(record.runId,record);
      caller.starts.set(args.startKey,{runId:record.runId,suiteRef:record.suiteRef,implementationRef:record.implementationRef,expired:false});
      caller.active++;active++;accepted++;
      queueMicrotask(()=>launch(record,evaluate));
      return {run:snapshot(record)};
    }
    const ref=args.runId===undefined?caller.starts.get(args.startKey):undefined;
    if(ref?.expired)fail('RUN_EXPIRED');
    const record=records.get(args.runId??ref?.runId);
    if(record===undefined||record.caller!==caller)fail('RUN_UNKNOWN');
    if(message.op==='cancel')cancel(record);
    return {run:snapshot(record)};
  }
  function reply(res,requestId,result,error){
    const code=error instanceof EvaluationServiceError?error.code:'SERVICE_UNAVAILABLE';
    const message=error?{v:1,requestId,ok:false,error:{code,message:MESSAGES[code]}}:{v:1,requestId,ok:true,result};
    let data=encoded(message);
    if(data.length>limits.responseBytes){data=encoded({v:1,requestId,ok:false,error:{code:'LIMIT_EXCEEDED',message:MESSAGES.LIMIT_EXCEEDED}});res.statusCode=429;}
    else res.statusCode=error?statusCodes[code]:200;
    res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');res.setHeader('content-length',data.length);res.end(data);
  }
  const server=http.createServer({maxHeaderSize:4096,requestTimeout:5000,headersTimeout:5000,keepAliveTimeout:1000,connectionsCheckingInterval:100},async(req,res)=>{
    if(inflight>=limits.httpInFlight){res.setHeader('connection','close');req.resume();reply(res,null,undefined,new EvaluationServiceError('LIMIT_EXCEEDED'));return;}
    inflight++;let finished=false;const release=()=>{if(!finished){finished=true;inflight--;}};res.once('close',release);res.once('finish',release);
    let requestId=null;
    try{
      const auth=req.headers.authorization;
      if(typeof auth!=='string'||!/^Bearer [0-9a-f]{64}$/.test(auth))fail('UNAUTHORIZED');
      const caller=callers.get(hash(auth.slice(7)));if(caller===undefined)fail('UNAUTHORIZED');
      if(Date.now()-caller.window>=60000){caller.window=Date.now();caller.requests=0;}
      if(++caller.requests>limits.requestsPerMinute)fail('LIMIT_EXCEEDED');
      if(req.method!=='POST'||req.url!=='/v1/evaluations'||req.headers['content-type']!=='application/json'||req.headers['content-encoding']!==undefined)fail();
      const raw=parse(await readBody(req,limits.requestBytes),limits.requestBytes);
      try{requestId=handle(raw?.requestId);}catch{}
      const message=request(raw);const result=dispatch(caller,message);reply(res,requestId,result);
    }catch(error){if(!req.complete)res.setHeader('connection','close');if(!res.destroyed)reply(res,requestId,undefined,error instanceof EvaluationServiceError?error:new EvaluationServiceError('ARGUMENT_INVALID'));req.resume();}
  });
  server.maxConnections=64;server.maxRequestsPerSocket=32;
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.on('clientError',(_error,socket)=>{socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host,port},()=>{server.off('error',reject);resolve();});});
  const address=server.address();const origin=`http://${host==='::1'?'[::1]':host}:${address.port}`;
  const retention=setInterval(prune,Math.min(1000,limits.retentionMs));retention.unref();
  async function close(){
    if(closingPromise!==undefined)return closingPromise;
    closing=true;clearInterval(retention);
    closingPromise=(async()=>{
      const stopped=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();
      for(const record of records.values())if(!record.settled)cancel(record);
      const pending=[...records.values()].filter(r=>!r.settled);
      let timer;
      await Promise.race([Promise.all(pending.map(r=>r.promise??Promise.resolve())),new Promise(resolve=>{timer=setTimeout(resolve,limits.cleanupGraceMs);})]);
      clearTimeout(timer);
      for(const record of pending)if(!record.settled)unconfirmed(record,'WORKFLOW_UNSETTLED');
      for(const socket of sockets)socket.destroy();await stopped;
      return Object.freeze({cleanup:active===0&&!uncertain?'confirmed':'unconfirmed',activeRuns:active});
    })();return closingPromise;
  }
  return Object.freeze({origin,serviceEpoch:epoch,close});
}
