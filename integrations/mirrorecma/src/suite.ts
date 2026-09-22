import * as mirrorEcma from "mirrorecma";
import type {
  SuiteDefinition,
  SuiteRunContext,
  SuiteResult,
  AsyncAdapterFactory,
  FrameworkCatalogSelectionRef,
  FrameworkApprovalDecision,
  InstalledFrameworkObservation,
} from "mirrorecma";
import type { StartAgentOptions } from "mirrorgate/control";
import { createSandboxCompiledModel, type SandboxPublicManifest } from "./sandbox-model.js";
import {
  evaluateNormalizedSuite, type EvaluationDefinition, type EvaluationSuiteContext,
  type HostedEvaluationContext, type ImplementationEvaluationPlan,
} from "./workflow.js";
import type {
  EvaluationStatus, TrustedEvaluationReceipt, PublicWorkflowResult, WorkflowDisclosurePolicy,
} from "./receipt.js";
import { writeTrustedReceipt, type ReceiptWriteOptions, type ReceiptPersistence } from "./receipt-writer.js";
import type { SandboxGateEndpoint, SandboxSubmission, SandboxTightenedLimits, SandboxWorkerRuntime } from "./sandbox.js";

export const SUITE_EVALUATION_SCHEMA = "mirrorgate.suite-evaluation/v1" as const;
export const SUITE_RECEIPT_SCHEMA = "mirrorgate.suite-receipt/v1" as const;

/** Operator-owned configuration. Agent requests must select an approved reference. */
export interface SuiteEnvironment {
  readonly taskRef: string;
  readonly policyId: string;
  readonly runtime: SandboxWorkerRuntime;
  readonly gate?: SandboxGateEndpoint;
  readonly limits?: SandboxTightenedLimits;
  readonly disclosure?: WorkflowDisclosurePolicy;
}
export interface EvaluateSuiteOptions extends SuiteRunContext {
  readonly environment: SuiteEnvironment;
  readonly submission?: SandboxSubmission;
  readonly agent?: StartAgentOptions;
  /** In-process handoff from the hosting tool, with its original dedicated owner. */
  readonly hosted?: HostedEvaluationContext;
  readonly hostingTimeoutMs?: number;
  readonly evaluationTimeoutMs?: number;
  readonly receipt?: ReceiptWriteOptions;
  /** Operator-selected installed distribution; pure rejection precedes Gate acquisition. */
  readonly framework?: Readonly<{
    catalogRaw: string;
    selectionRef: FrameworkCatalogSelectionRef;
    combinationId: string;
    observed: InstalledFrameworkObservation;
    approval?: FrameworkApprovalDecision;
  }>;
}
export interface SuiteEvaluationOutcome {
  readonly schema: typeof SUITE_EVALUATION_SCHEMA;
  /** Requested receipt persistence failure independently prevents overall success. */
  readonly outcome: EvaluationStatus;
  readonly receipt: TrustedEvaluationReceipt;
  readonly publicResult: PublicWorkflowResult;
  readonly suiteResult?: SuiteResult;
  readonly persistence: ReceiptPersistence;
}
export interface TrustedSuiteReceipt {
  readonly schema: typeof SUITE_RECEIPT_SCHEMA;
  readonly evaluation: TrustedEvaluationReceipt;
  readonly suiteResult?: SuiteResult;
}

type Context = SuiteRunContext & EvaluationSuiteContext;
type Dependencies = Parameters<typeof evaluateNormalizedSuite<Context>>[4];

/** Same suite/acceptance through Gate's retained physical owner and deferred factory. */
export function evaluateSuite<Port>(suite: SuiteDefinition<Port>, options: EvaluateSuiteOptions): Promise<SuiteEvaluationOutcome> {
  return evaluateSuiteWithDependencies(suite, options);
}

