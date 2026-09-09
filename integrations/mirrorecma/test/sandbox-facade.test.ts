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

interface FakeCounts {
  load: number; open: number; prepare: number; authorize: number;
  acquire: number; connect: number; invoke: number; observe: number;
  workerClose: number; sessionClose: number; clientClose: number;
  workerTraffic: unknown[];
}

function fakeDependencies(model: SandboxCompiledModel, counts: FakeCounts) {
  const digest = model.metadata.semanticDigest;
  const manifest = model.publicManifest;
  const manifestJson = JSON.stringify(manifest);
  void digest;
  return {
    loadGateSdk: async () => {
      counts.load += 1;
      const cleanup = () => ({
        wait: async () => ({
          operationId: 1,
          status: "succeeded" as const,
          result: {
            phase: "closed",
            cleanupStatus: "succeeded",
            remainingResources: [],
          },
        }),
      });
      const worker = {
        invoke: async (id: string, inputs: Record<string, unknown>) => {
          counts.invoke += 1; counts.workerTraffic.push({ id, inputs });
        },
        observe: async () => {
          counts.observe += 1; counts.workerTraffic.push({ op: "observe" });
          return { Count: 0n };
        },
        close: async () => { counts.workerClose += 1; },
      };
      const session = {
        authoringExec: async () => { throw new Error("not used"); },
        prepare: async () => {
          counts.prepare += 1;
          return {
            wait: async () => ({
              operationId: 1,
              status: "succeeded" as const,
              result: {
                preparedRevision: 1,
                artifactId: "artifact",
                artifactHash: "a".repeat(64),
                manifestHash: createHash("sha256")
                  .update("mirrorgate.public-manifest/v1")
                  .update(Buffer.from([0]))
                  .update(manifestJson)
                  .digest("hex"),
                runtime: "node-v1",
                policyId: "test",
                challenge: "c".repeat(32),
              },
            }),
          };
        },
        authorize: async () => { counts.authorize += 1; return { id: "authorization" }; },
        acquireWorker: async () => {
          counts.acquire += 1;
          return {
            connect: async () => { counts.connect += 1; return worker; },
            release: async () => cleanupOperation(),
          };
        },
        cancel: async () => cleanupOperation(),
        close: async () => { counts.sessionClose += 1; return cleanupOperation(); },
      };
      const cleanupOperation = () => ({
        wait: async () => ({
          operationId: 2,
          status: "succeeded" as const,
          result: { phase: "closed", cleanupStatus: "succeeded", remainingResources: [] },
        }),
      });
      return {
        ControlClient: {
          launch: async () => ({
            hello: { limits: { teardownMs: 5_000 } },
            openSession: async () => { counts.open += 1; return session; },
            close: async () => { counts.clientClose += 1; },
          }),
          connectUnix: async () => { throw new Error("not used"); },
        },
        createPublicManifest: () => manifest,
        toWorkerValue: (_type: unknown, value: unknown) => value,
        fromWorkerValue: (_type: unknown, value: unknown) => value,
      };
    },
  };
}

function counts(): FakeCounts {
  return {
    load: 0, open: 0, prepare: 0, authorize: 0, acquire: 0, connect: 0,
    invoke: 0, observe: 0, workerClose: 0, sessionClose: 0, clientClose: 0,
    workerTraffic: [],
  };
}

function plan(model: SandboxCompiledModel, target: Transport): SandboxEvaluationPlan {
  return {
    gate: { kind: "owned", launcher: { command: "/approved/mirrorgate" }, policyFile: "/approved/policy.json" },
    policyId: "test",
    submission: { kind: "prebuilt", input: { rootId: "submission", relativePath: "counter" } },
    runtime: "node-v1",
    model,
    replay: {
      kind: "traces",
      target,
      config: { specPath: "/private/canary/Counter.tla", invariant: "PrivateInvariant", lengthBound: 1, paramVars: "parameters" },
      tracePaths: ["/private/canary/trace.itf.json"],
    },
  };
}

