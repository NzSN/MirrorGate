import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  decodeSemanticDescriptor,
  semanticDescriptorDigest,
  type GeneratedModelInterface,
  type SemanticDescriptor,
} from "mirrorecma";
import type { Transport } from "mirrorecma";
import {
  createSandboxCompiledModel,
  createSandboxPublicManifest,
  SANDBOX_ASYNC_COMPUTER_CONTRACT,
  SANDBOX_ASYNC_TARGET_PROFILE,
  type SandboxCompiledModel,
} from "../src/sandbox-model.js";
import {
  evaluateSandboxedWithDependencies,
  sandboxDiagnosticFailures,
  type SandboxEvaluationPlan,
} from "../src/sandbox.js";
import {
  CounterAsyncStateComputerContractVersion,
  CounterAsyncTargetProfile,
  CounterModelInterface,
  CounterPublicManifest,
  bindCounterAsyncPublicPort,
} from "./fixtures/model-interface/counter/generated-async/CounterMirror.generated.js";

function descriptor(): SemanticDescriptor {
  const lock = JSON.parse(readFileSync(
    new URL("./fixtures/model-interface/counter/Counter.mirror-interface.lock.json", import.meta.url),
    "utf8",
  )) as Record<string, unknown>;
  const {
    contract: _contract,
    semanticDigest: _semanticDigest,
    provenance: _provenance,
    provenanceDigest: _provenanceDigest,
    ...resolved
  } = lock;
  return decodeSemanticDescriptor({ ...resolved, schema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA });
}

function compiledModel(): SandboxCompiledModel {
  const resolved = descriptor();
  return createSandboxCompiledModel({
    metadata: CounterModelInterface,
    descriptor: resolved,
    adapterId: "counter.generated-async-v1",
    targetProfile: CounterAsyncTargetProfile,
    stateComputerContractVersion: CounterAsyncStateComputerContractVersion,
    publicManifest: CounterPublicManifest,
    bindPublicPort: bindCounterAsyncPublicPort,
  });
}

class ScriptedTransport implements Transport {
  readonly sent: string[] = [];
  closes = 0;
  private index = 0;
  constructor(private readonly replies: readonly string[]) {}
  send(line: string): void { this.sent.push(line); }
  async close(): Promise<number> { this.closes += 1; return 0; }
  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => this.index < this.replies.length
        ? { value: this.replies[this.index++]!, done: false }
        : { value: "", done: true },
    };
  }
}

function matched(digest: string): string {
  return JSON.stringify({
    proto_step: "spec_validated",
    result: "valid",
    modelInterface: {
      schema: "mirrors.model-interface-negotiation/v1",
      status: "matched",
      descriptorSchema: "mirrors.model-interface-descriptor/v1",
      semanticDigest: `sha256:${digest}`,
    },
  });
}

function mismatched(digest: string): string {
  return JSON.stringify({
    proto_step: "register_error",
    error: "model interface digest mismatch",
    modelInterface: {
      schema: "mirrors.model-interface-negotiation/v1",
      status: "mismatch",
      code: "interface_digest_mismatch",
      expectedSemanticDigest: `sha256:${digest}`,
      actualSemanticDigest: `sha256:${"f".repeat(64)}`,
    },
  });
}