/** Test seam omitted from package exports. */
export async function evaluateSuiteWithDependencies<Port>(
  input: SuiteDefinition<Port>, options: EvaluateSuiteOptions, dependencies?: Dependencies,
): Promise<SuiteEvaluationOutcome> {
  if (options.framework !== undefined) {
    if (typeof mirrorEcma.preflightFrameworkSelection !== "function")
      throw new TypeError(
        "evaluateSuite requires a catalog-capable MirrorECMA installation",
      );
    const framework = mirrorEcma.preflightFrameworkSelection(
      options.framework.catalogRaw,
      {
        selectionRef: options.framework.selectionRef,
        combinationId: options.framework.combinationId,
        observed: options.framework.observed,
        approval: options.framework.approval,
      },
    );
    if (framework.status === "refused")
      throw Object.assign(
        new Error(
          `framework selection refused at ${framework.refusal.predicate}: ${framework.refusal.detail}`,
        ),
        { code: framework.refusal.code },
      );
  }
  // Validate/snapshot inert suite inputs before acquiring any Gate resource.
  if (typeof mirrorEcma.defineSuite !== "function" || typeof mirrorEcma.runSuiteWithFactory !== "function") {
    throw new TypeError("evaluateSuite requires a suite-capable MirrorECMA installation");
  }
  const suite = mirrorEcma.defineSuite(input);
  const environment = Object.freeze({...options.environment});
  if (options.hosted === undefined && (environment.gate === undefined || options.submission === undefined)) {
    throw new TypeError("suite evaluation requires an approved Gate endpoint and submission");
  }
  if (options.hosted !== undefined && (options.submission !== undefined || options.agent !== undefined)) {
    throw new TypeError("hosted suite evaluation consumes only the already submitted original owner");
  }
  const model = createSandboxCompiledModel({
    metadata: suite.model.metadata, descriptor: suite.model.descriptor, adapterId: suite.adapterId,
    publicManifest: suite.model.publicManifest as SandboxPublicManifest,
    targetProfile: suite.model.targetProfile, stateComputerContractVersion: suite.model.stateComputerContractVersion,
    bindPublicPort: suite.model.bindPublicPort,
  });
  const timeouts = Object.freeze({...mirrorEcma.DEFAULT_SUITE_TIMEOUTS, ...options.timeouts});
  if (Object.values(timeouts).some(value => !Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff)) {
    throw new TypeError("suite execution and cleanup budgets must be positive bounded integers");
  }
  const context: Context = Object.freeze({mirror: options.mirror, signal: options.signal, timeouts});
  const run = (current: Context, factory: AsyncAdapterFactory) => mirrorEcma.runSuiteWithFactory(suite, current, factory);
  const definition: EvaluationDefinition<Context> = {
    taskRef: environment.taskRef, policyId: environment.policyId, runtime: environment.runtime,
    model, disclosure: environment.disclosure,
    suite: {
      id: suite.id, revision: suite.replay.provenance?.corpusDigest ?? "unspecified",
      modelRevision: suite.replay.provenance?.modelSha256 ?? suite.model.semanticDigest,
      context,
      // Legacy callback is retained in the unchanged plan shape; normalized
      // execution always uses the additive workflow seam below.
      run: async (current, factory) => {
        const result = await run(current, factory);
        if (result.report === undefined) throw result.trustedError ?? result.failure;
        return result.report;
      },
    },
  };
  const plan = options.hosted === undefined ? {...definition, gate: environment.gate!, submission: options.submission!,
    limits: environment.limits, agent: options.agent} satisfies ImplementationEvaluationPlan<Context> : definition;
  const evaluated = await evaluateNormalizedSuite(plan, {
    signal: options.signal, hostingTimeoutMs: options.hostingTimeoutMs, evaluationTimeoutMs: options.evaluationTimeoutMs,
    requirePublicEnvironment: true,
    cleanupMs: timeouts.cleanupMs,
    deadlines: {
      ...(timeouts.registrationMs === undefined ? {} : {registrationMs: timeouts.registrationMs}),
      ...(timeouts.actionMs === undefined ? {} : {stepMs: timeouts.actionMs}),
      ...(timeouts.receiveMs === undefined ? {} : {receiveMs: timeouts.receiveMs}),
    },
  }, run, options.hosted, dependencies);
  const receipt: TrustedSuiteReceipt = Object.freeze({schema: SUITE_RECEIPT_SCHEMA,
    evaluation: evaluated.receipt, ...(evaluated.suiteResult === undefined ? {} : {suiteResult: evaluated.suiteResult})});
  // Persistence is attempted only after workflow cleanup, using a fresh signal
  // unless the operator explicitly supplies a persistence cancellation signal.
  const persistence = options.receipt === undefined ? Object.freeze({status: "not_requested" as const})
    : await writeTrustedReceipt(receipt, options.receipt);
  return Object.freeze({schema: SUITE_EVALUATION_SCHEMA,
    outcome: persistence.status === "failed" ? "failed" : evaluated.receipt.status,
    receipt: evaluated.receipt, publicResult: evaluated.publicResult,
    ...(evaluated.suiteResult === undefined ? {} : {suiteResult: evaluated.suiteResult}), persistence});
}
