import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  MutationCampaign,
  MutationCase,
  ReproductionCapture,
  SuiteDefinition,
  SuiteFailure,
  SuiteResult,
} from "mirrorecma";
import {
  evaluateGateCampaignWithEvaluator,
  type EvaluateGateCampaignOptions,
} from "../src/campaign.js";
import type { SuiteEvaluationOutcome } from "../src/suite.js";

const campaign = JSON.parse(
  await readFile(
    resolve(
      "../../../MirrorECMA/test/fixtures/mutation-campaign/accepted/current-17-local-17-gate.json",
    ),
    "utf8",
  ),
) as MutationCampaign;
const policy = {
  maxMutants: 256,
  totalBudgetMs: 10_000,
  perRunBudgetMs: 500,
  cleanupBudgetMs: 100,
};
const suite = {} as SuiteDefinition<unknown>;
function suiteResult(
  id: string,
  cleanup: "succeeded" | "failed" | "unconfirmed" = "succeeded",
): SuiteResult {
  const mutant = campaign.mutants.find((item) => item.id === id);
  const failure: SuiteFailure | undefined = mutant
    ? {
        stage: "replay",
        kind: "mismatch",
        code: "model_mismatch",
        message: "mismatch",
        traceIndex: mutant.expected.traceIndex,
        stateIndex: mutant.expected.stateIndex,
      }
    : undefined;
  const result: SuiteResult = {
    schema: "mirrorecma.suite-result/v1",
    suiteId: "gate-campaign",
    outcome: mutant ? "mismatch" : "passed",
    conformance: mutant ? "mismatch" : "matched",
    acceptance: {
      status: mutant ? "incomplete" : "met",
      missingActions: [],
      missingPairs: [],
    },
    cleanup: {
      scope: "local",
      status: cleanup,
      quiescence: cleanup === "succeeded" ? "confirmed" : "unconfirmed",
      bindingStatus: cleanup,
    },
    identities: { interfaceDigest: "a".repeat(64) },
    evidence: {
      schema: "mirrorecma.suite-evidence/v1",
      enteredReplay: true,
      complete: !mutant,
      exact: true,
      tracesExpected: 1,
      tracesCompleted: mutant ? 0 : 1,
      initializationsMatched: "1",
      transitionsMatched: mutant ? "0" : "1",
      actionCounts: {},
      pairCounts: {},
    },
    ...(failure ? { failure } : {}),
  };
  if (mutant)
    Object.defineProperty(result, "trustedError", {
      value: { action: mutant.expected.action },
      enumerable: false,
    });
  return result;
}
function outcome(
  id: string,
  physical: "confirmed" | "failed" | "unconfirmed" = "confirmed",
): SuiteEvaluationOutcome {
  return {
    schema: "mirrorgate.suite-evaluation/v1",
    outcome: id === "correct" ? "passed" : "mismatch",
    suiteResult: suiteResult(id),
    receipt: {
      runId: `run-${id}`,
      cleanup: {
        status: physical,
        remainingResources: physical === "confirmed" ? [] : ["worker"],
        failures: [],
      },
    },
    persistence: { status: "not_requested" },
    publicResult: {},
  } as unknown as SuiteEvaluationOutcome;
}
function options(
  overrides: Partial<EvaluateGateCampaignOptions<unknown>> = {},
): EvaluateGateCampaignOptions<unknown> {
  return {
    campaign,
    observedProtected: campaign.protected,
    policy,
    suite,
    caseOptions: async (scenario) =>
      ({
        mirror: "unused",
        environment: {
          taskRef: scenario.id,
          policyId: "fixture",
          runtime: "node-v1",
        },
      }) as any,
    probe: async () => ({ status: "passed" }),
    ...overrides,
  };
}
const evaluator = async (_suite: SuiteDefinition<unknown>, configured: any) =>
  outcome(configured.environment.taskRef);

test("Gate campaign confirms all 17 required kills only with explicit probe and physical cleanup", async () => {
  const captures: string[] = [];
  const result = await evaluateGateCampaignWithEvaluator(
    options({
      captureKilled: async (scenario) => {
        captures.push(scenario.id);
        return {
          schema: "mirrorecma.reproduction-capture/v1",
        } as ReproductionCapture;
      },
    }),
    evaluator,
  );
  expect(result.campaign).toMatchObject({
    status: "complete",
    acceptance: { status: "met" },
    requiredOnPath: 17,
  });
  expect(
    result.campaign.mutants.filter(
      (item) => item.classification === "killed_by_behavioral_mismatch",
    ),
  ).toHaveLength(17);
  expect(
    result.campaign.mutants.filter(
      (item) => item.disposition === "unsupported",
    ),
  ).toHaveLength(0);
  expect(result).toMatchObject({ evidence: "complete" });
  expect(result.captures).toHaveLength(17);
  expect(captures).toHaveLength(17);
  expect(Object.keys(result)).not.toContain("evaluations");
});

test("missing trusted probe is explicit and prevents campaign acceptance", async () => {
  let calls = 0;
  const result = await evaluateGateCampaignWithEvaluator(
    options({ probe: undefined }),
    async (selected, configured) => {
      calls++;
      return evaluator(selected, configured);
    },
  );
  expect(result.campaign).toMatchObject({
    status: "baseline_failed",
    acceptance: { status: "incomplete" },
    baseline: { probe: { status: "not_run", code: "gate_probe_unavailable" } },
  });
  expect(calls).toBe(1);
});

test("physical cleanup cannot be inferred from local SuiteResult cleanup", async () => {
  const result = await evaluateGateCampaignWithEvaluator(
    options(),
    async (_selected, configured: any) =>
      outcome(configured.environment.taskRef, "unconfirmed"),
  );
  expect(result.campaign).toMatchObject({
    status: "baseline_failed",
    acceptance: { status: "incomplete" },
  });
  expect(result.campaign.baseline.cleanup).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        scope: "gate-physical",
        requirement: "required",
        status: "unconfirmed",
      }),
    ]),
  );
});

test("capture persistence failure stays separate from behavioral campaign result", async () => {
  let count = 0;
  const result = await evaluateGateCampaignWithEvaluator(
    options({
      captureKilled: async () => {
        if (++count === 1) throw new Error("denied");
        return {
          schema: "mirrorecma.reproduction-capture/v1",
        } as ReproductionCapture;
      },
    }),
    evaluator,
  );
  expect(result.campaign.acceptance.status).toBe("met");
  expect(result.evidence).toBe("incomplete");
  expect(result.captures[0]).toMatchObject({
    status: "failed",
    code: "capture_failed",
  });
});

test("probe timeout remains inconclusive and does not count as a kill", async () => {
  const result = await evaluateGateCampaignWithEvaluator(
    options({
      probeBudgetMs: 10,
      probe: async (_scenario, _outcome, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    }),
    evaluator,
  );
  expect(result.campaign).toMatchObject({
    status: "baseline_failed",
    acceptance: { status: "incomplete" },
    baseline: { probe: { status: "timed_out" } },
  });
});
