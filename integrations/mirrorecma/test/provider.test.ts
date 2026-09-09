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
function fixture(model = compiledModel()) {
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
const config = { specPath: "/private/Counter.tla", invariant: "PrivateInvariant", lengthBound: 1, paramVars: "parameters" };
function replay(provider: Awaited<ReturnType<typeof createPreparedImplementationProvider>>, model: SandboxCompiledModel,
  replies = [matched(model.metadata.semanticDigest),
    JSON.stringify({ proto_step: "initial_state", action: "init", state: { privateCanary: "secret" } }),
    JSON.stringify({ proto_step: "all_steps_done" })], signal?: AbortSignal) {
  return runClientWithTracesNegotiatedWithReport(new ScriptedTransport(replies), config,
    ["/private/canary/trace.itf.json"], provider.selection,
    { signal, deadlines: { receiveMs: 200, registrationMs: 200, stepMs: 200 } });
}

test("provider defers launch, uses generated binding, and joins disposal/owner exactly once", async () => {
  const f = fixture(); const provider = await createPreparedImplementationProvider(f.options);
  expect(f.calls).toEqual([]);
  await replay(provider, f.options.model);
  expect(f.calls).toEqual(["authorize", "acquire", "connect", "invoke", "worker.close"]);
  const [first, second] = await Promise.all([provider.close({status: "passed"}), provider.close()]);
  expect(first).toBe(second); expect(first.status).toBe("confirmed");
  expect(f.calls.slice(-2)).toEqual(["session.close", "client.close"]);
  expect(f.calls.filter(x => x === "worker.close")).toHaveLength(1);
  const wire = JSON.stringify(f.traffic);
  for (const secret of ["PrivateInvariant", "privateCanary", "trace.itf", "transport", "iterator"]) expect(wire).not.toContain(secret);
  expect(provider.identity).not.toHaveProperty("challenge");
});
test("match failure has zero worker launches and pre-factory cleanup retains original owner", async () => {
  const f = fixture(); const provider = await createPreparedImplementationProvider(f.options);
  await expect(replay(provider, f.options.model, [mismatched(f.options.model.metadata.semanticDigest)])).rejects.toThrow();
  expect(f.calls).toEqual([]); expect((await provider.close()).status).toBe("confirmed");
  expect(f.calls).toEqual(["session.close", "client.close"]);
});
test("cancel during delayed authorization cannot acquire a worker later", async () => {
  const f = fixture(); const pending = deferred<{}>();
  f.session.authorize = async () => { f.calls.push("authorize"); return pending.promise; };
  const provider = await createPreparedImplementationProvider(f.options);
  const controller = new AbortController(); const run = replay(provider, f.options.model, undefined, controller.signal);
  const checked = expect(run).rejects.toThrow();
  while (!f.calls.includes("authorize")) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort("cancel delayed factory");
  const closing = provider.close({ status: "cancelled" }); pending.resolve({});
  await checked; expect((await closing).status).toBe("confirmed"); expect(f.calls).not.toContain("acquire");
});
test("late constructed binding is disposed after provider closure", async () => {
  const base = compiledModel(); const entered = deferred<void>(); const released = deferred<void>(); let disposed = 0;
  const f = fixture({ ...base, createBinding: async (port, config) => {
    entered.resolve(); await released.promise;
    const binding = await base.createBinding(port, config);
    return { ...binding, dispose: async () => { disposed++; await binding.dispose(); } };
  } });
  const provider = await createPreparedImplementationProvider(f.options);
  const run = replay(provider, f.options.model); const checked = expect(run).rejects.toThrow();
  await entered.promise; const closing = provider.close({ status: "cancelled" }); released.resolve();
  await checked; expect((await closing).status).toBe("confirmed");
  expect(disposed).toBe(1); expect(f.calls).not.toContain("invoke");
});
test("identity and preflight rejection still clean transferred owner", async () => {
  const f = fixture();
  await expect(createPreparedImplementationProvider({ ...f.options,
    prepared: { ...f.options.prepared, artifactHash: "invalid" } })).rejects.toThrow(/identity/);
  expect(f.calls).toEqual(["session.close", "client.close"]);
  const other = fixture();
  await expect(createPreparedImplementationProvider({ ...other.options, deadlines: { receiveMs: 0 } })).rejects.toThrow();
  expect(other.calls).toEqual(["session.close", "client.close"]);
});
test("worker disposal failure survives successful final session cleanup", async () => {
  const f = fixture(); f.worker.close = async () => { throw new Error("worker disposal failed"); };
  const provider = await createPreparedImplementationProvider(f.options);
  await expect(replay(provider, f.options.model)).rejects.toThrow();
  const cleanup = await provider.close(); expect(cleanup.status).toBe("failed"); expect(cleanup.failures).toHaveLength(1);
});

test("partial factory failure preserves primary cause and secondary worker cleanup failure", async () => {
  const primary = new Error("constructor failed"); const cleanupError = new Error("partial worker cleanup failed");
  const f = fixture({ ...compiledModel(), createBinding: async () => { throw primary; } });
  f.worker.close = async () => { throw cleanupError; };
  const provider = await createPreparedImplementationProvider(f.options);
  let received: unknown;
  try { await replay(provider, f.options.model); } catch (error) { received = error; }
  const causes: unknown[] = [];
  for (let value = received; value; value = (value as Error).cause) causes.push(value);
  expect(causes).toContain(primary);
  const cleanup = await provider.close();
  expect(cleanup.status).toBe("failed"); expect(cleanup.failures).toContain(cleanupError);
});

test("unfinished late factory prevents confirmed cleanup without blocking indefinitely", async () => {
  const f = fixture(); const pending = deferred<{}>();
  f.session.authorize = async () => { f.calls.push("authorize"); return pending.promise; };
  const provider = await createPreparedImplementationProvider({ ...f.options, deadlines: { receiveMs: 20 } });
  const run = replay(provider, f.options.model); const checked = expect(run).rejects.toThrow();
  while (!f.calls.includes("authorize")) await new Promise(resolve => setTimeout(resolve, 1));
  const cleanup = await provider.close({ status: "cancelled" });
  expect(cleanup.status).toBe("unconfirmed");
  expect(cleanup.failures).toHaveLength(1);
  pending.resolve({}); await checked;
  expect(f.calls).not.toContain("acquire");
});
