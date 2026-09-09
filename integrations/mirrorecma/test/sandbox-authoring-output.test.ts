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
  SANDBOX_AUTHORING_OUTPUT_BYTES,
  evaluateSandboxedWithDependencies,
  type SandboxAuthoringExecResult,
  type SandboxEvaluationPlan,
} from "../src/sandbox.js";
import type { Transport } from "mirrorecma";

function counterModel(): SandboxCompiledModel {
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
  const descriptor = decodeSemanticDescriptor({
    ...resolved,
    schema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  }) as SemanticDescriptor;
  const digest = semanticDescriptorDigest(descriptor);
  const metadata: GeneratedModelInterface = {
    semanticDigest: digest,
    contract: {
      schema: "mirrors.model-interface/v1",
      interfaceVersion: descriptor.interfaceVersion,
      model: { module: "Counter", source: "/private/Counter.tla" },
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
    adapterId: "counter.authoring-output-v1",
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
    }),
  });
}

class ScriptedTransport implements Transport {
  readonly sent: string[] = [];
  private index = 0;

  constructor(private readonly replies: readonly string[]) {}
  send(line: string): void { this.sent.push(line); }
  async close(): Promise<number> { return 0; }
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

function outputEvent(
  operationId: number,
  stream: "stdout" | "stderr",
  chunk: number,
  bytes: Uint8Array,
): unknown {
  return {
    v: 1,
    kind: "event",
    seq: chunk,
    sessionId: "session",
    event: "authoring.output",
    data: { operationId, stream, chunk, bytesBase64: Buffer.from(bytes).toString("base64") },
  };
}

function outputEvents(operationId: number, stream: "stdout" | "stderr", bytes: Uint8Array): unknown[] {
  const events: unknown[] = [];
  for (let start = 0, chunk = 1; start < bytes.byteLength; start += 16_384, chunk += 1) {
    events.push(outputEvent(operationId, stream, chunk, bytes.subarray(start, start + 16_384)));
  }
  return events;
}

interface HarnessOptions {
  readonly operationId?: number;
  readonly events?: readonly unknown[];
  readonly receipt?: { readonly exitCode: number; readonly stdoutBytes: number; readonly stderrBytes: number };
  readonly omitOnEvent?: boolean;
}

function harness(model: SandboxCompiledModel, options: HarnessOptions = {}) {
  const listeners = new Set<(event: unknown) => void>();
  const counts = { prepare: 0, close: 0, subscriptions: 0, removals: 0 };
  const manifestJson = JSON.stringify(model.publicManifest);
  const operationId = options.operationId ?? 41;
  const cleanupOperation = () => ({
    wait: async () => ({
      operationId: 90,
      status: "succeeded" as const,
      result: { phase: "closed", cleanupStatus: "succeeded", remainingResources: [] },
    }),
  });
  const session = {
    authoringExec: async () => {
      for (const event of options.events ?? []) {
        for (const listener of listeners) listener(event);
      }
      return {
        id: operationId,
        wait: async () => ({
          operationId,
          status: "succeeded" as const,
          result: options.receipt ?? { exitCode: 0, stdoutBytes: 0, stderrBytes: 0 },
        }),
      };
    },
    prepare: async () => {
      counts.prepare += 1;
      return {
        id: 42,
        wait: async () => ({
          operationId: 42,
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
    authorize: async () => ({ id: "authorization" }),
    acquireWorker: async () => ({
      connect: async () => ({
        invoke: async () => {},
        observe: async () => ({ Count: 0n }),
        close: async () => {},
      }),
      release: async () => cleanupOperation(),
    }),
    cancel: async () => cleanupOperation(),
    close: async () => { counts.close += 1; return cleanupOperation(); },
    ...(options.omitOnEvent ? {} : {
      onEvent: (listener: (event: unknown) => void, subscription?: { replay?: boolean }) => {
        expect(subscription).toEqual({ replay: false });
        counts.subscriptions += 1;
        listeners.add(listener);
        return () => {
          if (listeners.delete(listener)) counts.removals += 1;
        };
      },
    }),
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

function plan(
  model: SandboxCompiledModel,
  author: NonNullable<SandboxEvaluationPlan["author"]>,
): SandboxEvaluationPlan {
  return {
    gate: { kind: "owned", launcher: { command: "/approved/gate" }, policyFile: "/approved/policy" },
    policyId: "test",
    submission: {
      kind: "source",
      input: { rootId: "submission", relativePath: "counter" },
      buildPlanId: "build",
      authoring: true,
    },
    runtime: "node-v1",
    model,
    replay: {
      kind: "traces",
      target: new ScriptedTransport([
        matched(model),
        JSON.stringify({ proto_step: "initial_state", action: "init", state: {} }),
        JSON.stringify({ proto_step: "all_steps_done" }),
      ]),
      config: { specPath: "/private/Counter.tla", invariant: "Inv", lengthBound: 1, paramVars: "parameters" },
      tracePaths: ["/private/trace.itf.json"],
    },
    deadlines: { registrationMs: 1_000, receiveMs: 1_000, stepMs: 1_000 },
    author,
  };
}

test("returns only correlated authoring stdout and stderr with actual byte receipts", async () => {
  const model = counterModel();
  const stdout = Buffer.from("界\n");
  const stderr = Buffer.from("warn");
  const events = [
    { event: "build.output", data: { privateCanary: "must-not-leak" } },
    outputEvent(41, "stdout", 1, stdout.subarray(0, 1)),
    outputEvent(41, "stderr", 1, stderr),
    outputEvent(41, "stdout", 2, stdout.subarray(1)),
  ];
  const fake = harness(model, {
    events,
    receipt: { exitCode: 7, stdoutBytes: stdout.byteLength, stderrBytes: stderr.byteLength },
  });
  let authorResult: SandboxAuthoringExecResult | undefined;
  const result = await evaluateSandboxedWithDependencies(plan(model, async (session) => {
    authorResult = await session.exec({ toolId: "inspect", arguments: ["counter.ts"] });
  }), {}, fake.dependencies);

  expect(result).toMatchObject({ status: "passed", cleanup: "confirmed" });
  expect(authorResult).toEqual({
    exitCode: 7,
    stdoutBytes: 4,
    stderrBytes: 4,
    stdout: "界\n",
    stderr: "warn",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  expect(JSON.stringify(authorResult)).not.toContain("must-not-leak");
  expect(fake.counts).toMatchObject({ prepare: 1, subscriptions: 1, removals: 1 });
});

test("bounds retained bytes and does not emit a replacement character at a split UTF-8 boundary", async () => {
  const model = counterModel();
  const stdout = Buffer.concat([
    Buffer.alloc(SANDBOX_AUTHORING_OUTPUT_BYTES - 1, 0x61),
    Buffer.from("界"),
  ]);
  const fake = harness(model, {
    events: outputEvents(41, "stdout", stdout),
    receipt: { exitCode: 0, stdoutBytes: stdout.byteLength, stderrBytes: 0 },
  });
  let authorResult: SandboxAuthoringExecResult | undefined;
  const result = await evaluateSandboxedWithDependencies(plan(model, async (session) => {
    authorResult = await session.exec({ toolId: "inspect", arguments: [] });
  }), {}, fake.dependencies);

  expect(result.status).toBe("passed");
  expect(authorResult?.stdoutBytes).toBe(SANDBOX_AUTHORING_OUTPUT_BYTES + 2);
  expect(authorResult?.stdoutTruncated).toBe(true);
  expect(authorResult?.stdout).toHaveLength(SANDBOX_AUTHORING_OUTPUT_BYTES - 1);
  expect(authorResult?.stdout).not.toContain("�");
});

test("fails closed when a nonempty receipt cannot be reconstructed from public events", async () => {
  const model = counterModel();
  const fake = harness(model, {
    omitOnEvent: true,
    receipt: { exitCode: 0, stdoutBytes: 1, stderrBytes: 0 },
  });
  const result = await evaluateSandboxedWithDependencies(plan(model, async (session) => {
    await session.exec({ toolId: "inspect", arguments: [] });
  }), {}, fake.dependencies);

  expect(result).toMatchObject({ status: "failed", family: "controlCompatibility", cleanup: "confirmed" });
  expect(fake.counts).toMatchObject({ prepare: 0, close: 1, subscriptions: 0, removals: 0 });
});

test("keeps zero-output fake sessions compatible without an event API", async () => {
  const model = counterModel();
  const fake = harness(model, { omitOnEvent: true });
  let authorResult: SandboxAuthoringExecResult | undefined;
  const result = await evaluateSandboxedWithDependencies(plan(model, async (session) => {
    authorResult = await session.exec({ toolId: "inspect", arguments: [] });
  }), {}, fake.dependencies);

  expect(result.status).toBe("passed");
  expect(authorResult).toMatchObject({
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  });
});

test("rejects output carrying an operation ID foreign to the returned handle", async () => {
  const model = counterModel();
  const fake = harness(model, {
    events: [outputEvent(99, "stdout", 1, Buffer.from("foreign-secret"))],
    receipt: { exitCode: 0, stdoutBytes: 14, stderrBytes: 0 },
  });
  const result = await evaluateSandboxedWithDependencies(plan(model, async (session) => {
    await session.exec({ toolId: "inspect", arguments: [] });
  }), {}, fake.dependencies);

  expect(result).toMatchObject({ status: "failed", family: "controlCompatibility" });
  expect(fake.counts).toMatchObject({ prepare: 0, subscriptions: 1, removals: 1 });
  expect(JSON.stringify(result)).not.toContain("foreign-secret");
});

test("permits only one authoring command at a time", async () => {
  const model = counterModel();
  const fake = harness(model);
  const result = await evaluateSandboxedWithDependencies(plan(model, async (session) => {
    const first = session.exec({ toolId: "first", arguments: [] });
    await expect(session.exec({ toolId: "second", arguments: [] })).rejects.toThrow("one authoring command");
    await first;
  }), {}, fake.dependencies);

  expect(result.status).toBe("passed");
  expect(fake.counts).toMatchObject({ subscriptions: 1, removals: 1 });
});
