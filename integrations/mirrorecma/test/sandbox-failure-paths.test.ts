import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  decodeSemanticDescriptor,
  semanticDescriptorDigest,
  type GeneratedModelInterface,
  type SemanticDescriptor,
} from "mirrorecma";
import {
  createSandboxCompiledModel,
  createSandboxPublicManifest,
  SANDBOX_ASYNC_COMPUTER_CONTRACT,
  SANDBOX_ASYNC_TARGET_PROFILE,
  type SandboxCompiledModel,
} from "../src/sandbox-model.js";
import {
  evaluateSandboxedWithDependencies,
  type SandboxDisclosurePolicy,
  type SandboxEvaluationPlan,
} from "../src/sandbox.js";
import type { Transport } from "mirrorecma";

function counterDescriptor(): SemanticDescriptor {
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

function counterModel(): SandboxCompiledModel {
  const descriptor = counterDescriptor();
  const digest = semanticDescriptorDigest(descriptor);
  const metadata: GeneratedModelInterface = {
    semanticDigest: digest,
    contract: {
      schema: "mirrors.model-interface/v1",
      interfaceVersion: descriptor.interfaceVersion,
      model: { module: "Counter", source: "/private/model.tla" },
      wire: { actionVariable: "action_taken", parameterVariable: "parameters" },
      initializers: descriptor.initializers.map((item) => ({
        id: item.id,
        wireAction: item.wireAction,
        wireAliases: item.wireAliases,
        inputs: item.inputs.map((input) => ({ id: input.id, from: input.from })),
      })),
      actions: descriptor.actions.map((item) => ({
        id: item.id,
        wireAction: item.wireAction,
        wireAliases: item.wireAliases,
        inputs: item.inputs.map((input) => ({ id: input.id, from: input.from })),
      })),
      observations: descriptor.observations.map((item) => ({
        id: item.id,
        wireName: item.wireName,
        provenance: "implementation" as const,
      })),
    },
  };
  return createSandboxCompiledModel({
    metadata,
    descriptor,
    adapterId: "counter.async",
    targetProfile: SANDBOX_ASYNC_TARGET_PROFILE,
    stateComputerContractVersion: SANDBOX_ASYNC_COMPUTER_CONTRACT,
    publicManifest: createSandboxPublicManifest(descriptor, digest),
    bindPublicPort: (port) => ({
      computer: async ({ action }, context) => {
        if (action !== "init") throw new Error("unexpected action");
        await port.invoke("Initialize", {}, context);
        const observation = await port.observe(context);
        return { count: { tag: "int", val: observation["Count"] as bigint } };
      },
      assertCompatibleConfig: () => {},
      coverage: () => ({ Initialize: 1 }),
    }),
  });
}

class SandboxTransport implements Transport {
  readonly sent: string[] = [];
  closes = 0;
  private index = 0;

  constructor(
    private readonly replies: readonly string[],
    private readonly closeFailure?: Error,
  ) {}

  send(line: string): void { this.sent.push(line); }
  async close(): Promise<number> {
    this.closes += 1;
    if (this.closeFailure !== undefined) throw this.closeFailure;
    return 0;
  }
  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => this.index < this.replies.length
        ? { value: this.replies[this.index++]!, done: false }
        : { value: "", done: true },
    };
  }
}

function matched(model: SandboxCompiledModel): string {
  return JSON.stringify({
    proto_step: "spec_validated",
    result: "valid",
    modelInterface: {
      schema: "mirrors.model-interface-negotiation/v1",
      status: "matched",
      descriptorSchema: "mirrors.model-interface-descriptor/v1",
      semanticDigest: `sha256:${model.metadata.semanticDigest}`,
    },
  });
}

function initial(): string {
  return JSON.stringify({ proto_step: "initial_state", action: "init", state: {} });
}

function mismatch(): string {
  return JSON.stringify({
    proto_step: "step_mismatch",
    action: "init",
    expected: { count: { "#bigint": "1" } },
    actual: { count: { "#bigint": "0" } },
    hints: [],
  });
}

interface HarnessOptions {
  readonly prepareFailure?: { readonly code: string; readonly stage: string };
  readonly authorizeError?: Error;
  readonly authorizePending?: boolean;
  readonly workerError?: Error;
  readonly workerPending?: boolean;
  readonly workerCloseError?: Error;
  readonly cleanupStatus?: "succeeded" | "failed";
}

