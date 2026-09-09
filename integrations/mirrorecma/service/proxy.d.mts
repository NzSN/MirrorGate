import type {EvaluationRun,EvaluationServiceLimits} from './index.mjs';
export {EvaluationServiceError} from './index.mjs';
export function newEvaluationStartKey():string;
export interface EvaluationServiceProxy {
  readonly serviceEpoch:string;readonly limits:EvaluationServiceLimits;
  start(input:Readonly<{startKey:string;suiteRef:string;implementationRef:string}>,options?:Readonly<{signal?:AbortSignal}>):Promise<EvaluationRun>;
  get(reference:Readonly<{runId:string;startKey?:never}|{startKey:string;runId?:never}>,options?:Readonly<{signal?:AbortSignal}>):Promise<EvaluationRun>;
  cancel(runId:string,options?:Readonly<{signal?:AbortSignal}>):Promise<EvaluationRun>;
  /** Aborting this poll does not cancel the service-owned evaluation. */
  wait(runId:string,options?:Readonly<{signal?:AbortSignal;pollMs?:number;timeoutMs?:number}>):Promise<EvaluationRun>;
}
export function connectEvaluationService(options:Readonly<{
  origin:string;token:string;requestTimeoutMs?:number;signal?:AbortSignal;
}>):Promise<EvaluationServiceProxy>;
