import type { CompiledReplayReport } from "mirrorecma";
import type { Prepared } from "mirrorgate/control";
import type { ProviderCleanupReceipt } from "./provider.js";
import type { SandboxFailureFamily } from "./sandbox.js";

export const EVALUATION_RECEIPT_SCHEMA = "mirrorgate.evaluation-receipt/v1" as const;
export const PUBLIC_WORKFLOW_SCHEMA = "mirrorgate.evaluation/v1" as const;
export type EvaluationStatus = "passed" | "mismatch" | "failed" | "cancelled" | "timedOut";
export type EvaluationStage = "configuration" | "connect" | "open" | "authoring" | "prepare" | "provider" | "evaluate";
export type EvaluationFailureFamily = SandboxFailureFamily | "hosting";
export interface WorkflowDisclosurePolicy {
  readonly counts?: boolean;
  readonly implementationIdentity?: boolean;
  readonly failureStage?: boolean;
}
export interface TrustedEvaluationReceipt {
  readonly schema: typeof EVALUATION_RECEIPT_SCHEMA;
  readonly runId: string;
  readonly taskRef: string;
  readonly status: EvaluationStatus;
  readonly suite: Readonly<{id: string; revision: string; modelRevision: string}>;
  readonly modelInterface?: Readonly<{
    semanticDigest: string; adapterId: string; targetProfile: string; stateComputerContractVersion: string;
  }>;
  readonly hosting?: Readonly<{
    runId: string; outcome?: string;
    submission?: Readonly<{submissionId: string; sourceHash: string; sourceRevision: 1}>;
  }>;
  readonly implementation?: Readonly<Pick<Prepared,
    "preparedRevision" | "artifactId" | "artifactHash" | "sourceHash" | "manifestHash" | "runtime" | "policyId">>;
  readonly model: Readonly<{
    status: EvaluationStatus | "notRun";
    report?: CompiledReplayReport;
  }>;
  /** Trusted arbitrary rejection value; never serialize this field to an agent. */
  readonly primaryFailure?: Readonly<{stage: EvaluationStage; family: EvaluationFailureFamily; error: unknown}>;
  readonly cleanup: ProviderCleanupReceipt;
}
export interface PublicWorkflowResult {
  readonly schema: typeof PUBLIC_WORKFLOW_SCHEMA;
  /** Workflow UUID, never a Gate control/session/hosting identifier. */
  readonly runRef: string;
  readonly status: EvaluationStatus;
  readonly cleanup: ProviderCleanupReceipt["status"];
  readonly counts?: Readonly<{acceptedTraces: number; acceptedSteps: number}>;
  readonly implementation?: Readonly<{artifactHash: string; sourceHash?: string}>;
  readonly failureStage?: EvaluationStage;
}
export interface EvaluationOutcome {
  readonly receipt: TrustedEvaluationReceipt;
  readonly publicResult: PublicWorkflowResult;
}

/** Fixed allowlist; no custom exception rendering or trusted-object spreading. */
export function projectEvaluationReceipt(
  receipt: TrustedEvaluationReceipt, policy: WorkflowDisclosurePolicy = {},
): PublicWorkflowResult {
  const result: {
    schema: typeof PUBLIC_WORKFLOW_SCHEMA; runRef: string; status: EvaluationStatus;
    cleanup: ProviderCleanupReceipt["status"]; counts?: {acceptedTraces: number; acceptedSteps: number};
    implementation?: {artifactHash: string; sourceHash?: string}; failureStage?: EvaluationStage;
  } = {schema: PUBLIC_WORKFLOW_SCHEMA, runRef: receipt.runId, status: receipt.status, cleanup: receipt.cleanup.status};
  const report = receipt.model.report;
  if (policy.counts === true && report !== undefined &&
      Number.isSafeInteger(report.acceptedTraces) && report.acceptedTraces >= 0 &&
      Number.isSafeInteger(report.acceptedSteps) && report.acceptedSteps >= 0) {
    result.counts = Object.freeze({acceptedTraces: report.acceptedTraces, acceptedSteps: report.acceptedSteps});
  }
  const implementation = receipt.implementation;
  if (policy.implementationIdentity === true && implementation !== undefined && /^[0-9a-f]{64}$/.test(implementation.artifactHash)) {
    result.implementation = Object.freeze({artifactHash: implementation.artifactHash,
      ...(implementation.sourceHash !== undefined && /^[0-9a-f]{64}$/.test(implementation.sourceHash)
        ? {sourceHash: implementation.sourceHash} : {})});
  }
  if (policy.failureStage === true && receipt.primaryFailure !== undefined) result.failureStage = receipt.primaryFailure.stage;
  return Object.freeze(result);
}