interface HarnessCounts {
  prepare: number;
  authorize: number;
  acquire: number;
  invoke: number;
  cancel: number;
  close: number;
}

function harness(model: SandboxCompiledModel, options: HarnessOptions = {}) {
  const counts: HarnessCounts = {
    prepare: 0, authorize: 0, acquire: 0, invoke: 0, cancel: 0, close: 0,
  };
  const manifestJson = JSON.stringify(model.publicManifest);
  const cleanupOperation = () => ({
    wait: async () => ({
      operationId: 3,
      status: "succeeded" as const,
      result: {
        phase: "closed",
        cleanupStatus: options.cleanupStatus ?? "succeeded",
        remainingResources: options.cleanupStatus === "failed" ? ["worker"] : [],
      },
    }),
  });
  const worker = {
    invoke: async () => {
      counts.invoke += 1;
      if (options.workerError !== undefined) throw options.workerError;
      if (options.workerPending) await new Promise<void>(() => {});
    },
    observe: async () => ({ Count: 0n }),
    close: async () => {
      if (options.workerCloseError !== undefined) throw options.workerCloseError;
    },
  };
  const session = {
    authoringExec: async () => ({
      wait: async () => ({ operationId: 1, status: "succeeded" as const, result: {
        exitCode: 0, stdoutBytes: 0, stderrBytes: 0,
      } }),
    }),
    prepare: async () => {
      counts.prepare += 1;
      if (options.prepareFailure !== undefined) {
        return {
          wait: async () => ({
            operationId: 1,
            status: "failed" as const,
            error: { ...options.prepareFailure, message: "preparation failed" },
          }),
        };
      }
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
    authorize: async () => {
      counts.authorize += 1;
      if (options.authorizeError !== undefined) throw options.authorizeError;
      if (options.authorizePending) return new Promise<unknown>(() => {});
      return { id: "authorization" };
    },
    acquireWorker: async () => {
      counts.acquire += 1;
      return {
        connect: async () => worker,
        release: async () => cleanupOperation(),
      };
    },
    cancel: async () => { counts.cancel += 1; return cleanupOperation(); },
    close: async () => { counts.close += 1; return cleanupOperation(); },
  };
  return {
    counts,
    dependencies: {
      loadGateSdk: async () => ({
        ControlClient: {
          launch: async () => ({
            hello: { limits: { teardownMs: 1_000 } },
            openSession: async () => session,
            close: async () => {},
          }),
          connectUnix: async () => { throw new Error("not used"); },
        },
        createPublicManifest: () => model.publicManifest,
        toWorkerValue: (_type: unknown, value: unknown) => value,
        fromWorkerValue: (_type: unknown, value: unknown) => value,
      }),
    },
  };
}

function evaluationPlan(
  model: SandboxCompiledModel,
  target: Transport,
  options: {
    readonly author?: SandboxEvaluationPlan["author"];
    readonly disclosure?: SandboxDisclosurePolicy;
  } = {},
): SandboxEvaluationPlan {
  return {
    gate: { kind: "owned", launcher: { command: "/approved/gate" }, policyFile: "/approved/policy" },
    policyId: "test",
    submission: options.author === undefined
      ? { kind: "prebuilt", input: { rootId: "submission", relativePath: "counter" } }
      : {
          kind: "source",
          input: { rootId: "submission", relativePath: "counter" },
          buildPlanId: "build",
          authoring: true,
        },
    runtime: "node-v1",
    model,
    replay: {
      kind: "traces",
      target,
      config: { specPath: "/private/model.tla", invariant: "SecretInv", lengthBound: 1, paramVars: "parameters" },
      tracePaths: ["/private/trace.itf.json"],
    },
    deadlines: { registrationMs: 50, stepMs: 50, receiveMs: 50 },
    ...(options.author === undefined ? {} : { author: options.author }),
    ...(options.disclosure === undefined ? {} : { disclosure: options.disclosure }),
  };
}

function stagedError(name: string, code: string, stage: string): Error {
  return Object.assign(new Error(name), { name, code, stage });
}

test("mismatch remains primary when worker cleanup also fails", async () => {
  const model = counterModel();
  const target = new SandboxTransport([matched(model), initial(), mismatch()]);
  const fake = harness(model, { workerCloseError: new Error("worker close failed") });
  const result = await evaluateSandboxedWithDependencies(
    evaluationPlan(model, target), {}, fake.dependencies,
  );
  expect(result).toMatchObject({ status: "mismatch", cleanup: "failed" });
  expect(result).not.toHaveProperty("details");
  expect(JSON.stringify(result)).not.toContain("worker close failed");
});

test("a passed replay with unconfirmed model transport cleanup is a cleanup failure", async () => {
  const model = counterModel();
  const target = new SandboxTransport(
    [matched(model), initial(), JSON.stringify({ proto_step: "all_steps_done" })],
    new Error("model close unconfirmed"),
  );
  const fake = harness(model);
  const result = await evaluateSandboxedWithDependencies(
    evaluationPlan(model, target), {}, fake.dependencies,
  );
  expect(result).toMatchObject({ status: "failed", family: "cleanup", cleanup: "failed" });
});

test.each([
  ["preparation", { prepareFailure: { code: "PREPARATION_FAILED", stage: "prepare" } }],
  ["build", { prepareFailure: { code: "BUILD_FAILED", stage: "build" } }],
  ["backendAdmission", {
    authorizeError: stagedError("GateAdmissionError", "BACKEND_ADMISSION_FAILED", "authorize"),
  }],
  ["workerProtocol", {
    workerError: stagedError("ProtocolError", "FRAME", "worker"),
  }],
  ["application", { workerError: new Error("submitted adapter failed") }],
] as const)("keeps the %s failure family distinct", async (family, options) => {
  const model = counterModel();
  const target = new SandboxTransport([matched(model), initial()]);
  const fake = harness(model, options);
  const result = await evaluateSandboxedWithDependencies(
    evaluationPlan(model, target), {}, fake.dependencies,
  );
  expect(result).toMatchObject({ status: "failed", family });
});

test("cancellation interrupts a pending author callback and seals its tools", async () => {
  const model = counterModel();
  const controller = new AbortController();
  let authorSession: Parameters<NonNullable<SandboxEvaluationPlan["author"]>>[0] | undefined;
  const author = async (session: NonNullable<typeof authorSession>) => {
    authorSession = session;
    controller.abort("cancel author");
    await new Promise<void>(() => {});
  };
  const fake = harness(model);
  const result = await evaluateSandboxedWithDependencies(
    evaluationPlan(model, new SandboxTransport([]), { author }),
    { signal: controller.signal },
    fake.dependencies,
  );
  expect(result).toMatchObject({ status: "cancelled", cleanup: "confirmed" });
  expect(fake.counts.prepare).toBe(0);
  await expect(authorSession!.exec({ toolId: "after", arguments: [] })).rejects.toThrow("sealed");
});

test.each(["factory", "worker"] as const)("cancellation interrupts a pending %s operation", async (stage) => {
  const model = counterModel();
  const controller = new AbortController();
  const target = new SandboxTransport([matched(model), ...(stage === "worker" ? [initial()] : [])]);
  const fake = harness(model, stage === "factory"
    ? { authorizePending: true }
    : { workerPending: true });
  const pending = evaluateSandboxedWithDependencies(
    evaluationPlan(model, target),
    { signal: controller.signal },
    fake.dependencies,
  );
  while (stage === "factory" ? fake.counts.authorize === 0 : fake.counts.invoke === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  controller.abort(`cancel ${stage}`);
  const result = await pending;
  expect(result).toMatchObject({ status: "cancelled", cleanup: "confirmed" });
  expect(fake.counts.cancel).toBe(1);
});

test("snapshot disclosure is fixed before author mutation and the caller transport stays mutable", async () => {
  const model = counterModel();
  const disclosure: { mismatchDetails: boolean } = { mismatchDetails: false };
  const target = new SandboxTransport([matched(model), initial(), mismatch()]);
  const fake = harness(model);
  const result = await evaluateSandboxedWithDependencies(
    evaluationPlan(model, target, {
      disclosure,
      author: () => { disclosure.mismatchDetails = true; },
    }),
    {},
    fake.dependencies,
  );
  expect(result).toMatchObject({ status: "mismatch" });
  expect(result).not.toHaveProperty("details");
  expect(Object.isFrozen(target)).toBe(false);
  target.sent.push("still mutable");
  expect(target.sent).toContain("still mutable");
});