import { createPreparedImplementationProvider } from "../src/provider.js";
import { runClientWithTracesNegotiatedWithReport } from "mirrorecma";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(model = { ...compiledModel(), adapterId: "counter-mbt/v1" }) {
  const calls: string[] = [];
  const traffic: unknown[] = [];
  const manifestJson = JSON.stringify(model.publicManifest);
  const prepared = {
    preparedRevision: 1, artifactId: "artifact", artifactHash: "a".repeat(64),
    sourceHash: "b".repeat(64), manifestHash: createHash("sha256")
      .update("mirrorgate.public-manifest/v1").update(Buffer.from([0])).update(manifestJson).digest("hex"),
    runtime: "node-v1", policyId: "test", challenge: "c".repeat(32),
  };
  const cleanup = () => ({ wait: async () => ({ operationId: 1, status: "succeeded",
    result: { phase: "closed", cleanupStatus: "succeeded", remainingResources: [] } }) });
  const worker = {
    invoke: async (id: string, inputs: unknown, context: unknown) => { calls.push("invoke"); traffic.push({ id, inputs, context }); },
    observe: async () => ({ Count: 0n }),
    close: async () => { calls.push("worker.close"); },
  };
  const session = {
    runtime: "node-v1", manifestJson,
    client: { close: async () => { calls.push("client.close"); } },
    authorize: async (input: unknown) => { calls.push("authorize"); traffic.push(input); return {}; },
    acquireWorker: async () => { calls.push("acquire"); return {
      connect: async () => { calls.push("connect"); return worker; },
      release: async () => { calls.push("release"); return cleanup(); },
    }; },
    close: async () => { calls.push("session.close"); return cleanup(); },
    cancel: async () => { calls.push("session.cancel"); return cleanup(); },
  };
  const options = { session: session as never, prepared, model, policyId: "test", runtime: "node-v1" as const,
    deadlines: { receiveMs: 200, registrationMs: 200, stepMs: 200 } };
  return { calls, traffic, session, worker, options };
}
import { evaluateImplementationWithDependencies, evaluateHostedSubmission, createHostedEvaluationHandler } from "../src/workflow.js";
import { runCounterSuite } from "./fixtures/counter-suite.js";
import type { ImplementationEvaluationPlan } from "../src/workflow.js";
import type { CounterSuiteContext } from "./fixtures/counter-suite.js";

function setup(kind: "prebuilt" | "source" | "hosted" = "prebuilt") {
  const f = fixture();
  const hosting = {
    runId: "private-control-run-id", phase: "finished", outcome: "submitted",
    cleanup: {status: "succeeded", remainingResources: []},
    limits: {wallMs: 10_000, stdoutBytes: 1024, stderrBytes: 1024, progressRecords: 4, progressBytes: 1024, progressRecordBytes: 128},
    progress: {firstSeq: 1, nextSeq: 2, truncated: false, records: [{seq: 1, message: "private host output"}]},
    submission: {submissionId: "private-submission-id", sourceHash: f.options.prepared.sourceHash, sourceRevision: 1},
  };
  const session = Object.assign(f.session, {
    agentStatus: async () => hosting,
    prepare: async () => { f.calls.push("prepare"); return {wait: async () => ({operationId: 1, status: "succeeded", result: f.options.prepared})}; },
    startAgent: async (request: unknown) => {
      f.calls.push("agent.start"); f.traffic.push(request);
      return {latest: hosting, wait: async () => {f.calls.push("agent.wait"); return hosting;}};
    },
  });
  const client = Object.assign(session.client, { openSession: async (request: unknown) => {
    f.calls.push("open"); f.traffic.push(request); return session;
  } });
  const target = new ScriptedTransport([
    matched(f.options.model.metadata.semanticDigest),
    JSON.stringify({proto_step: "initial_state", action: "init", state: {privateCanary: "secret"}}),
    JSON.stringify({proto_step: "all_steps_done"}),
  ]);
  const plan: ImplementationEvaluationPlan<CounterSuiteContext> = {
    taskRef: "counter", policyId: "test", runtime: "node-v1", model: f.options.model,
    gate: {kind: "owned", launcher: {command: "/approved/gate"}, policyFile: "/private/operator.json"},
    submission: kind === "prebuilt" ? {kind: "prebuilt", input: {rootId: "submission", relativePath: "counter"}}
      : {kind: "source", input: {rootId: "submission", relativePath: "counter"}, buildPlanId: "copy", authoring: kind === "hosted"},
    ...(kind !== "hosted" ? {} : {agent: {profileId: "approved-agent", publicTask: {instructions: "Implement public Counter", files: []}}}),
    suite: {id: "counter-suite", revision: "suite.sha256", modelRevision: "model.sha256",
      context: {mirror: target, modelConfig: {specPath: "/private/Counter.tla", invariant: "PrivateInvariant", lengthBound: 1, paramVars: "parameters"}, tracePaths: ["/private/trace.itf.json"]},
      run: runCounterSuite},
  };
  const dependencies = {connect: async (_gate: unknown, _capabilities: unknown, version: number) => {
    f.calls.push(`connect.v${version}`); return client as never;
  }};
  const options = {deadlines: {receiveMs: 100, registrationMs: 100, stepMs: 100}, evaluationTimeoutMs: 1000};
  return {...f, session, client, hosting, plan, dependencies, options};
}

