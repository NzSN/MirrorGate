import {parseControlJson} from 'mirrorgate/control';

export const LIMITS = Object.freeze({requestBytes:16384,responseBytes:65536,httpInFlight:32,
  activeRuns:16,activeRunsPerCaller:4,lifetimeStarts:4096,retainedRuns:128,retentionMs:300000,
  evaluationMs:300000,cleanupGraceMs:5000,progressRecords:32,progressRecordBytes:1024,
  progressBytes:16384,requestsPerMinute:600});
const HANDLE=/^[0-9a-f]{32}$/;
const REF=/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST=/^[0-9a-f]{64}$/;
export const MESSAGES=Object.freeze({UNAUTHORIZED:'Caller authentication failed',ARGUMENT_INVALID:'Invalid evaluation request',
  LIMIT_EXCEEDED:'Evaluation service limit exceeded',REFERENCE_UNKNOWN:'Approved evaluation reference unavailable',
  RUN_UNKNOWN:'Evaluation run unavailable',RUN_EXPIRED:'Evaluation record expired',START_CONFLICT:'Start key already has different references',
  STALE_EPOCH:'Evaluation service epoch changed',SERVICE_UNAVAILABLE:'Evaluation service unavailable'});
export class EvaluationServiceError extends Error {
  constructor(code){super(MESSAGES[code]??'Evaluation service unavailable');this.name='EvaluationServiceError';this.code=code;}
}
export function fail(code='ARGUMENT_INVALID'){throw new EvaluationServiceError(code);}
export function exact(value,required,optional=[]){
  if(value===null||typeof value!=='object'||Array.isArray(value))fail();
  const allowed=new Set([...required,...optional]);
  if(required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!allowed.has(key)))fail();
  return value;
}
export function handle(value){if(typeof value!=='string'||!HANDLE.test(value))fail();return value;}
export function reference(value){if(typeof value!=='string'||!REF.test(value))fail();return value;}
const enumeration=(value,values)=>{if(!values.includes(value))fail();};
function integer(value,minimum=0){if(!Number.isSafeInteger(value)||value<minimum)fail();}
export function limits(input={}){
  exact(input,[],Object.keys(LIMITS));const result={...LIMITS};
  for(const [key,value] of Object.entries(input)){integer(value,1);if(value>LIMITS[key])fail('LIMIT_EXCEEDED');result[key]=value;}
  if(result.requestBytes<256||result.responseBytes<2048||result.progressBytes+2048>result.responseBytes)fail('LIMIT_EXCEEDED');
  return Object.freeze(result);
}
function bounds(root){
  let nodes=0;const pending=[[root,0]];
  while(pending.length){const [value,depth]=pending.pop();if(++nodes>2048||depth>16)fail('LIMIT_EXCEEDED');
    if(value&&typeof value==='object')for(const child of Object.values(value))pending.push([child,depth+1]);
  }
}
export function parse(bytes,maxBytes){
  if(!Buffer.isBuffer(bytes)||bytes.length>maxBytes)fail('LIMIT_EXCEEDED');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail();}
  let value;try{value=parseControlJson(text,maxBytes);}catch{fail();}
  bounds(value);return value;
}
export function request(value){
  exact(value,['v','requestId','op','args']);if(value.v!==1)fail();handle(value.requestId);
  if(value.op==='hello'){exact(value.args,[]);return value;}
  if(value.op==='start'){
    exact(value.args,['serviceEpoch','startKey','suiteRef','implementationRef']);
    handle(value.args.startKey);reference(value.args.suiteRef);reference(value.args.implementationRef);
  }else if(value.op==='get'){
    exact(value.args,['serviceEpoch'],['runId','startKey']);
    if(Object.hasOwn(value.args,'runId')===Object.hasOwn(value.args,'startKey'))fail();
    handle(value.args.runId??value.args.startKey);
  }else if(value.op==='cancel'){exact(value.args,['serviceEpoch','runId']);handle(value.args.runId);}
  else fail();
  handle(value.args.serviceEpoch);return value;
}
export function publicResult(value){
  // Callback values may contain getters. Validate the detached snapshot that is
  // actually returned, never a live shape that cloning can subsequently change.
  try{value=structuredClone(value);}catch{fail();}
  exact(value,['schema','runRef','status','cleanup'],['counts','implementation','failureStage']);
  if(value.schema!=='mirrorgate.evaluation/v1'||typeof value.runRef!=='string'||!UUID.test(value.runRef))fail();
  enumeration(value.status,['passed','mismatch','failed','cancelled','timedOut']);
  enumeration(value.cleanup,['confirmed','failed','unconfirmed']);
  if(value.counts!==undefined){exact(value.counts,['acceptedTraces','acceptedSteps']);integer(value.counts.acceptedTraces);integer(value.counts.acceptedSteps);}
  if(value.implementation!==undefined){exact(value.implementation,['artifactHash'],['sourceHash']);
    for(const digest of Object.values(value.implementation))if(typeof digest!=='string'||!DIGEST.test(digest))fail();}
  if(value.failureStage!==undefined)enumeration(value.failureStage,['configuration','connect','open','authoring','prepare','provider','evaluate']);
  if(value.counts!==undefined)Object.freeze(value.counts);
  if(value.implementation!==undefined)Object.freeze(value.implementation);
  return Object.freeze(value);
}
export function run(value,max=LIMITS){
  exact(value,['runId','startKey','suiteRef','implementationRef','phase','progress'],['result','failure']);
  handle(value.runId);handle(value.startKey);reference(value.suiteRef);reference(value.implementationRef);
  enumeration(value.phase,['queued','running','cancelling','finished','unconfirmed']);
  if(value.phase==='finished'){if(value.result===undefined||value.failure!==undefined)fail();publicResult(value.result);}
  else if(value.result!==undefined)fail();
  if(value.phase==='unconfirmed'){exact(value.failure,['code','cleanup']);enumeration(value.failure.code,['WORKFLOW_FAILED','WORKFLOW_UNSETTLED']);if(value.failure.cleanup!=='unconfirmed')fail();}
  else if(value.failure!==undefined)fail();
  const progress=exact(value.progress,['firstSeq','nextSeq','truncated','records']);integer(progress.firstSeq,1);integer(progress.nextSeq,1);
  if(typeof progress.truncated!=='boolean'||progress.truncated!==(progress.firstSeq>1)||!Array.isArray(progress.records)
    ||progress.records.length>max.progressRecords||progress.nextSeq!==progress.firstSeq+progress.records.length)fail();
  let bytes=0;
  for(const [index,record] of progress.records.entries()){
    exact(record,['seq','message']);if(record.seq!==progress.firstSeq+index||typeof record.message!=='string')fail();
    const size=Buffer.byteLength(JSON.stringify(record));if(size>max.progressRecordBytes)fail('LIMIT_EXCEEDED');bytes+=size;
  }
  if(bytes>max.progressBytes)fail('LIMIT_EXCEEDED');return value;
}
export function response(value,req,max=LIMITS){
  if(value?.ok===true){exact(value,['v','requestId','ok','result']);
    if(req.op==='hello'){exact(value.result,['serviceEpoch','limits']);handle(value.result.serviceEpoch);
      exact(value.result.limits,Object.keys(LIMITS));limits(value.result.limits);
    }else{exact(value.result,['run']);run(value.result.run,max);
      const result=value.result.run,args=req.args;
      if(args.runId!==undefined&&result.runId!==args.runId||args.startKey!==undefined&&result.startKey!==args.startKey)fail();
      if(req.op==='start'&&(result.suiteRef!==args.suiteRef||result.implementationRef!==args.implementationRef))fail();
    }
  }else{exact(value,['v','requestId','ok','error']);if(value.ok!==false)fail();exact(value.error,['code','message']);
    if(!Object.hasOwn(MESSAGES,value.error.code)||value.error.message!==MESSAGES[value.error.code])fail();}
  if(value.v!==1||(value.requestId!==req.requestId&&!(value.ok===false&&value.requestId===null&&['UNAUTHORIZED','ARGUMENT_INVALID','LIMIT_EXCEEDED','SERVICE_UNAVAILABLE'].includes(value.error.code))))fail();return value;
}
