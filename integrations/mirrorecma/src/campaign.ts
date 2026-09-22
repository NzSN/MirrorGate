import {
  runMutationCampaign,
  type MutationCampaign,
  type MutationCampaignPolicy,
  type MutationCampaignResult,
  type MutationCase,
  type MutationEvaluation,
  type MutationProbeResult,
  type MutationProtectedInputs,
  type ReproductionCapture,
  type SuiteDefinition,
} from "mirrorecma";
import {
  evaluateSuite,
  type EvaluateSuiteOptions,
  type SuiteEvaluationOutcome,
} from "./suite.js";

export const GATE_CAMPAIGN_SCHEMA =
  "mirrorgate.mutation-campaign-evaluation/v1" as const;

export interface GateCampaignCapture {
  readonly mutantId: string;
  readonly status: "captured" | "failed" | "not_requested";
  readonly capture?: ReproductionCapture;
  readonly code?: string;
}
export interface GateCampaignOutcome {
  readonly schema: typeof GATE_CAMPAIGN_SCHEMA;
  readonly campaign: MutationCampaignResult;
  readonly evidence: "complete" | "incomplete" | "not_requested";
  readonly captures: readonly GateCampaignCapture[];
  readonly evaluations?: ReadonlyMap<string, SuiteEvaluationOutcome>;
}
export interface EvaluateGateCampaignOptions<Port> {
  readonly campaign: MutationCampaign;
  readonly observedProtected: MutationProtectedInputs;
  readonly observeProtected?: (
    signal: AbortSignal,
  ) => MutationProtectedInputs | Promise<MutationProtectedInputs>;
  readonly policy: MutationCampaignPolicy;
  readonly suite: SuiteDefinition<Port>;
  readonly signal?: AbortSignal;
  readonly caseOptions: (
    scenario: MutationCase,
    signal: AbortSignal,
  ) => EvaluateSuiteOptions | Promise<EvaluateSuiteOptions>;
  /** Trusted evaluator probe. Absence is recorded as not_run, never inferred. */
  readonly probe?: (
    scenario: MutationCase,
    outcome: SuiteEvaluationOutcome,
    signal: AbortSignal,
  ) => MutationProbeResult | Promise<MutationProbeResult>;
  readonly probeBudgetMs?: number;
  readonly captureKilled?: (
    scenario: MutationCase,
    outcome: SuiteEvaluationOutcome,
  ) => ReproductionCapture | Promise<ReproductionCapture>;
}
type SuiteEvaluator<Port> = (
  suite: SuiteDefinition<Port>,
  options: EvaluateSuiteOptions,
) => Promise<SuiteEvaluationOutcome>;

async function boundedProbe(
  operation: (signal: AbortSignal) => Promise<MutationProbeResult>,
  parent: AbortSignal,
  budgetMs: number,
): Promise<MutationProbeResult> {
  if (parent.aborted) return { status: "error", code: "probe_cancelled" };
  const controller = new AbortController();
  const forward = () => controller.abort(parent.reason);
  parent.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.resolve().then(() => operation(controller.signal));
  void pending.catch(() => {});
  try {
    return await Promise.race([
      pending,
      new Promise<MutationProbeResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort("probe timeout");
          resolve({ status: "timed_out", code: "probe_timeout" });
        }, budgetMs);
      }),
    ]);
  } catch {
    return { status: "error", code: "probe_failed" };
  } finally {
    if (timer) clearTimeout(timer);
    parent.removeEventListener("abort", forward);
  }
}
function cleanupEvaluation(
  outcome: SuiteEvaluationOutcome,
): MutationEvaluation["cleanup"] {
  const localStatus = outcome.suiteResult?.cleanup.status;
  const physical = outcome.receipt.cleanup;
  const physicalConfirmed =
    physical.status === "confirmed" && physical.remainingResources.length === 0;
  return Object.freeze([
    Object.freeze({
      scope: "local-cooperative" as const,
      requirement: "required" as const,
      status:
        localStatus === "succeeded"
          ? ("confirmed" as const)
          : localStatus === "failed"
            ? ("failed" as const)
            : ("unconfirmed" as const),
      ...(localStatus === "succeeded"
        ? {}
        : { code: `local_cleanup_${localStatus ?? "unavailable"}` }),
    }),
    Object.freeze({
      scope: "gate-physical" as const,
      requirement: "required" as const,
      status: physicalConfirmed
        ? ("confirmed" as const)
        : physical.status === "failed"
          ? ("failed" as const)
          : ("unconfirmed" as const),
      ...(physicalConfirmed ? {} : { code: `gate_cleanup_${physical.status}` }),
    }),
  ]);
}