test.each(["prebuilt", "source", "hosted"] as const)("supported %s path uses one retained owner and the unchanged generic suite", async kind => {
  const f = setup(kind);
  const outcome = await evaluateImplementationWithDependencies(f.plan, f.options, f.dependencies);
  expect(outcome.receipt.status).toBe("passed"); expect(outcome.receipt.model.status).toBe("passed");
  expect(outcome.receipt.cleanup.status).toBe("confirmed");
  expect(f.calls.filter(call => call === "client.close")).toHaveLength(1);
  expect(f.calls[0]).toBe(kind === "hosted" ? "connect.v2" : "connect.v1");
  expect(f.calls.indexOf("prepare")).toBeLessThan(f.calls.indexOf("authorize"));
  expect(f.calls.includes("agent.start")).toBe(kind === "hosted");
  if (kind === "hosted") expect(outcome.receipt.hosting?.submission?.sourceHash).toBe(outcome.receipt.implementation?.sourceHash);
  expect(Object.keys(outcome.publicResult).sort()).toEqual(["cleanup", "runRef", "schema", "status"]);
  const publicJson = JSON.stringify(outcome.publicResult);
  for (const secret of ["private", "Counter.tla", "PrivateInvariant", "sourceHash", "model.sha256", "expected", "transport"])
    expect(publicJson).not.toContain(secret);
  const workerFrames = JSON.stringify(f.traffic.slice(f.traffic.findIndex(value => (value as any).attestation !== undefined)),
    (_key, value) => typeof value === "bigint" ? value.toString() : value);
  expect(workerFrames).not.toContain("PrivateInvariant");
});

test("pre-factory negotiation failure retains primary outcome and cleans preparation", async () => {
  const f = setup();
  f.plan.suite.context.mirror = new ScriptedTransport([mismatched(f.plan.model.metadata.semanticDigest)]);
  const outcome = await evaluateImplementationWithDependencies(f.plan, f.options, f.dependencies);
  expect(outcome.receipt.status).toBe("failed"); expect(outcome.receipt.primaryFailure?.family).toBe("modelNegotiation");
  expect(outcome.receipt.cleanup.status).toBe("confirmed"); expect(f.calls).not.toContain("authorize");
  expect(f.calls).toContain("session.close"); expect(f.calls).toContain("client.close");
});

test("source commit survives build failure evidence and never runs the suite", async () => {
  const f = setup("hosted"); const primary = new Error("private build path failed");
  f.session.prepare = async () => {throw primary;};
  const outcome = await evaluateImplementationWithDependencies(f.plan, f.options, f.dependencies);
  expect(outcome.receipt.hosting?.submission).toEqual(f.hosting.submission);
  expect(outcome.receipt.primaryFailure?.error).toBe(primary);
  expect(outcome.receipt.model.status).toBe("notRun"); expect(f.calls).not.toContain("authorize");
  expect(outcome.receipt.cleanup.status).toBe("confirmed");
});

test("prepared source identity mismatch is refused before worker admission", async () => {
  const f = setup("hosted"); f.hosting.submission.sourceHash = "e".repeat(64);
  const outcome = await evaluateImplementationWithDependencies(f.plan, f.options, f.dependencies);
  expect(outcome.receipt.primaryFailure?.stage).toBe("prepare");
  expect(f.calls).not.toContain("authorize"); expect(outcome.receipt.cleanup.status).toBe("confirmed");
});

test("model pass remains visible when final physical cleanup fails", async () => {
  const f = setup(); f.session.close = async () => {throw new Error("private cleanup failure");};
  const outcome = await evaluateImplementationWithDependencies(f.plan, f.options, f.dependencies);
  expect(outcome.receipt.status).toBe("failed"); expect(outcome.receipt.model.status).toBe("passed");
  expect(outcome.receipt.primaryFailure).toBeUndefined(); expect(outcome.receipt.cleanup.status).toBe("unconfirmed");
  expect(outcome.publicResult.status).toBe("failed");
});

