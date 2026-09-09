import { projectEvaluationReceipt, EVALUATION_RECEIPT_SCHEMA } from "../src/receipt.js";
import type { TrustedEvaluationReceipt } from "../src/receipt.js";

const receipt: TrustedEvaluationReceipt = {
  schema: EVALUATION_RECEIPT_SCHEMA, runId: "fresh-workflow-reference", taskRef: "private-task-label", status: "mismatch",
  suite: {id: "private-suite", revision: "private-revision", modelRevision: "private-model"},
  modelInterface: {semanticDigest: "a".repeat(64), adapterId: "private-adapter", targetProfile: "private-target", stateComputerContractVersion: "private-contract"},
  hosting: {runId: "private-control-handle", submission: {submissionId: "private-source-handle", sourceHash: "b".repeat(64), sourceRevision: 1}},
  implementation: {preparedRevision: 1, artifactId: "private-artifact", artifactHash: "a".repeat(64), sourceHash: "b".repeat(64),
    manifestHash: "c".repeat(64), runtime: "node-v1", policyId: "private-policy"},
  model: {status: "mismatch", report: {status: "completed", acceptedTraces: 2, acceptedSteps: 8,
    actionCoverage: {privateAction: 8}, diagnostics: []}},
  primaryFailure: {stage: "evaluate", family: "application", error: {expected: "private expected state", credentials: "private credential"}},
  cleanup: {status: "confirmed", remainingResources: [], failures: [new Error("private cleanup diagnostic")]},
};
test("default projection excludes every diagnostic and administrative identity", () => {
  const result = projectEvaluationReceipt(receipt);
  expect(result).toEqual({schema: "mirrorgate.evaluation/v1", runRef: receipt.runId, status: "mismatch", cleanup: "confirmed"});
  expect(JSON.stringify(result)).not.toContain("private"); expect(Object.isFrozen(result)).toBe(true);
});
test("explicit disclosure remains a bounded allowlist", () => {
  const result = projectEvaluationReceipt(receipt, {counts: true, implementationIdentity: true, failureStage: true});
  expect(result.counts).toEqual({acceptedTraces: 2, acceptedSteps: 8});
  expect(result.implementation).toEqual({artifactHash: "a".repeat(64), sourceHash: "b".repeat(64)});
  expect(result.failureStage).toBe("evaluate");
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024);
  expect(JSON.stringify(result)).not.toContain("private");
});
test("projection does not render arbitrary rejection values", () => {
  const hostile = new Proxy({}, {get() {throw new Error("must not inspect private rejection");}});
  const result = projectEvaluationReceipt({...receipt, primaryFailure: {...receipt.primaryFailure!, error: hostile}}, {failureStage: true});
  expect(result.failureStage).toBe("evaluate");
});
