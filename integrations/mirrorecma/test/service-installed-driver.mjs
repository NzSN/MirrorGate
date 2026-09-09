// Installed-consumer test: same source suite through local and Gate-backed service paths.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {ReplayMismatchError,semanticDigestFromHex} from 'mirrorecma';
import {startEvaluationService} from 'mirrorgate-mirrorecma/service';
import {connectEvaluationService,newEvaluationStartKey} from 'mirrorgate-mirrorecma/service/proxy';
import {evaluateCounter,counterPlan} from './evaluate.mjs';
import {runCounterSuite} from './dist/suite.js';
import {bindCounterAsync,CounterSemanticDigest} from './dist/CounterMirror.generated.js';

const configurations=Object.fromEntries(['correct','faulty'].map(variant=>[variant,JSON.parse(readFileSync(`prebuilt-${variant}.json`,'utf8'))]));
const token=randomBytes(32).toString('hex');
const receipts=new Map();let evaluations=0;
const service=await startEvaluationService({callers:[{id:'installed-ci',token,bindings:['correct','faulty'].map(variant=>({
  suiteRef:'Counter.v1',implementationRef:`${variant}.v1`,
  evaluate:async({signal})=>{evaluations++;const result=await evaluateCounter(configurations[variant],{signal});receipts.set(variant,result.receipt);return result;},
}))}]});
try{
  const proxy=await connectEvaluationService({origin:service.origin,token});
  for(const variant of ['correct','faulty']){
    const plan=counterPlan(configurations[variant]);let localReport,localFailure;let creations=0,disposals=0;
    try{
      localReport=await runCounterSuite(plan.suite.context,async config=>{
        creations++;let count=0n,disposed=false;
        const active=()=>{assert(!disposed);};
        const binding=bindCounterAsync({initialize:async()=>{active();count=0n;},
          tick:async({stride})=>{active();count+=stride-(variant==='faulty'?1n:0n);},
          observe:async()=>{active();return {count};}},config);
        return {...binding,semanticDigest:semanticDigestFromHex(CounterSemanticDigest),dispose:()=>{disposed=true;disposals++;}};
      });
    }catch(error){localFailure=error;}
    assert.equal(creations,1);assert.equal(disposals,1);
    if(variant==='faulty')assert(localFailure instanceof ReplayMismatchError);else assert.equal(localFailure,undefined);
    const start={startKey:newEvaluationStartKey(),suiteRef:'Counter.v1',implementationRef:`${variant}.v1`};
    const accepted=await proxy.start(start);
    const replay=await proxy.start(start);assert.equal(replay.runId,accepted.runId);
    const record=await proxy.wait(accepted.runId,{pollMs:100,timeoutMs:60000});
    assert.equal(record.phase,'finished');assert.equal(record.result.status,variant==='correct'?'passed':'mismatch');
    assert.equal(record.result.cleanup,'confirmed');assert.deepEqual(receipts.get(variant).cleanup.remainingResources,[]);
    if(localReport)assert.deepEqual(record.result.counts,{acceptedTraces:localReport.acceptedTraces,acceptedSteps:localReport.acceptedSteps});
    const serialized=JSON.stringify(record);
    for(const privateTerm of ['private-canary','private evaluator secret','specPath','tracePaths','primaryFailure','expected'])assert(!serialized.includes(privateTerm));
    assert(!serialized.includes(token));
    console.log(JSON.stringify({path:'installed-service',variant,sourceSuite:variant==='correct'?'passed':'mismatch',
      serviceSuite:record.result.status,cleanup:record.result.cleanup,counts:record.result.counts}));
  }
  assert.equal(evaluations,2,'replayed start key must not create another R3 owner');
}finally{
  assert.deepEqual(await service.close(),{cleanup:'confirmed',activeRuns:0});
}
console.log('INSTALLED HTTP PROXY + SAME SOURCE SUITE + REAL GATE/MIRRORS EQUIVALENCE GREEN');