test.each([undefined, null, new Error("private suite error")])("arbitrary primary rejection %p is not replaced by cleanup failure", async error => {
  const f = setup(); f.plan.suite.run = async () => {throw error;};
  f.session.close = async () => {throw new Error("cleanup failed");};
  const outcome = await evaluateImplementationWithDependencies(f.plan, f.options, f.dependencies);
  expect(outcome.receipt.status).toBe("failed"); expect(outcome.receipt.primaryFailure?.error).toBe(error);
  expect(outcome.receipt.cleanup.failures).toHaveLength(1);
});

test("cancelled delayed factory cannot acquire and its cleanup is joined", async () => {
  const f = setup(); const started = deferred<void>(); const pending = deferred<{}>(); const controller = new AbortController();
  f.session.authorize = async () => {f.calls.push("authorize"); started.resolve(); return pending.promise;};
  const run = evaluateImplementationWithDependencies(f.plan, {...f.options, signal: controller.signal}, f.dependencies);
  await started.promise; controller.abort("private cancellation reason"); pending.resolve({});
  const outcome = await run; expect(outcome.receipt.status).toBe("cancelled");
  expect(outcome.receipt.cleanup.status).toBe("confirmed"); expect(f.calls).not.toContain("acquire");
  expect(JSON.stringify(outcome.publicResult)).not.toContain("private");
});

test("independent simultaneous runs close only their dedicated owners", async () => {
  const first = setup(); const second = setup("source");
  const outcomes = await Promise.all([evaluateImplementationWithDependencies(first.plan, first.options, first.dependencies),
    evaluateImplementationWithDependencies(second.plan, second.options, second.dependencies)]);
  expect(outcomes.every(outcome => outcome.receipt.status === "passed")).toBe(true);
  expect(outcomes[0].receipt.runId).not.toBe(outcomes[1].receipt.runId);
  expect(first.calls.filter(call => call === "client.close")).toHaveLength(1);
  expect(second.calls.filter(call => call === "client.close")).toHaveLength(1);
});

test("hosting-tool embedding uses original owner and explicitly hands back cleanup", async () => {
  const f = setup("hosted"); const receipts: unknown[] = [];
  const outcome = await evaluateHostedSubmission({client: f.client as never, session: f.session as never,
    run: f.hosting as never, taskRef: "counter", signal: new AbortController().signal,
    completeCleanup: receipt => {receipts.push(receipt);}}, f.plan, f.options);
  expect(outcome.receipt.status).toBe("passed"); expect(f.calls).not.toContain("open"); expect(f.calls).not.toContain("agent.start");
  expect(receipts).toEqual([{status: "succeeded"}]); expect(f.calls.filter(call => call === "client.close")).toHaveLength(1);
  const handler = createHostedEvaluationHandler({counter: f.plan});
  await expect(handler({taskRef: "unknown"} as never)).rejects.toThrow(/approved/);
});


test("ambiguous embedded ownership is refused without closing either client", async () => {
  const first = setup("hosted"), second = setup("hosted");
  await expect(evaluateHostedSubmission({client: first.client as never, session: second.session as never,
    run: first.hosting as never, taskRef: "counter", signal: new AbortController().signal}, first.plan)).rejects.toThrow(/owner/);
  expect(first.calls).toEqual([]); expect(second.calls).toEqual([]);
});

test("explicit failed-cleanup receipt cannot turn a completed model into an overall pass", async () => {
  const f = setup();
  f.session.close = async () => ({wait: async () => ({operationId: 1, status: "succeeded", result: {
    phase: "cleanupFailed", cleanupStatus: "failed", remainingResources: ["worker"],
  }})}) as never;
  const outcome = await evaluateImplementationWithDependencies(f.plan, f.options, f.dependencies);
  expect(outcome.receipt.model.status).toBe("passed"); expect(outcome.receipt.status).toBe("failed");
  expect(outcome.receipt.cleanup.status).toBe("failed"); expect(outcome.receipt.cleanup.remainingResources).toEqual(["worker"]);
  expect(outcome.publicResult).toMatchObject({status: "failed", cleanup: "failed"});
});

import { ControlError } from "mirrorgate/control";