/**
 * Runs one MirrorECMA campaign through the existing evaluateSuite lifecycle.
 * Physical cleanup comes only from Gate's trusted receipt. Probe success comes
 * only from the explicit trusted callback.
 */
export function evaluateGateCampaign<Port>(
  options: EvaluateGateCampaignOptions<Port>,
): Promise<GateCampaignOutcome> {
  return evaluateGateCampaignWithEvaluator(options, evaluateSuite);
}

/** Test seam; omitted from the package barrel. */
export async function evaluateGateCampaignWithEvaluator<Port>(
  options: EvaluateGateCampaignOptions<Port>,
  evaluator: SuiteEvaluator<Port>,
): Promise<GateCampaignOutcome> {
  const evaluations = new Map<string, SuiteEvaluationOutcome>();
  const scenarios = new Map<string, MutationCase>();
  const probeBudgetMs = options.probeBudgetMs ?? 1_000;
  if (
    !Number.isSafeInteger(probeBudgetMs) ||
    probeBudgetMs < 1 ||
    probeBudgetMs > 0x7fffffff
  )
    throw new TypeError("probe budget must be a positive bounded integer");
  const campaign = await runMutationCampaign(options.campaign, {
    path: "gate",
    observedProtected: options.observedProtected,
    observeProtected: options.observeProtected,
    policy: options.policy,
    signal: options.signal,
    evaluate: async (scenario, signal) => {
      scenarios.set(scenario.id, scenario);
      const configured = await options.caseOptions(scenario, signal);
      const outcome = await evaluator(options.suite, {
        ...configured,
        signal,
      });
      evaluations.set(scenario.id, outcome);
      if (outcome.suiteResult === undefined)
        throw new Error("Gate evaluation did not produce a SuiteResult");
      const probe = options.probe
        ? await boundedProbe(
            (probeSignal) =>
              Promise.resolve(options.probe!(scenario, outcome, probeSignal)),
            signal,
            probeBudgetMs,
          )
        : ({ status: "not_run", code: "gate_probe_unavailable" } as const);
      return {
        suiteResult: outcome.suiteResult,
        cleanup: cleanupEvaluation(outcome),
        probe,
        evidenceRef: Object.freeze({
          gateRunId: outcome.receipt.runId,
          persistence: outcome.persistence.status,
        }),
      };
    },
  });
  const captures: GateCampaignCapture[] = [];
  for (const result of campaign.mutants) {
    if (result.classification !== "killed_by_behavioral_mismatch") continue;
    if (!options.captureKilled) {
      captures.push(
        Object.freeze({ mutantId: result.id, status: "not_requested" }),
      );
      continue;
    }
    const scenario = scenarios.get(result.id);
    const outcome = evaluations.get(result.id);
    if (!scenario || !outcome) {
      captures.push(
        Object.freeze({
          mutantId: result.id,
          status: "failed",
          code: "capture_source_unavailable",
        }),
      );
      continue;
    }
    try {
      const capture = await options.captureKilled(scenario, outcome);
      captures.push(
        Object.freeze({ mutantId: result.id, status: "captured", capture }),
      );
    } catch {
      captures.push(
        Object.freeze({
          mutantId: result.id,
          status: "failed",
          code: "capture_failed",
        }),
      );
    }
  }
  const evidence = !options.captureKilled
    ? "not_requested"
    : captures.every((capture) => capture.status === "captured")
      ? "complete"
      : "incomplete";
  const result: GateCampaignOutcome = {
    schema: GATE_CAMPAIGN_SCHEMA,
    campaign,
    evidence,
    captures: Object.freeze(captures),
  };
  Object.defineProperty(result, "evaluations", {
    value: evaluations,
    enumerable: false,
  });
  return Object.freeze(result);
}
