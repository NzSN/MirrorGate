import { resolve } from "node:path";
import {
  AsyncCompiledAdapterRegistry,
  runClientWithTracesNegotiatedWithReport,
  semanticDigestFromHex,
  type ApalacheConfig,
  type AsyncAdapterFactory,
  type CompiledReplayReport,
  type ReplayDeadlines,
  type Transport,
} from "mirrorecma";
import {
  CounterAsyncStateComputerContractVersion,
  CounterAsyncTargetProfile,
  CounterModelInterface,
  CounterSemanticDigest,
} from "./CounterMirror.generated.js";

export interface CounterSuiteContext {
  /** A binary path or caller-supplied connection; the runner closes this transport. */
  readonly mirror: string | Transport;
  readonly modelConfig: ApalacheConfig;
  /** Paths are resolved by Mirrors, including when using a remote server. */
  readonly tracePaths: readonly string[];
  readonly signal?: AbortSignal;
  readonly deadlines?: Partial<ReplayDeadlines>;
}

/** The same approved fixture configuration for the source tests and CLI. */
export function counterReplayInputs(root: string): Pick<CounterSuiteContext, "modelConfig" | "tracePaths"> {
  return {
    modelConfig: {
      specPath: resolve(root, "examples/generated-counter/specs/Counter.tla"),
      invariant: "TraceComplete", lengthBound: 6, constInit: "CInit", paramVars: "parameters",
    },
    tracePaths: [resolve(root, "test/fixtures/model-interface/counter/counter.itf.json")],
  };
}

/** No implementation is constructed until Mirrors verifies the generated interface. */
export function runCounterSuite(
  context: CounterSuiteContext,
  implementationFactory: AsyncAdapterFactory,
): Promise<CompiledReplayReport> {
  const key = {
    semanticDigest: semanticDigestFromHex(CounterSemanticDigest),
    adapterId: "counter-mbt/v1",
    targetProfile: CounterAsyncTargetProfile,
    stateComputerContractVersion: CounterAsyncStateComputerContractVersion,
  };
  return runClientWithTracesNegotiatedWithReport(
    context.mirror, context.modelConfig, [...context.tracePaths],
    {
      execution: "async", mode: "compiled", request: "verify", policy: "require",
      metadata: CounterModelInterface, ...key,
      registry: new AsyncCompiledAdapterRegistry([{ key, factory: implementationFactory }]),
    },
    { signal: context.signal, deadlines: context.deadlines },
  );
}