test.each([
  ["CONTROL_REQUEST_CANCELLED", "cancelled"],
  ["CONTROL_REQUEST_TIMEOUT", "timedOut"],
  ["CONTROL_DISCONNECTED", "failed"],
] as const)("unacknowledged open %s retains uncertain cleanup after socket close", async (code, status) => {
  const f = setup(); const primary = Object.assign(new Error("session.open acknowledgement unavailable"), {name: "ControlProtocolError", code});
  f.plan.gate = {kind: "attached", socketPath: "/approved/control.sock", expectedOwner: 1000};
  f.client.openSession = async () => {f.calls.push("open-dispatched"); throw primary;};
  const outcome = await evaluateImplementationWithDependencies(f.plan, f.options, f.dependencies);
  expect(outcome.receipt.status).toBe(status); expect(outcome.publicResult.status).toBe(status);
  expect(outcome.receipt.primaryFailure?.error).toBe(primary); expect(outcome.receipt.primaryFailure?.stage).toBe("open");
  expect(outcome.receipt.model.status).toBe("notRun"); expect(outcome.receipt.cleanup.status).toBe("unconfirmed");
  expect(outcome.publicResult.cleanup).toBe("unconfirmed");
  expect(f.calls).toContain("client.close"); expect(f.calls).not.toContain("prepare");
  expect(f.calls).not.toContain("agent.start"); expect(f.calls).not.toContain("authorize");
});

test("known preallocation argument refusal preserves confirmed cleanup", async () => {
  const f = setup(); const primary = new ControlError({code: "ARGUMENT_INVALID", stage: "policy", message: "invalid manifest"});
  f.client.openSession = async () => {throw primary;};
  const outcome = await evaluateImplementationWithDependencies(f.plan, f.options, f.dependencies);
  expect(outcome.receipt.primaryFailure?.error).toBe(primary); expect(outcome.receipt.cleanup.status).toBe("confirmed");
  expect(f.calls).not.toContain("prepare"); expect(f.calls).toContain("client.close");
});

test.each(["CONTROL_CONNECT_TIMEOUT", "CONTROL_HANDSHAKE_TIMEOUT"] as const)("%s is timed out before session opening", async code => {
  const f = setup(); const primary = Object.assign(new Error("control bootstrap deadline"), {name: "ControlProtocolError", code});
  const outcome = await evaluateImplementationWithDependencies(f.plan, f.options, {connect: async () => {throw primary;}});
  expect(outcome.receipt.status).toBe("timedOut"); expect(outcome.receipt.primaryFailure?.error).toBe(primary);
  expect(outcome.receipt.cleanup.status).toBe("confirmed"); expect(f.calls).toEqual([]);
});

test.each([
  ["CONTROL_REQUEST_CANCELLED", "cancelled"],
  ["CONTROL_REQUEST_TIMEOUT", "timedOut"],
] as const)("provider admission %s preserves outcome and joins known-session cancellation", async (code, status) => {
  const f = setup(); const failure = Object.assign(new Error("worker authorization result unavailable"), {name: "ControlProtocolError", code});
  f.session.authorize = async () => {throw failure;};
  const outcome = await evaluateImplementationWithDependencies(f.plan, f.options, f.dependencies);
  expect(outcome.receipt.status).toBe(status); expect(outcome.receipt.model.status).toBe(status);
  expect(outcome.receipt.cleanup.status).toBe("confirmed");
  expect(f.calls).toContain("session.cancel"); expect(f.calls).not.toContain("acquire");
  const causes: unknown[] = [];
  for (let value = outcome.receipt.primaryFailure?.error; value; value = (value as Error).cause) causes.push(value);
  expect(causes).toContain(failure);
});


test.each([
  ["CANCELLED", "cleanup", "cancelled"],
  ["CLEANUP_FAILED", "cleanup", "failed"],
  ["POLICY_DENIED", "policy", "failed"],
] as const)("correlated open %s/%s still requires allocation cleanup evidence", async (code, stage, status) => {
  const f = setup(); const primary = new ControlError({code, stage, message: "allocation cleanup not confirmed"});
  f.client.openSession = async () => {throw primary;};
  const outcome = await evaluateImplementationWithDependencies(f.plan, f.options, f.dependencies);
  expect(outcome.receipt.status).toBe(status); expect(outcome.receipt.primaryFailure?.error).toBe(primary);
  expect(outcome.receipt.cleanup.status).toBe("unconfirmed"); expect(outcome.publicResult.cleanup).toBe("unconfirmed");
  expect(f.calls).toContain("client.close"); expect(f.calls).not.toContain("prepare");
});
