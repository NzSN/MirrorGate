import type {EvaluationOutcome, PublicWorkflowResult} from '../dist/receipt.js';
export class EvaluationServiceError extends Error {readonly code:string;}
export interface EvaluationBinding {
  readonly suiteRef:string;
  readonly implementationRef:string;
  /** Fixed trusted callback: invoke evaluateImplementation(approvedPlan, {signal}). */
  readonly evaluate:(options:Readonly<{signal:AbortSignal}>)=>Promise<EvaluationOutcome>;
}
export interface EvaluationCaller {readonly id:string;readonly token:string;readonly bindings:readonly EvaluationBinding[];}
export interface EvaluationServiceLimits {
  readonly requestBytes:number;readonly responseBytes:number;readonly httpInFlight:number;
  readonly activeRuns:number;readonly activeRunsPerCaller:number;readonly lifetimeStarts:number;
  readonly retainedRuns:number;readonly retentionMs:number;readonly evaluationMs:number;
  readonly cleanupGraceMs:number;readonly progressRecords:number;readonly progressRecordBytes:number;
  readonly progressBytes:number;readonly requestsPerMinute:number;
}
export interface EvaluationRun {
  readonly runId:string;readonly startKey:string;readonly suiteRef:string;readonly implementationRef:string;
  readonly phase:'queued'|'running'|'cancelling'|'finished'|'unconfirmed';
  readonly progress:Readonly<{firstSeq:number;nextSeq:number;truncated:boolean;records:readonly Readonly<{seq:number;message:string}>[]}>;
  readonly result?:PublicWorkflowResult;
  readonly failure?:Readonly<{code:'WORKFLOW_FAILED'|'WORKFLOW_UNSETTLED';cleanup:'unconfirmed'}>;
}
export interface EvaluationService {
  readonly origin:string;readonly serviceEpoch:string;
  close():Promise<Readonly<{cleanup:'confirmed'|'unconfirmed';activeRuns:number}>>;
}
export function startEvaluationService(options:Readonly<{
  callers:readonly EvaluationCaller[];host?:'127.0.0.1'|'::1';port?:number;limits?:Partial<EvaluationServiceLimits>;
}>):Promise<EvaluationService>;
