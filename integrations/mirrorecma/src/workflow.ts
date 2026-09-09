import { randomUUID } from "node:crypto";
import type { ControlClient, ControlSession, HostedRun, HostedAgentRun, StartAgentOptions, Prepared, OutcomeSummary } from "mirrorgate/control";
import {
  ReplayCancelledError, ReplayDeadlineError, ReplayMismatchError, normalizeReplayDeadlines,
  type AsyncAdapterFactory, type CompiledReplayReport, type ReplayDeadlines,
} from "mirrorecma";
import { prepareSandboxModel, type SandboxCompiledModel } from "./sandbox-model.js";
import {
  connectGate, loadGateSdk, waitSucceeded, cleanupTag, errorFamily, isCancelled, isTimedOut, isDefinitiveSessionOpenFailure,
  type SandboxGateEndpoint, type SandboxSubmission, type SandboxTightenedLimits,
  type SandboxWorkerRuntime, type SandboxEvaluationOptions,
} from "./sandbox.js";
import {
  createPreparedImplementationProvider, PreparedImplementationError,
  type PreparedImplementationProvider, type ProviderCleanupReceipt,
} from "./provider.js";
import { awaitAuthoringOperation } from "./authoring-wait.js";
import {
  EVALUATION_RECEIPT_SCHEMA, projectEvaluationReceipt,
  type EvaluationOutcome, type EvaluationStage, type EvaluationStatus,
  type TrustedEvaluationReceipt, type WorkflowDisclosurePolicy,
} from "./receipt.js";

export interface EvaluationSuiteContext {
  readonly signal?: AbortSignal;
  readonly deadlines?: Partial<ReplayDeadlines>;
}
export interface ApprovedEvaluationSuite<C extends EvaluationSuiteContext> {
  readonly id: string;
  readonly revision: string;
  readonly modelRevision: string;
  readonly context: C;
  readonly run: (context: C, implementationFactory: AsyncAdapterFactory) => Promise<CompiledReplayReport>;
}
export interface EvaluationDefinition<C extends EvaluationSuiteContext> {
  readonly taskRef: string;
  readonly policyId: string;
  readonly runtime: SandboxWorkerRuntime;
  readonly model: SandboxCompiledModel;
  readonly suite: ApprovedEvaluationSuite<C>;
  readonly disclosure?: WorkflowDisclosurePolicy;
}
export interface ImplementationEvaluationPlan<C extends EvaluationSuiteContext> extends EvaluationDefinition<C> {
  readonly gate: SandboxGateEndpoint;
  readonly submission: SandboxSubmission;
  readonly agent?: StartAgentOptions;
  readonly limits?: SandboxTightenedLimits;
}
export interface EvaluationWorkflowOptions {
  readonly signal?: AbortSignal;
  readonly deadlines?: Partial<ReplayDeadlines>;
  readonly hostingTimeoutMs?: number;
  readonly evaluationTimeoutMs?: number;
  readonly onDiagnostic?: SandboxEvaluationOptions["onDiagnostic"];
}
export interface HostedEvaluationContext {
  readonly client: ControlClient;
  readonly session: ControlSession;
  readonly run: Readonly<HostedRun>;
  readonly taskRef: string;
  readonly signal: AbortSignal;
  /** Trusted hosting-tool receipt handoff, never exposed as an agent tool. */
  readonly completeCleanup?: (receipt: {status: "succeeded" | "failed"}) => void;
}