test("one call negotiates before worker launch and returns only a redacted pass", async () => {
  const model = compiledModel();
  const tally = counts();
  const target = new ScriptedTransport([
    matched(model.metadata.semanticDigest),
    JSON.stringify({ proto_step: "initial_state", action: "init", state: { privateCanary: "secret" } }),
    JSON.stringify({ proto_step: "all_steps_done" }),
  ]);
  const result = await evaluateSandboxedWithDependencies(plan(model, target), {}, fakeDependencies(model, tally));
  expect(result).toEqual(expect.objectContaining({ status: "passed", cleanup: "confirmed" }));
  expect(tally).toEqual(expect.objectContaining({ authorize: 1, acquire: 1, connect: 1, invoke: 1, observe: 1, workerClose: 1 }));
  expect(JSON.stringify(tally.workerTraffic)).not.toContain("privateCanary");
  expect(JSON.stringify(tally.workerTraffic)).not.toContain("PrivateInvariant");
  expect(JSON.stringify(result)).not.toContain("private");
});

test("wrong model negotiation performs zero authorization and worker allocation", async () => {
  const model = compiledModel();
  const tally = counts();
  const target = new ScriptedTransport([mismatched(model.metadata.semanticDigest)]);
  const result = await evaluateSandboxedWithDependencies(plan(model, target), {}, fakeDependencies(model, tally));
  expect(result).toEqual(expect.objectContaining({ status: "failed", family: "modelNegotiation", cleanup: "confirmed" }));
  expect(tally).toEqual(expect.objectContaining({ authorize: 0, acquire: 0, connect: 0, invoke: 0 }));
});

test("already aborted evaluation performs zero SDK load, preparation, or launch", async () => {
  const model = compiledModel();
  const tally = counts();
  const controller = new AbortController();
  controller.abort(new Error("private abort reason"));
  const result = await evaluateSandboxedWithDependencies(
    plan(model, new ScriptedTransport([])),
    { signal: controller.signal },
    fakeDependencies(model, tally),
  );
  expect(result).toEqual(expect.objectContaining({ status: "cancelled", cleanup: "confirmed" }));
  expect(tally.load).toBe(0);
});

test("diagnostic sink failures are bounded and retained outside the public result", async () => {
  const model = compiledModel();
  const tally = counts();
  const result = await evaluateSandboxedWithDependencies(
    plan(model, new ScriptedTransport([mismatched(model.metadata.semanticDigest)])),
    { onDiagnostic: () => { throw new Error("sink offline"); } },
    fakeDependencies(model, tally),
  );
  expect(JSON.stringify(result)).not.toContain("sink offline");
  expect(sandboxDiagnosticFailures(result)).toEqual(["sink offline"]);
});

test("trusted mismatch diagnostics stay within the UTF-8 byte limit at a Unicode boundary", async () => {
  const model = compiledModel();
  const tally = counts();
  const huge = "界".repeat(30_000);
  const target = new ScriptedTransport([
    matched(model.metadata.semanticDigest),
    JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
    JSON.stringify({
      proto_step: "step_mismatch",
      action: "init",
      expected: { text: huge },
      actual: { text: huge },
      hints: [],
    }),
  ]);
  let detail = "";
  const result = await evaluateSandboxedWithDependencies(
    plan(model, target),
    {
      onDiagnostic: (diagnostic) => {
        if (diagnostic.kind === "failure") detail = diagnostic.detail ?? "";
      },
    },
    fakeDependencies(model, tally),
  );
  expect(result.status).toBe("mismatch");
  expect(new TextEncoder().encode(detail).byteLength).toBeLessThanOrEqual(65_535);
  expect(detail.endsWith("…")).toBe(true);
  expect(detail).not.toContain("�");
});

test.each([
  ["CONTROL_REQUEST_CANCELLED", "cancelled"],
  ["CONTROL_REQUEST_TIMEOUT", "timedOut"],
  ["CONTROL_DISCONNECTED", "failed"],
] as const)("legacy facade keeps lost-open %s cleanup unconfirmed", async (code, status) => {
  const model = compiledModel(); const tally = counts(); const dependencies = fakeDependencies(model, tally);
  const sdk = await dependencies.loadGateSdk(); const launch = sdk.ControlClient.launch;
  sdk.ControlClient.launch = async () => {
    const client = await launch();
    client.openSession = async () => {throw Object.assign(new Error("uncertain open"), {name: "ControlProtocolError", code});};
    return client;
  };
  const result = await evaluateSandboxedWithDependencies(plan(model, new ScriptedTransport([])), {}, {loadGateSdk: async () => sdk});
  expect(result.status).toBe(status); expect(result.cleanup).toBe("unconfirmed");
  expect(tally.clientClose).toBe(1); expect(tally.prepare).toBe(0); expect(tally.authorize).toBe(0);
});
