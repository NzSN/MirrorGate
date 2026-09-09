import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  decodeSemanticDescriptor,
  semanticDescriptorDigest,
  type ContractV1,
  type SemanticDescriptor,
} from "mirrorecma";
import {
  createSandboxCompiledModel, createSandboxPublicManifest, evaluateSandboxed,
  type SandboxCompiledModel, type SandboxEvaluationPlan,
} from "mirrorgate-mirrorecma/legacy";
import {
  CounterAsyncStateComputerContractVersion,
  CounterAsyncTargetProfile,
  CounterModelInterface,
  CounterPublicManifest,
  bindCounterAsyncPublicPort,
} from "./fixtures/model-interface/counter/generated-async/CounterMirror.generated.js";

const CONTROL_SPECIFIER = "mirrorgate/control";

interface GateProbe {
  authorizations: number;
  acquisitions: number;
  connections: number;
  invocations: string[];
  dispatched?: (operation: string) => void;
}

/** Observe public SDK calls without importing a private integration test seam. */
async function installGateProbe(probe: GateProbe): Promise<() => void> {
  const control = await import(CONTROL_SPECIFIER) as any;
  const launch = control.ControlClient.launch;
  const connectUnix = control.ControlClient.connectUnix;
  const wrapWorker = (worker: any) => ({
    invoke: (operation: string, ...args: any[]) => {
      const pending = worker.invoke(operation, ...args);
      probe.invocations.push(operation);
      probe.dispatched?.(operation);
      return pending;
    },
    observe: (...args: any[]) => worker.observe(...args),
    close: (...args: any[]) => worker.close(...args),
  });
  const wrapReservation = (reservation: any) => ({
    connect: async (...args: any[]) => {
      probe.connections += 1;
      return wrapWorker(await reservation.connect(...args));
    },
    release: (...args: any[]) => reservation.release(...args),
  });
  const wrapSession = (session: any) => ({
    authoringExec: (...args: any[]) => session.authoringExec(...args),
    prepare: (...args: any[]) => session.prepare(...args),
    authorize: (...args: any[]) => {
      probe.authorizations += 1;
      return session.authorize(...args);
    },
    acquireWorker: async (...args: any[]) => {
      probe.acquisitions += 1;
      return wrapReservation(await session.acquireWorker(...args));
    },
    cancel: (...args: any[]) => session.cancel(...args),
    close: (...args: any[]) => session.close(...args),
  });
  const wrapClient = (client: any) => ({
    hello: client.hello,
    openSession: async (...args: any[]) => wrapSession(await client.openSession(...args)),
    close: (...args: any[]) => client.close(...args),
  });
  control.ControlClient.launch = async (...args: any[]) => wrapClient(await launch.apply(control.ControlClient, args));
  control.ControlClient.connectUnix = async (...args: any[]) => wrapClient(await connectUnix.apply(control.ControlClient, args));
  return () => {
    control.ControlClient.launch = launch;
    control.ControlClient.connectUnix = connectUnix;
  };
}

function counterDescriptor(root: string): SemanticDescriptor {
  const lock = JSON.parse(readFileSync(join(
    root,
    "test/fixtures/model-interface/counter/Counter.mirror-interface.lock.json",
  ), "utf8")) as Record<string, unknown>;
  const {
    contract: _contract,
    semanticDigest: _semanticDigest,
    provenance: _provenance,
    provenanceDigest: _provenanceDigest,
    ...descriptor
  } = lock;
  return decodeSemanticDescriptor({
    ...descriptor,
    schema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  });
}

function correctModel(root: string): SandboxCompiledModel {
  return createSandboxCompiledModel({
    metadata: CounterModelInterface,
    descriptor: counterDescriptor(root),
    adapterId: "counter.generated-async-v1",
    publicManifest: CounterPublicManifest,
    targetProfile: CounterAsyncTargetProfile,
    stateComputerContractVersion: CounterAsyncStateComputerContractVersion,
    bindPublicPort: bindCounterAsyncPublicPort,
  });
}

function wrongDigestModel(root: string): SandboxCompiledModel {
  const original = counterDescriptor(root);
  const raw = structuredClone(original) as unknown as {
    runProfile: { itfParamVars: string[]; effectiveParamVars: string[] };
  };
  raw.runProfile.itfParamVars = ["ghost"];
  raw.runProfile.effectiveParamVars = ["ghost", "parameters"];
  const descriptor = decodeSemanticDescriptor(raw);
  const contract = structuredClone(CounterModelInterface.contract);
  const digest = semanticDescriptorDigest(descriptor);
  return createSandboxCompiledModel({
    metadata: { semanticDigest: digest, contract: contract as ContractV1 },
    descriptor,
    adapterId: "counter.generated-async-v1",
    publicManifest: createSandboxPublicManifest(descriptor, digest),
    targetProfile: CounterAsyncTargetProfile,
    stateComputerContractVersion: CounterAsyncStateComputerContractVersion,
    bindPublicPort: bindCounterAsyncPublicPort,
  });
}