function duration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 0x7fffffff) throw new TypeError(`${label} is invalid`);
  return result;
}
function reference(value: string, label: string): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,128}$/.test(value)) throw new TypeError(`${label} must be a bounded reference`);
  return value;
}
function summaryStatus(error: unknown): EvaluationStatus {
  try {
    if (error instanceof ReplayMismatchError) return "mismatch";
    if (isTimedOut(error)) return "timedOut";
    if (isCancelled(error)) return "cancelled";
  } catch { /* Arbitrary suite rejection values never escape receipt construction. */ }
  return "failed";
}
function submissionIdentity(run: Readonly<HostedRun>): void {
  if (run.phase !== "finished" || run.outcome !== "submitted" || run.cleanup.status !== "succeeded" ||
      run.cleanup.remainingResources.length !== 0 || run.submission === undefined ||
      run.submission.sourceRevision !== 1 || !/^[0-9a-f]{64}$/.test(run.submission.sourceHash)) {
    if (run.outcome === "cancelled") throw new ReplayCancelledError("hosted author cancelled");
    if (run.outcome === "timedOut") throw new ReplayDeadlineError("registration", run.limits.wallMs);
    throw new Error("hosted author did not produce a committed submission with confirmed cleanup");
  }
}
function cleanupReceipt(status: ProviderCleanupReceipt["status"], failures: readonly unknown[] = [], remainingResources: readonly string[] = []): ProviderCleanupReceipt {
  return Object.freeze({status, failures: Object.freeze([...failures].slice(0, 32)), remainingResources: Object.freeze([...remainingResources])});
}
async function closeOwner(client: ControlClient | undefined, session: ControlSession | undefined,
  summary: OutcomeSummary, timeoutMs: number, sessionOpenUnconfirmed = false): Promise<ProviderCleanupReceipt> {
  if (client === undefined) return cleanupReceipt("confirmed");
  const failures: unknown[] = [];
  let cleanup: Awaited<ReturnType<ControlSession["status"]>>["cleanup"] | undefined;
  let phase: string | undefined;
  let clientClosed = false;
  if (session !== undefined) {
    try {
      const operation = summary.status === "cancelled" || summary.status === "timedOut"
        ? await session.cancel(summary.status === "timedOut" ? "deadline" : "user-cancel", {timeoutMs})
        : await session.close(summary, {timeoutMs});
      const result = await waitSucceeded(operation, undefined, timeoutMs);
      cleanup = {status: result.cleanupStatus, remainingResources: result.remainingResources};
      phase = result.phase;
    } catch (error) { failures.push(error); }
  }
  try { await client.close(); clientClosed = true; } catch (error) { failures.push(error); }
  if (sessionOpenUnconfirmed && session === undefined) {
    failures.push(new Error("session open was not acknowledged; session cleanup remains unconfirmed"));
  }
  const status = session === undefined ? (clientClosed && !sessionOpenUnconfirmed ? "confirmed" : "unconfirmed")
    : cleanupTag(cleanup === undefined ? undefined : {phase: phase!, cleanupStatus: cleanup.status, remainingResources: cleanup.remainingResources}, clientClosed);
  return cleanupReceipt(status === "confirmed" && failures.length ? "failed" : status,
    failures, cleanup?.remainingResources);
}

interface WorkflowDependencies {
  connect: (endpoint: SandboxGateEndpoint, capabilities: readonly string[], version: 1 | 2) => Promise<ControlClient>;
}
const defaultDependencies: WorkflowDependencies = {
  connect: async (endpoint, capabilities, version) => connectGate({gate: endpoint}, await loadGateSdk(), capabilities, version) as unknown as ControlClient,
};
/** Test seam omitted from package exports. */
export function evaluateImplementationWithDependencies<C extends EvaluationSuiteContext>(
  plan: ImplementationEvaluationPlan<C>, options: EvaluationWorkflowOptions, dependencies: WorkflowDependencies,
): Promise<EvaluationOutcome> { return evaluate(plan, options, undefined, dependencies); }

/** Gate-owned lifecycle; the supplied suite remains ordinary implementation-neutral MBT. */
export function evaluateImplementation<C extends EvaluationSuiteContext>(
  plan: ImplementationEvaluationPlan<C>, options: EvaluationWorkflowOptions = {},
): Promise<EvaluationOutcome> {
  return evaluate(plan, options);
}
/** Consume an already submitted source on the hosting tool's original dedicated owner. */
export function evaluateHostedSubmission<C extends EvaluationSuiteContext>(
  context: HostedEvaluationContext, plan: EvaluationDefinition<C>, options: EvaluationWorkflowOptions = {},
): Promise<EvaluationOutcome> {
  // Refuse ambiguous ownership before consuming either connection.
  if (context.session.client !== context.client || context.taskRef !== plan.taskRef) {
    return Promise.reject(new TypeError("hosted evaluation must retain its original task and owner"));
  }
  return evaluate(plan, options, context);
}
/** Exact approved task lookup suitable for createHostingTool({onSubmitted: ...}). */
export function createHostedEvaluationHandler<C extends EvaluationSuiteContext>(
  plans: Readonly<Record<string, EvaluationDefinition<C>>>, options: EvaluationWorkflowOptions = {},
): (context: HostedEvaluationContext) => Promise<EvaluationOutcome> {
  const approved = new Map(Object.entries(plans).map(([taskRef, plan]) => {
    if (taskRef !== plan.taskRef) throw new TypeError("hosted evaluation task reference differs from its approved plan");
    return [reference(taskRef, "task reference"), Object.freeze({...plan})] as const;
  }));
  return async context => {
    const plan = approved.get(context.taskRef);
    if (plan === undefined) {
      // No source/model is evaluated for an unknown reference. The hosting tool
      // retains cleanup responsibility when this callback is rejected before handoff.
      throw new TypeError("no approved evaluation for this hosted task");
    }
    return evaluateHostedSubmission(context, plan, options);
  };
}

