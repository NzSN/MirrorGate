import { createHash } from "node:crypto";
import type { ControlSession, Prepared, OutcomeSummary, CleanupResult } from "mirrorgate/control";
import {
  AsyncCompiledAdapterRegistry, normalizeReplayDeadlines, ReplayCancelledError,
  type AsyncAdapterFactory, type AsyncCompiledExecutionSelection, type ReplayDeadlines,
} from "mirrorecma";
import { prepareSandboxModel, type SandboxCompiledModel } from "./sandbox-model.js";
import {
  loadGateSdk, makeSelection, waitSucceeded, cleanupTag,
  type SandboxCleanupStatus, type SandboxEvaluationOptions,
} from "./sandbox.js";

/** Trusted, process-local ownership. These objects are never serializable run handles. */
export interface PreparedImplementationOptions {
  readonly session: ControlSession;
  readonly prepared: Prepared;
  readonly model: SandboxCompiledModel;
  readonly policyId: string;
  readonly runtime: "node-v1" | "rust-v1";
  readonly deadlines?: Partial<ReplayDeadlines>;
  readonly onDiagnostic?: SandboxEvaluationOptions["onDiagnostic"];
}

export interface ProviderCleanupReceipt {
  readonly status: SandboxCleanupStatus;
  readonly remainingResources: readonly string[];
  /** Trusted only: these errors are not an author-visible result projection. */
  readonly failures: readonly unknown[];
}

export interface PreparedImplementationProvider {
  /** Register this factory in an unchanged generic MBT suite's exact registry. */
  readonly factory: AsyncAdapterFactory;
  readonly selection: AsyncCompiledExecutionSelection;
  readonly identity: Readonly<Pick<Prepared,
    "preparedRevision" | "sourceHash" | "artifactId" | "artifactHash" | "manifestHash" | "runtime" | "policyId">>;
  /** Always join this cleanup, even when negotiation never invoked the factory. */
  close(summary?: OutcomeSummary): Promise<ProviderCleanupReceipt>;
}

/** Carries cleanup evidence when ownership was consumed but provider admission failed. */
export class PreparedImplementationError extends Error {
  constructor(readonly primary: unknown, readonly cleanup: ProviderCleanupReceipt) {
    let detail = "invalid prepared implementation";
    try { if (primary instanceof Error) detail = primary.message.slice(0, 4096); } catch { /* Arbitrary trusted rejection. */ }
    super(detail, {cause: primary});
    this.name = "PreparedImplementationError";
  }
}

/**
 * Consume an already prepared v1 session on its original owner connection.
 * Construction never authorizes or starts a worker. Hosting can prepare this
 * substrate independently; no v2 hosting fields are assumed here.
 * Ownership transfers on entry, including validation failures.
 */