async function main(): Promise<void> {
  const [controlMode, endpoint, policyFile, policyId, relativePath, runtime,
    mirror, spec, trace, scenario] = process.argv.slice(2);
  assert(controlMode === "owned" || controlMode === "attached");
  assert(runtime === "node-v1" || runtime === "rust-v1");
  assert(["correct", "faulty", "wrong-digest", "generate-correct", "generate-faulty", "source-author", "cancel"].includes(scenario!));
  const generatedReplay = scenario!.startsWith("generate-");
  const sutOutcome = generatedReplay ? scenario!.slice("generate-".length) : scenario!;
  const root = process.env.MIRRORECMA_ROOT;
  assert(root, "MIRRORECMA_ROOT is required");
  const model = scenario === "wrong-digest" ? wrongDigestModel(root) : correctModel(root);
  const controller = new AbortController();
  const diagnostics: string[] = [];
  const probe: GateProbe = {
    authorizations: 0, acquisitions: 0, connections: 0, invocations: [],
  };
  let authorCalls = 0;
  const plan: SandboxEvaluationPlan = {
    gate: controlMode === "owned"
      ? { kind: "owned", launcher: { command: endpoint! }, policyFile: policyFile! }
      : { kind: "attached", socketPath: endpoint!, expectedOwner: process.getuid!() },
    policyId: policyId!,
    submission: scenario === "source-author"
      ? { kind: "source", input: { rootId: "submission", relativePath: relativePath! }, buildPlanId: "copy", authoring: true }
      : { kind: "prebuilt", input: { rootId: "submission", relativePath: relativePath! } },
    runtime,
    model,
    replay: generatedReplay ? {
      kind: "generate",
      target: mirror!,
      config: {
        specPath: spec!, invariant: "TraceComplete", constInit: "CInit",
        lengthBound: 6, paramVars: "parameters",
      },
      traceConfig: { numTraces: 1, view: "View" },
    } : {
      kind: "traces",
      target: mirror!,
      config: {
        specPath: spec!, invariant: "TraceComplete", constInit: "CInit",
        lengthBound: 6, paramVars: "parameters",
      },
      tracePaths: [trace!],
    },
    deadlines: { registrationMs: 60_000, stepMs: 10_000, receiveMs: 60_000 },
    disclosure: { mismatchDetails: true, failureMessages: true },
    ...(scenario === "source-author" ? {
      author: async (session) => {
        authorCalls += 1;
        const result = await session.exec({
          toolId: "python",
          arguments: ["-c", "print('authoring-ok')"],
          cwd: ".",
        });
        assert.equal(result.exitCode, 0);
      },
    } : {}),
  };

  const options = {
    signal: controller.signal,
    onDiagnostic: (diagnostic: import("mirrorgate-mirrorecma/legacy").TrustedSandboxDiagnostic) => {
      if (diagnostic.kind === "failure") diagnostics.push(diagnostic.summary);
      else if (scenario === "cancel" && diagnostic.operationId === "Tick") {
        probe.invocations.push(diagnostic.operationId);
        controller.abort("acceptance-cancel");
      }
    },
  };
  let result;
  const restore = scenario === "wrong-digest" ? await installGateProbe(probe) : () => {};
  try {
    result = await evaluateSandboxed(plan, options);
  } finally {
    restore();
  }

  if (sutOutcome === "correct" || scenario === "source-author") {
    assert.deepEqual({ status: result.status, cleanup: result.cleanup },
      { status: "passed", cleanup: "confirmed" },
      JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value));
    if (scenario === "source-author") assert.equal(authorCalls, 1);
  } else if (sutOutcome === "faulty") {
    assert.equal(result.status, "mismatch");
    assert.equal(result.cleanup, "confirmed");
    assert(result.status === "mismatch" && result.details);
    const expected = result.details.expected as Record<string, { tag: string; val: bigint }>;
    const actual = result.details.actual as Record<string, { tag: string; val: bigint }>;
    assert(expected.count && actual.count);
    assert.equal(expected.count.val - actual.count.val, 1n);
  } else if (scenario === "wrong-digest") {
    assert.equal(result.status, "failed");
    assert(result.status === "failed");
    assert.equal(result.family, "modelNegotiation");
    assert.equal(result.cleanup, "confirmed");
    assert(diagnostics.some(message => /interface_digest_mismatch/i.test(message)),
      `wrong interface diagnostic was not specific: ${diagnostics.join(" | ")}`);
    assert.deepEqual(
      { authorizations: probe.authorizations, acquisitions: probe.acquisitions, connections: probe.connections },
      { authorizations: 0, acquisitions: 0, connections: 0 },
    );
  } else {
    assert.equal(result.status, "cancelled");
    assert.equal(result.cleanup, "confirmed");
    assert(probe.invocations.includes("Tick"), "cancellation did not reach the pending Tick port call");
  }

  process.stdout.write(JSON.stringify({
    schema: "mirrors.shared-orchestration-evidence/v1",
    facade: "typescript",
    workerRuntime: runtime,
    controlMode,
    backend: "linux-bubblewrap-v1",
    sut: scenario,
    replay: generatedReplay ? "generate" : "traces",
    resultStatus: result.status,
    cleanup: result.cleanup,
    ...(scenario === "wrong-digest" ? {
      authorizations: probe.authorizations,
      workerAcquisitions: probe.acquisitions,
      workerConnections: probe.connections,
    } : {}),
    ...(scenario === "cancel" ? { tickDispatched: probe.invocations.includes("Tick") } : {}),
  }) + "\n");
}

await main();