async function evaluate<C extends EvaluationSuiteContext>(
  input: EvaluationDefinition<C> | ImplementationEvaluationPlan<C>, options: EvaluationWorkflowOptions,
  hosted?: HostedEvaluationContext,
  dependencies: WorkflowDependencies = defaultDependencies,
): Promise<EvaluationOutcome> {
  const runId = randomUUID();
  let stage: EvaluationStage = "configuration";
  let taskRef = "invalid";
  let suiteIdentity: TrustedEvaluationReceipt["suite"] = Object.freeze({id: "invalid", revision: "invalid", modelRevision: "invalid"});
  let disclosure: WorkflowDisclosurePolicy = Object.freeze({});
  let modelInterface: TrustedEvaluationReceipt["modelInterface"];
  let hosting: Readonly<HostedRun> | undefined = hosted?.run;
  let hostedHandle: HostedAgentRun | undefined;
  let prepared: Prepared | undefined;
  let client = hosted?.client;
  let session = hosted?.session;
  let sessionOpenUnconfirmed = false;
  let provider: PreparedImplementationProvider | undefined;
  let providerFailureCleanup: ProviderCleanupReceipt | undefined;
  let deadlines = normalizeReplayDeadlines(undefined);
  let primary: TrustedEvaluationReceipt["primaryFailure"];
  let modelStatus: TrustedEvaluationReceipt["model"]["status"] = "notRun";
  let report: CompiledReplayReport | undefined;
  let suitePending: Promise<CompiledReplayReport> | undefined;
  let suiteSettled = true;
  const workflowAbort = new AbortController();
  try {
    taskRef = reference(input.taskRef, "task reference");
    const suite = Object.freeze({...input.suite});
    suiteIdentity = Object.freeze({id: reference(suite.id, "suite ID"), revision: reference(suite.revision, "suite revision"),
      modelRevision: reference(suite.modelRevision, "model revision")});
    if (typeof suite.run !== "function" || suite.context === null || typeof suite.context !== "object") throw new TypeError("approved suite and context are required");
    const policyId = reference(input.policyId, "policy ID");
    const runtime = input.runtime;
    if (runtime !== "node-v1" && runtime !== "rust-v1") throw new TypeError("unsupported evaluation runtime");
    const preparedModel = prepareSandboxModel(input.model);
    const model = preparedModel.model;
    modelInterface = Object.freeze({semanticDigest: preparedModel.semanticDigest, adapterId: model.adapterId,
      targetProfile: model.targetProfile, stateComputerContractVersion: model.stateComputerContractVersion});
    const policy = {...input.disclosure};
    if (Object.entries(policy).some(([key, value]) => !["counts", "implementationIdentity", "failureStage"].includes(key) || typeof value !== "boolean")) throw new TypeError("invalid workflow disclosure policy");
    disclosure = Object.freeze(policy);
    deadlines = normalizeReplayDeadlines({...suite.context.deadlines, ...options.deadlines});
    const hostingTimeoutMs = duration(options.hostingTimeoutMs, 300_000, "hosting timeout");
    const evaluationTimeoutMs = duration(options.evaluationTimeoutMs, 300_000, "evaluation timeout");
    const signals = [workflowAbort.signal, options.signal, hosted?.signal, suite.context.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    if (signals.some(signal => !(signal instanceof AbortSignal))) throw new TypeError("invalid workflow signal");
    const signal = AbortSignal.any(signals);
    const checkActive = () => { if (signal.aborted) throw new ReplayCancelledError(signal.reason); };
    checkActive();
    if (hosted !== undefined) {
      if (hosted.session.client !== hosted.client || hosted.taskRef !== taskRef) throw new TypeError("hosted evaluation must retain its original task and owner");
      stage = "authoring";
      const observed = await hosted.session.agentStatus({signal, timeoutMs: deadlines.registrationMs});
      if (observed === null || observed.runId !== hosted.run.runId ||
          JSON.stringify(observed.submission) !== JSON.stringify(hosted.run.submission)) {
        throw new Error("hosted evaluation submission does not belong to its original session");
      }
      hosting = observed;
      submissionIdentity(observed);
    } else {
      const plan = input as ImplementationEvaluationPlan<C>;
      // JSON-only Gate inputs are snapshotted before any await; private suite
      // context and the model transport never enter this public input snapshot.
      const gate = JSON.parse(JSON.stringify(plan.gate)) as SandboxGateEndpoint;
      const submission = JSON.parse(JSON.stringify(plan.submission)) as SandboxSubmission;
      const limits = plan.limits === undefined ? undefined : {...plan.limits};
      const agent = plan.agent === undefined ? undefined : JSON.parse(JSON.stringify(plan.agent)) as StartAgentOptions;
      if (agent !== undefined && (submission.kind !== "source" || !submission.authoring)) throw new TypeError("managed authoring requires an authoring source submission");
      if (agent === undefined && submission.kind === "source" && submission.authoring) throw new TypeError("source authoring requires an approved managed agent");
      stage = "connect";
      checkActive();
      client = await dependencies.connect(gate, [
        gate.kind === "owned" ? "control.local-stdio-v1" : "control.local-unix-v1",
        submission.kind === "prebuilt" ? "submission.prebuilt-v1" : "submission.source-build-v1",
        ...(agent === undefined ? [] : ["authoring.tools-v1", "hosting.fresh-agent-v1"]),
        "execution.compiled-verify-v1", "worker.managed-unix-v1", `worker.${runtime}`,
        "backend.linux-bubblewrap-v1", "cleanup.bounded-attempt-v1",
      ], agent === undefined ? 1 : 2);
      checkActive();
      stage = "open";
      sessionOpenUnconfirmed = true;
      try {
        session = await client.openSession({policyId, submission, runtime, manifestJson: preparedModel.manifestJson,
          ...(limits === undefined ? {} : {limits}), modelRevisionId: suite.modelRevision},
        {signal, timeoutMs: deadlines.registrationMs});
        sessionOpenUnconfirmed = false;
      } catch (error) {
        if (await isDefinitiveSessionOpenFailure(error)) sessionOpenUnconfirmed = false;
        throw error;
      }
      if (agent !== undefined) {
        stage = "authoring";
        const run = await session.startAgent(agent, {signal, timeoutMs: deadlines.registrationMs});
        hostedHandle = run;
        try { hosting = await run.wait({signal, timeoutMs: hostingTimeoutMs}); }
        catch (error) { hosting = run.latest ?? undefined; throw error; }
        submissionIdentity(hosting);
      }
    }
    stage = "prepare";
    checkActive();
    prepared = await waitSucceeded(await session!.prepare({signal, timeoutMs: deadlines.registrationMs}), signal, deadlines.registrationMs);
    if (hosting?.submission !== undefined && prepared.sourceHash !== hosting.submission.sourceHash) throw new Error("prepared source does not match committed hosted submission");
    stage = "provider";
    try {
      provider = await createPreparedImplementationProvider({session: session!, prepared, model, policyId, runtime, deadlines, onDiagnostic: options.onDiagnostic});
    } catch (error) {
      if (error instanceof PreparedImplementationError) providerFailureCleanup = error.cleanup;
      throw error;
    }
    stage = "evaluate";
    checkActive();
    modelStatus = "failed";
    suiteSettled = false;
    const context = Object.freeze({...suite.context, signal, deadlines}) as C;
    suitePending = Promise.resolve().then(() => suite.run(context, provider!.factory));
    suitePending.then(() => { suiteSettled = true; }, () => { suiteSettled = true; });
    const completed = await awaitAuthoringOperation(suitePending, signal, evaluationTimeoutMs, "receive");
    if (completed?.status !== "completed" || !Number.isSafeInteger(completed.acceptedTraces) || completed.acceptedTraces < 0 ||
        !Number.isSafeInteger(completed.acceptedSteps) || completed.acceptedSteps < 0) {
      throw new TypeError("suite did not return a completed compiled replay report");
    }
    // Snapshot the public count fields before accepting a custom suite report;
    // arbitrary getters cannot run later during public result projection.
    report = Object.freeze({status: "completed", acceptedTraces: completed.acceptedTraces,
      acceptedSteps: completed.acceptedSteps, actionCoverage: completed.actionCoverage, diagnostics: completed.diagnostics});
    modelStatus = "passed";
  } catch (error) {
    const status = summaryStatus(error);
    if (stage === "evaluate") modelStatus = status;
    let family: NonNullable<TrustedEvaluationReceipt["primaryFailure"]>["family"] = stage === "configuration" ? "configuration" : stage === "authoring" ? "hosting" : "application";
    try { if (family === "application") family = errorFamily(error); } catch { /* Preserve arbitrary rejection. */ }
    primary = Object.freeze({stage, family, error});
  }
  const status = primary === undefined ? "passed" : summaryStatus(primary.error);
  if (primary !== undefined) workflowAbort.abort(primary.error);
  const summary: OutcomeSummary = {status, ...(primary === undefined ? {} : {failureFamily: primary.family})};
  let cleanup = provider === undefined
    ? providerFailureCleanup ?? await closeOwner(client, session, summary, deadlines.receiveMs, sessionOpenUnconfirmed)
    : await provider.close(summary);
  if (!suiteSettled && suitePending !== undefined) {
    try { await awaitAuthoringOperation(suitePending.catch(() => undefined), undefined, deadlines.receiveMs, "close"); }
    catch (error) { cleanup = cleanupReceipt(cleanup.status === "failed" ? "failed" : "unconfirmed", [...cleanup.failures, error], cleanup.remainingResources); }
  }
  hosting = hostedHandle?.latest ?? hosting;
  if (hosting !== undefined && hosting.cleanup.status !== "succeeded") {
    cleanup = cleanupReceipt(cleanup.status === "failed" || hosting.cleanup.status === "failed" ? "failed" : "unconfirmed",
      cleanup.failures, [...new Set([...cleanup.remainingResources, ...hosting.cleanup.remainingResources])]);
  }
  if (hosted?.completeCleanup !== undefined) {
    try { hosted.completeCleanup({status: cleanup.status === "confirmed" ? "succeeded" : "failed"}); }
    catch (error) { cleanup = cleanupReceipt("failed", [...cleanup.failures, error], cleanup.remainingResources); }
  }
  const implementation = provider?.identity ?? (prepared === undefined ? undefined : Object.freeze({
    preparedRevision: prepared.preparedRevision, artifactId: prepared.artifactId, artifactHash: prepared.artifactHash,
    manifestHash: prepared.manifestHash, runtime: prepared.runtime, policyId: prepared.policyId,
    ...(prepared.sourceHash === undefined ? {} : {sourceHash: prepared.sourceHash}),
  }));
  const receipt: TrustedEvaluationReceipt = Object.freeze({
    schema: EVALUATION_RECEIPT_SCHEMA, runId, taskRef,
    status: status === "passed" && cleanup.status !== "confirmed" ? "failed" : status,
    suite: suiteIdentity, ...(modelInterface === undefined ? {} : {modelInterface}),
    ...(hosting === undefined ? {} : {hosting: Object.freeze({runId: hosting.runId,
      ...(hosting.outcome === undefined ? {} : {outcome: hosting.outcome}),
      ...(hosting.submission === undefined ? {} : {submission: Object.freeze({...hosting.submission})})})}),
    ...(implementation === undefined ? {} : {implementation}),
    model: Object.freeze({status: modelStatus, ...(report === undefined ? {} : {report})}),
    ...(primary === undefined ? {} : {primaryFailure: primary}), cleanup,
  });
  return Object.freeze({receipt, publicResult: projectEvaluationReceipt(receipt, disclosure)});
}
