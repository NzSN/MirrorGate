import {evaluateImplementation,type ImplementationEvaluationPlan,type EvaluationSuiteContext} from 'mirrorgate-mirrorecma';
import {startEvaluationService,type EvaluationBinding,type EvaluationService} from 'mirrorgate-mirrorecma/service';
import {connectEvaluationService,newEvaluationStartKey,type EvaluationServiceProxy} from 'mirrorgate-mirrorecma/service/proxy';
declare const plan:ImplementationEvaluationPlan<EvaluationSuiteContext>;
declare const token:string;
const binding:EvaluationBinding={suiteRef:'Counter.v1',implementationRef:'candidate.v1',evaluate:({signal})=>evaluateImplementation(plan,{signal})};
const server:Promise<EvaluationService>=startEvaluationService({callers:[{id:'ci',token,bindings:[binding]}]});
const client:Promise<EvaluationServiceProxy>=connectEvaluationService({origin:'http://127.0.0.1:1234',token});
void server;void client;
declare const proxy:EvaluationServiceProxy;
void proxy.start({startKey:newEvaluationStartKey(),suiteRef:'Counter.v1',implementationRef:'candidate.v1'});
void proxy.get({startKey:newEvaluationStartKey()});
// @ts-expect-error A get request cannot combine independent reference types.
void proxy.get({runId:newEvaluationStartKey(),startKey:newEvaluationStartKey()});
