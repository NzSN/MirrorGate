import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {EvaluationServiceError,exact,fail,LIMITS,parse,request as validateRequest,response as validateResponse} from './protocol.mjs';
export {EvaluationServiceError} from './protocol.mjs';
export const newEvaluationStartKey=()=>randomBytes(16).toString('hex');

/** No retries or redirects. Callers retain startKey before sending a start. */
export async function connectEvaluationService(options){
  exact(options,['origin','token'],['requestTimeoutMs','signal']);
  if(typeof options.origin!=='string')fail();
  let origin;try{origin=new URL(options.origin);}catch{fail();}
  if(origin.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(origin.hostname)||origin.username||origin.password
      ||origin.pathname!=='/'||origin.search||origin.hash)fail();
  if(typeof options.token!=='string'||!(/^[0-9a-f]{64}$/).test(options.token))fail();
  const timeout=options.requestTimeoutMs??5000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>10000)fail();
  let maximums=LIMITS;
  async function call(op,args,signal,requestBudget=timeout){
    const message=validateRequest({v:1,requestId:randomBytes(16).toString('hex'),op,args});
    const data=Buffer.from(JSON.stringify(message));if(data.length>maximums.requestBytes)fail('LIMIT_EXCEEDED');
    return new Promise((resolve,reject)=>{
      let complete=false,timer;
      const finish=(error,value)=>{if(complete)return;complete=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const req=http.request(new URL('/v1/evaluations',origin),{method:'POST',headers:{'content-type':'application/json',
        authorization:`Bearer ${options.token}`,'content-length':data.length},agent:false},res=>{
        const rejectResponse=error=>{
          // Record the protocol failure before destroy emits transport errors.
          // A rejected body is not drained: it may never end.
          finish(error);res.destroy();req.destroy();
        };
        if(res.statusCode>=300&&res.statusCode<400){rejectResponse(new EvaluationServiceError('SERVICE_UNAVAILABLE'));return;}
        if(res.headers['content-type']!=='application/json'){rejectResponse(new EvaluationServiceError('ARGUMENT_INVALID'));return;}
        const chunks=[];let bytes=0;
        res.on('data',chunk=>{bytes+=chunk.length;if(bytes>maximums.responseBytes){rejectResponse(new EvaluationServiceError('LIMIT_EXCEEDED'));}else chunks.push(chunk);});
        res.once('error',()=>finish(new EvaluationServiceError('SERVICE_UNAVAILABLE')));
        res.once('end',()=>{
          try{
            const response=validateResponse(parse(Buffer.concat(chunks),maximums.responseBytes),message,maximums);
            if(!response.ok)throw new EvaluationServiceError(response.error.code);
            if(res.statusCode!==200)throw new EvaluationServiceError('ARGUMENT_INVALID');
            finish(undefined,response.result);
          }catch(error){finish(error instanceof EvaluationServiceError?error:new EvaluationServiceError('ARGUMENT_INVALID'));}
        });
      });
      const abort=()=>{finish(new DOMException('Request aborted','AbortError'));req.destroy();};
      timer=setTimeout(()=>{finish(new EvaluationServiceError('SERVICE_UNAVAILABLE'));req.destroy();},Math.min(timeout,requestBudget));timer.unref();
      req.once('error',()=>finish(new EvaluationServiceError('SERVICE_UNAVAILABLE')));
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return;}
      req.end(data);
    });
  }
  const hello=await call('hello',{},options.signal);maximums=Object.freeze(hello.limits);
  const serviceEpoch=hello.serviceEpoch;
  return Object.freeze({serviceEpoch,limits:maximums,
    async start(input,callOptions={}){
      exact(input,['startKey','suiteRef','implementationRef']);const {startKey,suiteRef,implementationRef}=input;
      return (await call('start',{serviceEpoch,startKey,suiteRef,implementationRef},callOptions.signal)).run;
    },
    async get(reference,callOptions={}){
      exact(reference,[],['runId','startKey']);
      return (await call('get',{serviceEpoch,...reference},callOptions.signal)).run;
    },
    async cancel(runId,callOptions={}){
      return (await call('cancel',{serviceEpoch,runId},callOptions.signal)).run;
    },
    async wait(runId,{signal,pollMs=50,timeoutMs=maximums.evaluationMs+maximums.cleanupGraceMs+1000}={}){
      if(!Number.isSafeInteger(pollMs)||pollMs<1||pollMs>10000||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)fail();
      const deadline=performance.now()+timeoutMs;
      while(true){
        if(signal?.aborted)throw new DOMException('Wait aborted','AbortError');
        const remaining=deadline-performance.now();
        if(remaining<=0)throw new EvaluationServiceError('SERVICE_UNAVAILABLE');
        // Expiring a local readonly request never issues service cancellation.
        const run=(await call('get',{serviceEpoch,runId},signal,remaining)).run;
        if(performance.now()>=deadline)throw new EvaluationServiceError('SERVICE_UNAVAILABLE');
        if(run.phase==='finished'||run.phase==='unconfirmed')return run;
        await new Promise((resolve,reject)=>{
          const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new DOMException('Wait aborted','AbortError'));};
          const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},Math.max(0,Math.min(pollMs,deadline-performance.now())));
          signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
        });
      }
    },
  });
}