export async function createPreparedImplementationProvider(
  options: PreparedImplementationOptions,
): Promise<PreparedImplementationProvider> {
  const session = options.session;
  const client = session.client;
  let deadlines = normalizeReplayDeadlines(undefined);
  const stopped = new AbortController();
  let closed = false;
  let used = false;
  let closing: Promise<ProviderCleanupReceipt> | undefined;
  const failures: unknown[] = [];
  const diagnosticFailures: unknown[] = [];
  const retainFailure = (error: unknown) => {
    if (failures.length < 32 && !failures.includes(error)) failures.push(error);
  };
  const disposers = new Set<() => Promise<void>>();
  const activeFactories = new Set<Promise<unknown>>();
  const assertActive = () => {
    if (closed) throw new ReplayCancelledError("prepared provider is closed");
  };
  const close = (summary: OutcomeSummary = { status: "failed" }): Promise<ProviderCleanupReceipt> => {
    if (closing !== undefined) return closing;
    closed = true;
    stopped.abort("prepared provider closed");
    closing = (async () => {
      let cleanup: CleanupResult | undefined;
      let clientClosed = false;
      for (const dispose of disposers) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([dispose(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("prepared binding disposal deadline exceeded")), deadlines.receiveMs);
          })]);
        } catch (error) { retainFailure(error); }
        finally { clearTimeout(timer); }
      }
      try {
        const operation = summary.status === "cancelled" || summary.status === "timedOut"
          ? await session.cancel(summary.status === "timedOut" ? "deadline" : "user-cancel", { timeoutMs: deadlines.receiveMs })
          : await session.close(summary, { timeoutMs: deadlines.receiveMs });
        cleanup = await waitSucceeded(operation, undefined, deadlines.receiveMs);
      } catch (error) { retainFailure(error); }
      try { await client.close(); clientClosed = true; } catch (error) { retainFailure(error); }
      // A trusted constructor may be delayed beyond Gate teardown. Its eventual
      // continuation still checks closed and disposes its binding; never await it
      // indefinitely or call a cancelled signal physical-cleanup confirmation.
      let factoriesJoined = activeFactories.size === 0;
      if (!factoriesJoined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        factoriesJoined = await Promise.race([
          Promise.allSettled([...activeFactories]).then(() => true),
          new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), deadlines.receiveMs); }),
        ]).finally(() => clearTimeout(timer));
      }
      if (!factoriesJoined) retainFailure(new Error("prepared provider factory cleanup deadline exceeded"));
      let status = cleanupTag(cleanup, clientClosed);
      if (status === "confirmed" && !factoriesJoined) status = "unconfirmed";
      if (status === "confirmed" && failures.length > 0) status = "failed";
      return Object.freeze({
        status,
        remainingResources: Object.freeze([...(cleanup?.remainingResources ?? [])]),
        failures: Object.freeze([...failures]),
      });
    })();
    return closing;
  };

  try {
    deadlines = normalizeReplayDeadlines(options.deadlines);
    const model = prepareSandboxModel(options.model);
    const sdk = await loadGateSdk();
    const prepared = Object.freeze({ ...options.prepared });
    const manifestHash = createHash("sha256").update("mirrorgate.public-manifest/v1")
      .update(Buffer.from([0])).update(model.manifestJson, "utf8").digest("hex");
    if (prepared.manifestHash !== manifestHash || prepared.runtime !== options.runtime ||
        prepared.policyId !== options.policyId || session.runtime !== options.runtime ||
        session.manifestJson !== model.manifestJson || prepared.artifactId.length === 0 ||
        !/^[0-9a-f]{64}$/.test(prepared.artifactHash) ||
        (prepared.sourceHash !== undefined && !/^[0-9a-f]{64}$/.test(prepared.sourceHash)) ||
        !Number.isSafeInteger(prepared.preparedRevision) || prepared.preparedRevision < 1 ||
        typeof prepared.challenge !== "string" || prepared.challenge.length === 0) {
      throw new Error("prepared implementation identity disagrees with its owning session/model");
    }
    const sdkManifest = sdk.createPublicManifest(model.model.descriptor, model.semanticDigest);
    const canonical = (value: unknown): string => JSON.stringify(value, function (_key, item) {
      return item !== null && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
    });
    if (canonical(sdkManifest) !== canonical(model.manifest)) {
      throw new Error("MirrorGate public manifest export disagrees with model preflight");
    }
    // This adapter narrows the public SDK to the legacy facade's protocol shape;
    // all operations still run through the existing owner and public SDK methods.
    const original = makeSelection(model, session as unknown as Parameters<typeof makeSelection>[1], prepared, sdk, deadlines,
      undefined, options.onDiagnostic, diagnosticFailures, assertActive, retainFailure);
    const key = {
      semanticDigest: model.semanticDigest,
      adapterId: original.adapterId,
      targetProfile: original.targetProfile,
      stateComputerContractVersion: original.stateComputerContractVersion,
    };
    const underlying = original.registry.resolve(key);
    const factory: AsyncAdapterFactory = (config, authority) => {
      assertActive();
      if (used) throw new Error("prepared implementation provider is single-use");
      used = true;
      const context = Object.freeze({ ...authority.context,
        signal: AbortSignal.any([authority.context.signal, stopped.signal]) });
      const pending = Promise.resolve().then(async () => {
        const binding = await underlying(config, Object.freeze({ ...authority, context }));
        let disposal: Promise<void> | undefined;
        const dispose = () => {
          disposal ??= Promise.resolve().then(() => binding.dispose());
          return disposal;
        };
        disposers.add(dispose);
        if (closed) {
          await dispose();
          assertActive();
        }
        return Object.freeze({ ...binding, dispose });
      });
      activeFactories.add(pending);
      pending.then(() => activeFactories.delete(pending), () => activeFactories.delete(pending));
      return pending;
    };
    const identity = {
      preparedRevision: prepared.preparedRevision,
      artifactId: prepared.artifactId, artifactHash: prepared.artifactHash,
      manifestHash: prepared.manifestHash, runtime: prepared.runtime, policyId: prepared.policyId,
      ...(prepared.sourceHash === undefined ? {} : { sourceHash: prepared.sourceHash }),
    };
    return Object.freeze({ factory,
      selection: Object.freeze({ ...original, registry: new AsyncCompiledAdapterRegistry([{ key, factory }]) }),
      identity: Object.freeze(identity), close });
  } catch (primary) {
    const cleanup = await close({ status: "failed" });
    throw new PreparedImplementationError(primary, cleanup);
  }
}
