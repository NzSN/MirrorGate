import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import type {
  ApalacheConfig,
  ApalacheSpec,
  Register,
  RegisterTraces,
  TraceGenerationConfig,
} from "mirrorecma";
import type { Transport } from "mirrorecma";
import {
  prepareSandboxModel,
  SandboxModelError,
  type PreparedSandboxModel,
  type SandboxCompiledModel,
  type SandboxNativePort,
  type SandboxPortableType,
  type SandboxPublicManifest,
  type SandboxReplayContext,
} from "./sandbox-model.js";
import {
  AsyncCompiledAdapterRegistry,
  ASYNC_STATE_COMPUTER_CONTRACT_VERSION,
  MIRRORECMA_ASYNC_TARGET_PROFILE,
  runClientNegotiatedWithReport,
  runClientWithTracesNegotiatedWithReport,
  type AsyncCompiledExecutionSelection,
} from "mirrorecma";
import type { AsyncAdapterFactory } from "mirrorecma";
type AsyncNegotiationAuthority = Parameters<AsyncAdapterFactory>[1];
import {
  normalizeReplayDeadlines,
  ReplayCancelledError,
  ReplayDeadlineError,
  type ReplayDeadlines,
} from "mirrorecma";
import {
  ReplayMismatchError,
  replayCleanupFailure,
  type CompiledReplayReport as ReplayReport,
} from "mirrorecma";
import { createVerifyRequest, encodeModelInterfaceRegistration } from "mirrorecma";

import { awaitAuthoringOperation } from "./authoring-wait.js";

const CONTROL_SPECIFIER = "mirrorgate/control";
const WORKER_SPECIFIER = "mirrorgate/worker";
const MAX_DIAGNOSTIC_BYTES = 65_535;
/** Maximum raw bytes retained from each authoring command output stream. */
export const SANDBOX_AUTHORING_OUTPUT_BYTES = 65_535;
const MAX_GATE_OUTPUT_CHUNK_BYTES = 16_384;
const MAX_RETAINED_SINK_FAILURES = 32;
const CATALOG_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const retainedSinkFailures = new WeakMap<object, readonly string[]>();

function retainSinkFailure(target: unknown[] | undefined, error: unknown): void {
  if (target !== undefined && target.length < MAX_RETAINED_SINK_FAILURES) target.push(error);
}

export type SandboxWorkerRuntime = "node-v1" | "rust-v1";

export interface TrustedGateLauncher {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export type SandboxGateEndpoint =
  | {
      readonly kind: "owned";
      readonly launcher: TrustedGateLauncher;
      readonly policyFile: string;
    }
  | {
      readonly kind: "attached";
      readonly socketPath: string;
      readonly expectedOwner: number;
    };

export interface SandboxInputRef {
  readonly rootId: string;
  readonly relativePath: string;
}

export type SandboxSubmission =
  | { readonly kind: "prebuilt"; readonly input: SandboxInputRef }
  | {
      readonly kind: "source";
      readonly input: SandboxInputRef;
      readonly buildPlanId: string;
      readonly authoring: boolean;
    };

export type SandboxReplayRequest =
  | {
      readonly kind: "generate";
      readonly target: string | Transport;
      readonly config: ApalacheConfig;
      readonly traceConfig: TraceGenerationConfig;
      readonly spec?: ApalacheSpec;
    }
  | {
      readonly kind: "traces";
      readonly target: string | Transport;
      readonly config: ApalacheConfig;
      readonly tracePaths: readonly string[];
    };

export interface SandboxTightenedLimits {
  readonly sessionWallMs?: number;
  readonly executionWallMs?: number;
  readonly commandCpuSeconds?: number;
  readonly addressSpaceBytes?: number;
  readonly uidProcesses?: number;
  readonly openFiles?: number;
  readonly fileBytes?: number;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly snapshotFiles?: number;
  readonly snapshotBytes?: number;
  readonly tmpBytes?: number;
  readonly scratchBytes?: number;
}

export interface SandboxAuthoringExecResult {
  readonly exitCode: number;
  /** Actual stdout byte count reported by Gate, including uncaptured bytes. */
  readonly stdoutBytes: number;
  /** Actual stderr byte count reported by Gate, including uncaptured bytes. */
  readonly stderrBytes: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface SandboxAuthoringSession {
  readonly publicManifest: SandboxPublicManifest;
  readonly files: Readonly<Record<string, string>>;
  exec(request: {
    readonly toolId: string;
    readonly arguments: readonly string[];
    readonly cwd?: string;
  }): Promise<SandboxAuthoringExecResult>;
}

export interface SandboxDisclosurePolicy {
  readonly mismatchDetails?: boolean;
  readonly failureMessages?: boolean;
}

export type SandboxCleanupStatus = "confirmed" | "failed" | "unconfirmed";

export type SandboxFailureFamily =
  | "configuration"
  | "controlCompatibility"
  | "preparation"
  | "build"
  | "modelNegotiation"
  | "backendAdmission"
  | "workerProtocol"
  | "application"
  | "cleanup";

export type PublicEvaluationResult =
  | { readonly status: "passed"; readonly runId: string; readonly cleanup: "confirmed" }
  | {
      readonly status: "mismatch";
      readonly runId: string;
      readonly cleanup: SandboxCleanupStatus;
      readonly details?: {
        readonly expected: unknown;
        readonly actual: unknown;
        readonly hints: readonly unknown[];
        readonly traceIndex: number;
        readonly stepIndex: number;
        readonly action: string;
      };
    }
  | {
      readonly status: "failed";
      readonly runId: string;
      readonly family: SandboxFailureFamily;
      readonly cleanup: SandboxCleanupStatus;
      readonly message?: string;
    }
  | { readonly status: "cancelled"; readonly runId: string; readonly cleanup: SandboxCleanupStatus }
  | { readonly status: "timedOut"; readonly runId: string; readonly cleanup: SandboxCleanupStatus };

export type TrustedSandboxDiagnostic =
  | {
      readonly kind: "failure";
      readonly stage: string;
      readonly family: SandboxFailureFamily;
      readonly summary: string;
      readonly detail?: string;
    }
  | {
      readonly kind: "lifecycle";
      readonly stage: "worker.operation.dispatched";
      readonly family: "application";
      readonly summary: string;
      readonly operationId: string;
    };

/** Trusted, process-local evidence that diagnostic delivery itself failed or timed out. */
export function sandboxDiagnosticFailures(result: PublicEvaluationResult): readonly string[] {
  return retainedSinkFailures.get(result) ?? Object.freeze([]);
}

export interface SandboxEvaluationPlan {
  readonly gate: SandboxGateEndpoint;
  readonly policyId: string;
  readonly submission: SandboxSubmission;
  readonly runtime: SandboxWorkerRuntime;
  readonly model: SandboxCompiledModel;
  readonly replay: SandboxReplayRequest;
  readonly deadlines?: Partial<ReplayDeadlines>;
  readonly limits?: SandboxTightenedLimits;
  readonly modelRevisionId?: string;
  readonly author?: (session: SandboxAuthoringSession) => void | Promise<void>;
  readonly disclosure?: SandboxDisclosurePolicy;
}

export interface SandboxEvaluationOptions {
  readonly signal?: AbortSignal;
  readonly onDiagnostic?: (diagnostic: TrustedSandboxDiagnostic) => void | Promise<void>;
}

interface GateOperationOutcome<T> {
  readonly operationId: number;
  readonly status: "pending" | "succeeded" | "failed";
  readonly result?: T;
  readonly error?: { readonly code: string; readonly stage: string; readonly message: string };
}

interface GateOperation<T> {
  readonly id?: number;
  wait(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<GateOperationOutcome<T>>;
}

interface GateAuthoringOutputEvent {
  readonly event: "authoring.output";
  readonly data: {
    readonly operationId: number;
    readonly stream: "stdout" | "stderr";
    readonly chunk: number;
    readonly bytesBase64: string;
  };
}

interface GatePrepared {
  readonly preparedRevision: number;
  readonly artifactId: string;
  readonly artifactHash: string;
  readonly manifestHash: string;
  readonly runtime: string;
  readonly policyId: string;
  readonly challenge: string;
}

interface GateCleanup {
  readonly phase: string;
  readonly cleanupStatus: string;
  readonly remainingResources: readonly string[];
}

interface GateWorker {
  invoke(id: string, inputs: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  observe(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

interface GateReservation {
  connect(options?: { timeoutMs?: number; cleanupTimeoutMs?: number }): Promise<GateWorker>;
  release(reason?: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<GateOperation<GateCleanup>>;
}

interface GateSession {
  authoringExec(
    request: { toolId: string; arguments: string[]; cwd?: string },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<GateOperation<{ exitCode: number; stdoutBytes: number; stderrBytes: number }>>;
  prepare(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<GateOperation<GatePrepared>>;
  authorize(
    request: { preparedRevision: number; challenge: string; attestation: Record<string, unknown> },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
  acquireWorker(authorization: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<GateReservation>;
  cancel(reason?: string, options?: { timeoutMs?: number }): Promise<GateOperation<GateCleanup>>;
  close(
    summary?: { status: string; failureFamily?: string },
    options?: { timeoutMs?: number },
  ): Promise<GateOperation<GateCleanup>>;
  onEvent?(
    listener: (event: unknown) => void,
    options?: { replay?: boolean },
  ): () => void;
}

interface GateClient {
  readonly hello: { readonly limits: { readonly teardownMs: number } };
  openSession(args: Record<string, unknown>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<GateSession>;
  close(): Promise<void>;
}

interface GateSdk {
  readonly ControlClient: {
    launch(options: Record<string, unknown>): Promise<GateClient>;
    connectUnix(options: Record<string, unknown>): Promise<GateClient>;
  };
  createPublicManifest(descriptor: unknown, digest: string): SandboxPublicManifest;
  toWorkerValue(type: SandboxPortableType, value: unknown): unknown;
  fromWorkerValue(type: SandboxPortableType, value: unknown): unknown;
}

interface SandboxDependencies {
  readonly loadGateSdk: () => Promise<GateSdk>;
}

class GateSdkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GateSdkError";
  }
}

class SandboxPortError extends Error {
  constructor(
    readonly family: "application" | "workerProtocol",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SandboxPortError";
  }
}

class GateOperationError extends Error {
  constructor(
    readonly code: string,
    readonly stage: string,
    message: string,
  ) {
    super(message);
    this.name = "GateOperationError";
  }
}

export async function loadGateSdk(): Promise<GateSdk> {
  try {
    const [control, worker] = await Promise.all([
      import(CONTROL_SPECIFIER),
      import(WORKER_SPECIFIER),
    ]);
    if (typeof control.ControlClient !== "function" ||
        typeof worker.createPublicManifest !== "function" ||
        typeof worker.toWorkerValue !== "function" ||
        typeof worker.fromWorkerValue !== "function") {
      throw new TypeError("required public MirrorGate SDK exports are unavailable");
    }
    return {
      ControlClient: control.ControlClient as GateSdk["ControlClient"],
      createPublicManifest: worker.createPublicManifest as GateSdk["createPublicManifest"],
      toWorkerValue: worker.toWorkerValue as GateSdk["toWorkerValue"],
      fromWorkerValue: worker.fromWorkerValue as GateSdk["fromWorkerValue"],
    };
  } catch (cause) {
    throw new GateSdkError(
      "the optional mirrorgate control/worker SDK is unavailable or incompatible",
      { cause },
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function snapshotPlan(plan: SandboxEvaluationPlan): SandboxEvaluationPlan {
  const gate = deepFreeze(plan.gate.kind === "owned"
    ? {
        kind: "owned" as const,
        launcher: {
          command: plan.gate.launcher.command,
          args: [...(plan.gate.launcher.args ?? [])],
          ...(plan.gate.launcher.cwd === undefined ? {} : { cwd: plan.gate.launcher.cwd }),
          ...(plan.gate.launcher.env === undefined ? {} : { env: { ...plan.gate.launcher.env } }),
        },
        policyFile: plan.gate.policyFile,
      }
    : { ...plan.gate });
  const replay = plan.replay.kind === "generate"
    ? Object.freeze({
        kind: "generate" as const,
        target: plan.replay.target,
        config: deepFreeze(structuredClone(plan.replay.config)),
        traceConfig: deepFreeze(structuredClone(plan.replay.traceConfig)),
        ...(plan.replay.spec === undefined ? {} : { spec: deepFreeze(structuredClone(plan.replay.spec)) }),
      })
    : Object.freeze({
        kind: "traces" as const,
        target: plan.replay.target,
        config: deepFreeze(structuredClone(plan.replay.config)),
        tracePaths: Object.freeze([...plan.replay.tracePaths]),
      });
  return Object.freeze({
    gate,
    policyId: plan.policyId,
    submission: deepFreeze(structuredClone(plan.submission)),
    runtime: plan.runtime,
    model: plan.model,
    replay,
    ...(plan.deadlines === undefined ? {} : { deadlines: Object.freeze({ ...plan.deadlines }) }),
    ...(plan.limits === undefined ? {} : { limits: Object.freeze({ ...plan.limits }) }),
    ...(plan.modelRevisionId === undefined ? {} : { modelRevisionId: plan.modelRevisionId }),
    ...(plan.author === undefined ? {} : { author: plan.author }),
    ...(plan.disclosure === undefined ? {} : { disclosure: Object.freeze({ ...plan.disclosure }) }),
  });
}

function preflightRegistration(plan: SandboxEvaluationPlan, prepared: PreparedSandboxModel): void {
  const request = createVerifyRequest(prepared.model.metadata, "require");
  if (plan.replay.kind === "generate") {
    const base: Register = {
      proto_step: "register",
      apalacheConfig: plan.replay.config,
      traceConfig: plan.replay.traceConfig,
      spec: plan.replay.spec,
    };
    encodeModelInterfaceRegistration(base, request);
  } else {
    const base: RegisterTraces = {
      proto_step: "register_traces",
      apalacheConfig: plan.replay.config,
      itfTracePaths: [...plan.replay.tracePaths],
    };
    encodeModelInterfaceRegistration(base, request);
  }
}

function requiredCapabilities(plan: SandboxEvaluationPlan): readonly string[] {
  return Object.freeze([
    plan.gate.kind === "owned" ? "control.local-stdio-v1" : "control.local-unix-v1",
    plan.submission.kind === "prebuilt" ? "submission.prebuilt-v1" : "submission.source-build-v1",
    ...(plan.author !== undefined || (plan.submission.kind === "source" && plan.submission.authoring)
      ? ["authoring.tools-v1"] : []),
    "execution.compiled-verify-v1",
    "worker.managed-unix-v1",
    `worker.${plan.runtime}`,
    "backend.linux-bubblewrap-v1",
    "cleanup.bounded-attempt-v1",
  ]);
}

function requireLocalPlan(plan: SandboxEvaluationPlan): void {
  const checkCatalogId = (value: string, label: string) => {
    if (!CATALOG_ID.test(value)) throw new SandboxModelError(`${label} is invalid`);
  };
  const checkInput = (input: SandboxInputRef) => {
    checkCatalogId(input.rootId, "submission root ID");
    if (input.relativePath.length === 0 || new TextEncoder().encode(input.relativePath).byteLength > 1_024 ||
        input.relativePath.includes("\0") || isAbsolute(input.relativePath) ||
        (input.relativePath !== "." && (normalize(input.relativePath) !== input.relativePath ||
          input.relativePath.split("/").some((part) => part === "" || part === "." || part === "..")))) {
      throw new SandboxModelError("submission relative path is invalid");
    }
  };
  checkCatalogId(plan.policyId, "policy ID");
  checkInput(plan.submission.input);
  if (plan.submission.kind === "source") checkCatalogId(plan.submission.buildPlanId, "build plan ID");
  if (plan.submission.kind === "source" && plan.author !== undefined && !plan.submission.authoring) {
    throw new SandboxModelError("author callback requires a source submission with authoring enabled");
  }
  if (plan.submission.kind === "prebuilt" && plan.author !== undefined) {
    throw new SandboxModelError("author callback is unavailable for a prebuilt submission");
  }
  if (plan.runtime !== "node-v1" && plan.runtime !== "rust-v1") {
    throw new SandboxModelError("sandbox runtime is unsupported");
  }
  for (const [name, value] of Object.entries(plan.limits ?? {})) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new SandboxModelError(`${name} must be a positive safe integer`);
    }
  }
  if (plan.modelRevisionId !== undefined &&
      (plan.modelRevisionId.length === 0 || plan.modelRevisionId.length > 128 ||
        !/^[\x20-\x7e]+$/.test(plan.modelRevisionId))) {
    throw new SandboxModelError("model revision ID must be nonempty printable ASCII within 128 bytes");
  }
  if (plan.gate.kind === "owned") {
    if (plan.gate.launcher.command.length === 0 || plan.gate.policyFile.length === 0) {
      throw new SandboxModelError("owned Gate command and policy file are required");
    }
  } else if (!isAbsolute(plan.gate.socketPath) || !Number.isSafeInteger(plan.gate.expectedOwner) ||
      plan.gate.expectedOwner < 0) {
    throw new SandboxModelError("attached Gate requires an absolute socket and expected owner UID");
  }
}

async function verifyExpectedOwner(endpoint: Extract<SandboxGateEndpoint, { kind: "attached" }>): Promise<void> {
  const currentOwner = process.getuid?.();
  if (currentOwner === undefined || currentOwner !== endpoint.expectedOwner) {
    throw new SandboxModelError("attached Gate expected owner does not match the evaluator UID");
  }
  let socket: Awaited<ReturnType<typeof lstat>>;
  let directory: Awaited<ReturnType<typeof lstat>>;
  try {
    [socket, directory] = await Promise.all([lstat(endpoint.socketPath), lstat(dirname(endpoint.socketPath))]);
  } catch (cause) {
    throw new GateSdkError("attached Gate socket is unavailable", { cause });
  }
  if (!socket.isSocket() || socket.uid !== endpoint.expectedOwner ||
      !directory.isDirectory() || directory.uid !== endpoint.expectedOwner) {
    throw new SandboxModelError("attached Gate socket ownership is invalid");
  }
}

/**
 * Only a known preallocation argument refusal or public-manifest preflight
 * rejection proves no session resource was allocated. Other replies do not:
 * the controller may have accepted session.open before its acknowledgement was
 * lost. Use actual public SDK error classes rather than a spoofable error name.
 */
export async function isDefinitiveSessionOpenFailure(error: unknown): Promise<boolean> {
  try {
    const control = await import(CONTROL_SPECIFIER);
    // POLICY_DENIED can follow partial backend allocation, and CANCELLED or
    // CLEANUP_FAILED can arrive while allocation cleanup is still running.
    // A correlated error alone therefore is not a cleanup receipt.
    const record = error as {code?: unknown; stage?: unknown};
    return (typeof control.ControlError === "function" && error instanceof control.ControlError &&
      record.code === "ARGUMENT_INVALID" && (record.stage === "policy" || record.stage === "bootstrap")) ||
      (typeof control.ControlProtocolError === "function" && error instanceof control.ControlProtocolError &&
        (error as {code?: unknown}).code === "CONTROL_ARGUMENT_INVALID");
  } catch { return false; }
}

export async function connectGate(
  plan: Pick<SandboxEvaluationPlan, "gate">,
  sdk: GateSdk,
  capabilities: readonly string[],
  controlVersion: 1 | 2 = 1,
): Promise<GateClient> {
  const common = { requiredCapabilities: [...capabilities], controlVersion };
  try {
    if (plan.gate.kind === "attached") {
      await verifyExpectedOwner(plan.gate);
      return await sdk.ControlClient.connectUnix({ ...common, socketPath: plan.gate.socketPath });
    }
    const launcher = plan.gate.launcher;
    return await sdk.ControlClient.launch({
      ...common,
      controller: {
        command: launcher.command,
        args: [
          ...(launcher.args ?? []),
          "control",
          "--stdio",
          "--policy-file",
          plan.gate.policyFile,
        ],
        ...(launcher.cwd === undefined ? {} : { cwd: launcher.cwd }),
        ...(launcher.env === undefined ? {} : { env: { ...launcher.env } }),
      },
    });
  } catch (cause) {
    const typed = cause as { code?: unknown; stage?: unknown; name?: unknown };
    if (typeof typed.code === "string" || typeof typed.stage === "string" ||
        typed.name === "ControlError" || typed.name === "ControlProtocolError" ||
        cause instanceof SandboxModelError || cause instanceof GateSdkError) {
      throw cause;
    }
    throw new GateSdkError("MirrorGate control connection failed", { cause });
  }
}

export async function waitSucceeded<T>(
  operation: GateOperation<T>,
  signal: AbortSignal | undefined,
  timeoutMs?: number,
): Promise<T> {
  const outcome = await operation.wait({ signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  if (outcome.status === "succeeded" && outcome.result !== undefined) return outcome.result;
  if (outcome.status === "failed" && outcome.error !== undefined) {
    throw new GateOperationError(outcome.error.code, outcome.error.stage, outcome.error.message);
  }
  throw new GateOperationError("OPERATION_UNKNOWN", "cleanup", "Gate operation did not reach a terminal result");
}

interface AuthoringStreamCapture {
  readonly retained: Uint8Array;
  retainedBytes: number;
  totalBytes: number;
  nextChunk: number;
}

function newAuthoringStreamCapture(): AuthoringStreamCapture {
  return {
    retained: new Uint8Array(SANDBOX_AUTHORING_OUTPUT_BYTES),
    retainedBytes: 0,
    totalBytes: 0,
    nextChunk: 1,
  };
}

function decodeAuthoringOutput(stream: AuthoringStreamCapture, truncated: boolean): string {
  const retained = stream.retained.subarray(0, stream.retainedBytes);
  const decoder = new TextDecoder("utf-8");
  // Streaming mode deliberately leaves an incomplete final code point buffered
  // when the byte cap splits one. Invalid bytes wholly inside the capture still
  // use the platform's normal replacement-character decoding.
  return decoder.decode(retained, truncated ? { stream: true } : undefined);
}

class AuthoringOutputCapture {
  readonly stdout = newAuthoringStreamCapture();
  readonly stderr = newAuthoringStreamCapture();
  operationId: number | undefined;
  failure: GateSdkError | undefined;

  receive(value: unknown): void {
    if (this.failure !== undefined || typeof value !== "object" || value === null ||
        (value as { event?: unknown }).event !== "authoring.output") return;
    try {
      const data = (value as { data?: unknown }).data;
      if (typeof data !== "object" || data === null) throw new TypeError("missing event data");
      const event = { event: "authoring.output", data } as GateAuthoringOutputEvent;
      const { operationId, stream, chunk, bytesBase64 } = event.data;
      if (!Number.isSafeInteger(operationId) || operationId <= 0 ||
          (stream !== "stdout" && stream !== "stderr") ||
          !Number.isSafeInteger(chunk) || chunk <= 0 || typeof bytesBase64 !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytesBase64)) {
        throw new TypeError("invalid output event fields");
      }
      if (this.operationId === undefined) this.operationId = operationId;
      if (this.operationId !== operationId) throw new TypeError("foreign authoring operation output");
      const target = stream === "stdout" ? this.stdout : this.stderr;
      if (chunk !== target.nextChunk) throw new TypeError("noncontiguous output chunks");
      if (target.nextChunk === Number.MAX_SAFE_INTEGER) throw new TypeError("too many output chunks");
      target.nextChunk += 1;
      const decoded = Buffer.from(bytesBase64, "base64");
      if (decoded.byteLength > MAX_GATE_OUTPUT_CHUNK_BYTES || decoded.toString("base64") !== bytesBase64) {
        throw new TypeError("invalid base64 output");
      }
      if (target.totalBytes > Number.MAX_SAFE_INTEGER - decoded.byteLength) {
        throw new TypeError("output byte count overflow");
      }
      target.totalBytes += decoded.byteLength;
      const available = SANDBOX_AUTHORING_OUTPUT_BYTES - target.retainedBytes;
      const retained = Math.min(available, decoded.byteLength);
      if (retained > 0) {
        target.retained.set(decoded.subarray(0, retained), target.retainedBytes);
        target.retainedBytes += retained;
      }
    } catch (cause) {
      this.failure = new GateSdkError("MirrorGate emitted invalid or foreign authoring output", { cause });
    }
  }

  bindOperation(operationId: unknown): void {
    if (!Number.isSafeInteger(operationId) || (operationId as number) <= 0) {
      throw new GateSdkError("MirrorGate authoring operation handle has no valid ID");
    }
    if (this.operationId !== undefined && this.operationId !== operationId) {
      throw new GateSdkError("MirrorGate authoring output operation ID does not match its handle");
    }
    this.operationId = operationId as number;
    if (this.failure !== undefined) throw this.failure;
  }

  result(
    receipt: { exitCode: number; stdoutBytes: number; stderrBytes: number },
    outputEventsAvailable: boolean,
  ): SandboxAuthoringExecResult {
    if (this.failure !== undefined) throw this.failure;
    if (!Number.isSafeInteger(receipt.exitCode) || !Number.isSafeInteger(receipt.stdoutBytes) ||
        receipt.stdoutBytes < 0 || !Number.isSafeInteger(receipt.stderrBytes) || receipt.stderrBytes < 0) {
      throw new GateSdkError("MirrorGate returned an invalid authoring command receipt");
    }
    if (!outputEventsAvailable) {
      if (receipt.stdoutBytes !== 0 || receipt.stderrBytes !== 0) {
        throw new GateSdkError("MirrorGate authoring output events are unavailable for nonempty output");
      }
    } else if (this.stdout.totalBytes !== receipt.stdoutBytes || this.stderr.totalBytes !== receipt.stderrBytes) {
      throw new GateSdkError("MirrorGate authoring output byte counts do not match its receipt");
    }
    const stdoutTruncated = receipt.stdoutBytes > this.stdout.retainedBytes;
    const stderrTruncated = receipt.stderrBytes > this.stderr.retainedBytes;
    return Object.freeze({
      exitCode: receipt.exitCode,
      stdoutBytes: receipt.stdoutBytes,
      stderrBytes: receipt.stderrBytes,
      stdout: decodeAuthoringOutput(this.stdout, stdoutTruncated),
      stderr: decodeAuthoringOutput(this.stderr, stderrTruncated),
      stdoutTruncated,
      stderrTruncated,
    });
  }
}

async function runAuthoringCommand(
  session: GateSession,
  request: Parameters<SandboxAuthoringSession["exec"]>[0],
  signal: AbortSignal | undefined,
  timeoutMs: number,
  setCurrentStop: (stop: (() => void) | undefined) => void,
): Promise<SandboxAuthoringExecResult> {
  const capture = new AuthoringOutputCapture();
  const subscribe = session.onEvent;
  if (subscribe !== undefined && typeof subscribe !== "function") {
    throw new GateSdkError("MirrorGate authoring event subscription is invalid");
  }
  const outputEventsAvailable = subscribe !== undefined;
  let unsubscribe: (() => void) | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      unsubscribe?.();
    } catch (cause) {
      capture.failure ??= new GateSdkError(
        "MirrorGate authoring event listener could not be removed",
        { cause },
      );
    }
  };
  let primary: unknown;
  let result: SandboxAuthoringExecResult | undefined;
  try {
    if (subscribe !== undefined) {
      unsubscribe = subscribe.call(session, (event) => capture.receive(event), { replay: false });
      if (typeof unsubscribe !== "function") {
        throw new GateSdkError("MirrorGate authoring event subscription is invalid");
      }
      setCurrentStop(stop);
    }
    const operation = await session.authoringExec({
      toolId: request.toolId,
      arguments: [...request.arguments],
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    }, { signal, timeoutMs });
    if (outputEventsAvailable) capture.bindOperation(operation.id);
    const receipt = await waitSucceeded(operation, signal, timeoutMs);
    result = capture.result(receipt, outputEventsAvailable);
  } catch (error) {
    primary = error;
  } finally {
    stop();
    if (primary === undefined && capture.failure !== undefined) primary = capture.failure;
    setCurrentStop(undefined);
  }
  if (primary !== undefined) throw primary;
  return result!;
}

function workerTimeout(context: SandboxReplayContext): number {
  return Math.max(1, Math.min(0x7fffffff, Math.ceil(context.deadline - performance.now())));
}

function throwIfPortContextInactive(context: SandboxReplayContext): void {
  if (context.signal.aborted) throw new ReplayCancelledError(context.signal.reason);
  if (performance.now() >= context.deadline) throw new ReplayDeadlineError("step", 0);
}

function throwIfFactoryInactive(authority: AsyncNegotiationAuthority): void {
  if (!authority.context.signal.aborted && performance.now() < authority.context.deadline) return;
  const reason = authority.context.signal.reason;
  if (reason instanceof Error) throw reason;
  throw new ReplayCancelledError(reason);
}

interface ClosableSandboxNativePort extends SandboxNativePort { close(): void }

function nativePort(
  worker: GateWorker,
  manifest: SandboxPublicManifest,
  sdk: GateSdk,
  diagnosticSink: SandboxEvaluationOptions["onDiagnostic"],
  retainedDiagnosticFailures: unknown[],
): ClosableSandboxNativePort {
  const operations = new Map(
    [...manifest.initializers, ...manifest.actions].map((item) => [item.id, item] as const),
  );
  let closed = false;
  return Object.freeze({
    async invoke(
      operationId: string,
      inputs: Readonly<Record<string, unknown>>,
      context: SandboxReplayContext,
    ): Promise<void> {
      if (closed) throw new Error("sandbox worker port is closed");
      throwIfPortContextInactive(context);
      const operation = operations.get(operationId);
      if (operation === undefined) throw new SandboxPortError("application", `undeclared sandbox operation ${operationId}`);
      const actual = Object.keys(inputs).sort();
      const expected = operation.inputs.map((input) => input.id).sort();
      if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
        throw new SandboxPortError("application", `sandbox inputs do not match ${operationId}`);
      }
      let encoded: Record<string, unknown>;
      try {
        encoded = Object.fromEntries(operation.inputs.map((input) => [
          input.id,
          sdk.toWorkerValue(input.type, inputs[input.id]),
        ]));
      } catch (cause) {
        throw new SandboxPortError("application", `sandbox input conversion failed for ${operationId}`, { cause });
      }
      const pending = worker.invoke(operationId, encoded, {
        signal: context.signal,
        timeoutMs: workerTimeout(context),
      });
      pending.catch(() => {});
      await emitLifecycle(diagnosticSink, operationId, retainedDiagnosticFailures);
      throwIfPortContextInactive(context);
      await pending;
      throwIfPortContextInactive(context);
    },
    async observe(context: SandboxReplayContext): Promise<Readonly<Record<string, unknown>>> {
      if (closed) throw new Error("sandbox worker port is closed");
      throwIfPortContextInactive(context);
      const received = await worker.observe({
        signal: context.signal,
        timeoutMs: workerTimeout(context),
      });
      throwIfPortContextInactive(context);
      const expected = manifest.observations.map((item) => item.id).sort();
      const actual = Object.keys(received).sort();
      if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
        throw new SandboxPortError("workerProtocol", "sandbox observations do not match the public manifest");
      }
      try {
        return Object.freeze(Object.fromEntries(manifest.observations.map((item) => [
          item.id,
          sdk.fromWorkerValue(item.type, received[item.id]),
        ])));
      } catch (cause) {
        throw new SandboxPortError("workerProtocol", "sandbox observation conversion failed", { cause });
      }
    },
    close(): void { closed = true; },
  });
}

function attestation(authority: AsyncNegotiationAuthority): Record<string, unknown> {
  return Object.freeze({
    registrationId: authority.registrationId,
    request: authority.request,
    policy: authority.policy,
    status: authority.status,
    descriptorSchema: authority.descriptorSchema,
    semanticDigest: authority.semanticDigest,
    adapterId: authority.adapterId,
    targetProfile: authority.targetProfile,
    stateComputerContractVersion: authority.stateComputerContractVersion,
  });
}

export function makeSelection(
  prepared: PreparedSandboxModel,
  session: GateSession,
  gatePrepared: GatePrepared,
  sdk: GateSdk,
  deadlines: ReplayDeadlines,
  signal: AbortSignal | undefined,
  diagnosticSink: SandboxEvaluationOptions["onDiagnostic"],
  retainedDiagnosticFailures: unknown[],
  assertActive: () => void = () => {},
  onCleanupFailure: (error: unknown) => void = () => {},
): AsyncCompiledExecutionSelection {
  const key = Object.freeze({
    semanticDigest: prepared.semanticDigest,
    adapterId: prepared.model.adapterId,
    targetProfile: MIRRORECMA_ASYNC_TARGET_PROFILE,
    stateComputerContractVersion: ASYNC_STATE_COMPUTER_CONTRACT_VERSION,
  });
  const registry = new AsyncCompiledAdapterRegistry([{
    key,
    factory: async (config, authority) => {
      assertActive();
      throwIfFactoryInactive(authority);
      const authorization = await session.authorize({
        preparedRevision: gatePrepared.preparedRevision,
        challenge: gatePrepared.challenge,
        attestation: attestation(authority),
      }, { signal: authority.context.signal, timeoutMs: workerTimeout(authority.context) });
      assertActive();
      throwIfFactoryInactive(authority);
      let reservation: GateReservation | undefined;
      let worker: GateWorker | undefined;
      let port: ClosableSandboxNativePort | undefined;
      let binding: Awaited<ReturnType<SandboxCompiledModel["createBinding"]>> | undefined;
      let disposal: Promise<void> | undefined;
      try {
        reservation = await session.acquireWorker(authorization, {
          signal: authority.context.signal,
          timeoutMs: workerTimeout(authority.context),
        });
        assertActive();
        throwIfFactoryInactive(authority);
        worker = await reservation.connect({
          timeoutMs: workerTimeout(authority.context),
          cleanupTimeoutMs: deadlines.receiveMs,
        });
        assertActive();
        throwIfFactoryInactive(authority);
        port = nativePort(
          worker,
          prepared.manifest,
          sdk,
          diagnosticSink,
          retainedDiagnosticFailures,
        );
        binding = await prepared.model.createBinding(port, config);
        assertActive();
        throwIfFactoryInactive(authority);
        return Object.freeze({
          semanticDigest: binding.semanticDigest,
          computer: binding.computer,
          assertCompatibleConfig: binding.assertCompatibleConfig.bind(binding),
          ...(binding.coverage === undefined ? {} : { coverage: binding.coverage.bind(binding) }),
          dispose: () => {
            if (disposal !== undefined) return disposal;
            disposal = (async () => {
              port!.close();
              let failed = false;
              let primary: unknown;
              try { await binding!.dispose(); } catch (error) {
                failed = true; primary = error; onCleanupFailure(error);
              }
              try { await worker!.close(); } catch (error) {
                if (!failed) primary = error;
                failed = true; onCleanupFailure(error);
              }
              if (failed) throw primary;
            })();
            return disposal;
          },
        });
      } catch (error) {
        // Invalidate any proxy captured by a constructor that failed part-way.
        // It cannot issue calls while Gate joins the worker/session cleanup.
        port?.close();
        if (binding !== undefined) {
          try { await binding.dispose(); } catch (failure) { onCleanupFailure(failure); }
        }
        if (worker !== undefined) {
          try { await worker.close(); } catch (failure) { onCleanupFailure(failure); }
        } else if (reservation !== undefined) {
          try {
            await waitSucceeded(await reservation.release("client-failure"), undefined, deadlines.receiveMs);
          } catch (failure) { onCleanupFailure(failure); }
        }
        throw error;
      }
    },
  }]);
  return Object.freeze({
    execution: "async" as const,
    mode: "compiled" as const,
    request: "verify" as const,
    policy: "require" as const,
    metadata: prepared.model.metadata,
    adapterId: key.adapterId,
    targetProfile: key.targetProfile,
    stateComputerContractVersion: key.stateComputerContractVersion,
    registry,
  });
}

export function errorFamily(error: unknown): SandboxFailureFamily {
  let current: unknown = error;
  const visited = new Set<unknown>();
  let fallback: SandboxFailureFamily = "application";
  for (let depth = 0; depth < 10 && current !== undefined && !visited.has(current); depth += 1) {
    visited.add(current);
    if (current instanceof GateSdkError) return "controlCompatibility";
    if (current instanceof SandboxPortError) return current.family;
    if (current instanceof SandboxModelError) {
      return "configuration";
    }
    const record = current as { name?: unknown; code?: unknown; stage?: unknown; cause?: unknown };
    const code = typeof record.code === "string" ? record.code : "";
    const stage = typeof record.stage === "string" ? record.stage : "";
    if (code === "configuration_mismatch" || code === "context_mismatch") return "configuration";
    if (["adapter_failure", "observation_shape_mismatch", "input_shape_mismatch",
      "unknown_action", "transition_before_initialization", "reentrant_call", "binding_poisoned"].includes(code)) {
      return "application";
    }
    if (code === "adapter_dispose_failed" || stage === "close") return "cleanup";
    if (code === "CAPABILITY_UNAVAILABLE" || code === "POLICY_DENIED") return "backendAdmission";
    if (code === "BUILD_FAILED" || stage === "build") return "build";
    if (code === "PREPARATION_FAILED" || stage === "prepare") return "preparation";
    if (code === "BACKEND_ADMISSION_FAILED" || stage === "authorize") return "backendAdmission";
    if (stage === "worker" || stage === "attach" || code === "WORKER_PROTOCOL_FAILED") return "workerProtocol";
    if (stage === "bootstrap" || code === "VERSION_UNSUPPORTED" ||
        record.name === "ControlError" || record.name === "ControlProtocolError") {
      return "controlCompatibility";
    }
    if (record.name === "NegotiatedRunnerError" || record.name === "ModelInterfaceRegistrationError") {
      fallback = "modelNegotiation";
    } else if (record.name === "ProtocolError") {
      fallback = ["SCHEMA", "HANDSHAKE", "CLOSED", "FRAME", "LIMIT"].includes(code)
        ? "workerProtocol"
        : "application";
    }
    current = record.cause;
  }
  return fallback;
}

function chainHas(error: unknown, predicate: (value: { name?: unknown; code?: unknown; stage?: unknown }) => boolean): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 10 && current !== undefined && !visited.has(current); depth += 1) {
    visited.add(current);
    if (current instanceof Error && predicate(current)) return true;
    current = (current as { cause?: unknown })?.cause;
  }
  return false;
}

export function isCancelled(error: unknown): boolean {
  return chainHas(error, (item) => item.name === "AbortError" || item.name === "ReplayCancelledError" ||
    item.code === "CANCELLED" || item.code === "CONTROL_WAIT_CANCELLED" ||
    item.code === "CONTROL_REQUEST_CANCELLED" || item.code === "operation_cancelled");
}

export function isTimedOut(error: unknown): boolean {
  return chainHas(error, (item) => (item.name === "ReplayDeadlineError" && item.stage !== "close") ||
    item.code === "DEADLINE_EXCEEDED" || item.code === "TIMEOUT" || item.code === "CONTROL_WAIT_TIMEOUT" ||
    item.code === "CONTROL_REQUEST_TIMEOUT" || item.code === "CONTROL_HANDSHAKE_TIMEOUT" ||
    item.code === "CONTROL_CONNECT_TIMEOUT" || item.code === "deadline_exceeded");
}

function diagnosticDetail(error: unknown): string | undefined {
  if (!(error instanceof ReplayMismatchError)) return undefined;
  let detail: string;
  try {
    detail = JSON.stringify({
      expected: error.expected,
      actual: error.actual,
      hints: error.hints,
      traceIndex: error.traceIndex,
      stepIndex: error.stepIndex,
      action: error.action,
    }, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  } catch {
    detail = "mismatch details could not be encoded";
  }
  return truncateUtf8(detail, MAX_DIAGNOSTIC_BYTES);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  const suffix = "…";
  const suffixBytes = encoder.encode(suffix).byteLength;
  let end = maxBytes - suffixBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return `${decoder.decode(encoded.subarray(0, end))}${suffix}`;
    } catch {
      end -= 1;
    }
  }
  return suffix;
}

async function emitDiagnostic(
  sink: SandboxEvaluationOptions["onDiagnostic"],
  stage: string,
  family: SandboxFailureFamily,
  error: unknown,
  retainedFailures?: unknown[],
): Promise<void> {
  if (sink === undefined) return;
  const summary = error instanceof Error ? error.message.slice(0, 4_096) : "sandbox evaluation failed";
  try {
    const operation = Promise.resolve(sink(Object.freeze({
      kind: "failure" as const,
      stage,
      family,
      summary,
      ...(diagnosticDetail(error) === undefined ? {} : { detail: diagnosticDetail(error) }),
    })));
    operation.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      operation,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("diagnostic sink deadline exceeded")), 1_000);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (sinkError) {
    retainSinkFailure(retainedFailures, sinkError);
  }
}

async function emitLifecycle(
  sink: SandboxEvaluationOptions["onDiagnostic"],
  operationId: string,
  retainedFailures: unknown[],
): Promise<void> {
  if (sink === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = Promise.resolve(sink(Object.freeze({
      kind: "lifecycle" as const,
      stage: "worker.operation.dispatched" as const,
      family: "application" as const,
      summary: `public worker operation dispatched: ${operationId}`,
      operationId,
    })));
    operation.catch(() => {});
    await Promise.race([
      operation,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("diagnostic sink deadline exceeded")), 1_000);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (error) {
    retainSinkFailure(retainedFailures, error);
  }
}

export function cleanupTag(cleanup: GateCleanup | undefined, clientClosed: boolean): SandboxCleanupStatus {
  if (!clientClosed) return "unconfirmed";
  if (cleanup?.cleanupStatus === "succeeded" && cleanup.phase === "closed" &&
      cleanup.remainingResources.length === 0) return "confirmed";
  return cleanup === undefined ? "unconfirmed" : "failed";
}

function publicResult(
  runId: string,
  primary: unknown,
  report: ReplayReport | undefined,
  cleanup: SandboxCleanupStatus,
  disclosure: SandboxDisclosurePolicy,
): PublicEvaluationResult {
  if (primary === undefined && report !== undefined) {
    if (cleanup === "confirmed") return Object.freeze({ status: "passed", runId, cleanup: "confirmed" });
    return Object.freeze({ status: "failed", runId, family: "cleanup", cleanup });
  }
  if (primary instanceof ReplayMismatchError) {
    return Object.freeze({
      status: "mismatch",
      runId,
      cleanup,
      ...(disclosure.mismatchDetails ? {
        details: deepFreeze(structuredClone({
          expected: primary.expected,
          actual: primary.actual,
          hints: primary.hints,
          traceIndex: primary.traceIndex,
          stepIndex: primary.stepIndex,
          action: primary.action,
        })),
      } : {}),
    });
  }
  if (isCancelled(primary)) {
    return Object.freeze({ status: "cancelled", runId, cleanup });
  }
  if (isTimedOut(primary)) {
    return Object.freeze({ status: "timedOut", runId, cleanup });
  }
  const family = errorFamily(primary);
  return Object.freeze({
    status: "failed",
    runId,
    family,
    cleanup,
    ...(disclosure.failureMessages && primary instanceof Error ? { message: primary.message.slice(0, 4_096) } : {}),
  });
}

/** Execute one prepared submission through MirrorGate and required Mirrors negotiation. */
export async function evaluateSandboxed(
  plan: SandboxEvaluationPlan,
  options: SandboxEvaluationOptions = {},
): Promise<PublicEvaluationResult> {
  return evaluateSandboxedWithDependencies(plan, options, { loadGateSdk });
}

/** Deep test seam; intentionally omitted from the package root exports. */
export async function evaluateSandboxedWithDependencies(
  plan: SandboxEvaluationPlan,
  options: SandboxEvaluationOptions,
  dependencies: SandboxDependencies,
): Promise<PublicEvaluationResult> {
  const runId = randomUUID();
  const signal = options.signal;
  const diagnosticSink = options.onDiagnostic;
  const retainedDiagnosticFailures: unknown[] = [];
  let disclosure: SandboxDisclosurePolicy = Object.freeze({ ...(plan.disclosure ?? {}) });
  let prepared: PreparedSandboxModel;
  let deadlines: ReplayDeadlines;
  try {
    if (signal?.aborted) {
      return Object.freeze({ status: "cancelled", runId, cleanup: "confirmed" });
    }
    plan = snapshotPlan(plan);
    disclosure = plan.disclosure ?? Object.freeze({});
    requireLocalPlan(plan);
    deadlines = normalizeReplayDeadlines(plan.deadlines);
    prepared = prepareSandboxModel(plan.model);
    preflightRegistration(plan, prepared);
  } catch (error) {
    const configurationError = error instanceof SandboxModelError
      ? error
      : new SandboxModelError("sandbox plan preflight failed", { cause: error });
    await emitDiagnostic(diagnosticSink, "preflight", "configuration", configurationError, retainedDiagnosticFailures);
    const result = publicResult(runId, configurationError, undefined, "confirmed", disclosure);
    if (retainedDiagnosticFailures.length > 0) {
      retainedSinkFailures.set(result, Object.freeze(retainedDiagnosticFailures.map((failure) =>
        (failure instanceof Error ? failure.message : "diagnostic sink failed").slice(0, 4_096))));
    }
    return result;
  }

  let client: GateClient | undefined;
  let session: GateSession | undefined;
  let report: ReplayReport | undefined;
  let primary: unknown;
  let cleanup: GateCleanup | undefined;
  let clientClosed = false;
  let sessionOpenUnconfirmed = false;
  try {
    const sdk = await dependencies.loadGateSdk();
    if (signal?.aborted) throw new ReplayCancelledError(signal.reason);
    const sdkManifest = sdk.createPublicManifest(prepared.model.descriptor, prepared.semanticDigest);
    if (canonicalJson(sdkManifest) !== canonicalJson(prepared.manifest)) {
      throw new SandboxModelError("MirrorGate public manifest export disagrees with local preflight");
    }
    client = await connectGate(plan, sdk, requiredCapabilities(plan));
    sessionOpenUnconfirmed = true;
    try {
      session = await client.openSession({
        policyId: plan.policyId,
        submission: plan.submission,
        runtime: plan.runtime,
        manifestJson: prepared.manifestJson,
        ...(plan.limits === undefined ? {} : { limits: { ...plan.limits } }),
        ...(plan.modelRevisionId === undefined ? {} : { modelRevisionId: plan.modelRevisionId }),
      }, { signal, timeoutMs: deadlines.registrationMs });
      sessionOpenUnconfirmed = false;
    } catch (error) {
      if (await isDefinitiveSessionOpenFailure(error)) sessionOpenUnconfirmed = false;
      throw error;
    }

    if (plan.author !== undefined) {
      let active = true;
      let execInFlight = false;
      let stopCurrentExec: (() => void) | undefined;
      const files = prepared.model.authoringBundle?.files ?? Object.freeze({});
      const authorSession: SandboxAuthoringSession = Object.freeze({
        publicManifest: prepared.manifest,
        files,
        exec: async (request: Parameters<SandboxAuthoringSession["exec"]>[0]) => {
          if (!active) throw new SandboxModelError("authoring session is sealed");
          if (execInFlight) throw new SandboxModelError("only one authoring command may run at a time");
          execInFlight = true;
          const pending = runAuthoringCommand(
            session!,
            request,
            signal,
            deadlines.registrationMs,
            (stop) => { stopCurrentExec = stop; },
          );
          // A callback may accidentally discard the returned promise. Keep its
          // rejection observed while the outer lifecycle seals and closes Gate.
          pending.catch(() => {});
          try {
            return await pending;
          } finally {
            execInFlight = false;
          }
        },
      });
      const pendingAuthor = Promise.resolve().then(() => plan.author!(authorSession));
      pendingAuthor.catch(() => {});
      try {
        await awaitAuthoringOperation(pendingAuthor, signal, deadlines.registrationMs);
        if (execInFlight) {
          throw new SandboxModelError("author callback returned before its authoring command completed");
        }
      } finally {
        active = false;
        stopCurrentExec?.();
        stopCurrentExec = undefined;
      }
    }

    const gatePrepared = await waitSucceeded(
      await session.prepare({ signal, timeoutMs: deadlines.registrationMs }),
      signal,
    );
    const expectedManifestHash = createHash("sha256")
      .update("mirrorgate.public-manifest/v1")
      .update(Buffer.from([0]))
      .update(prepared.manifestJson, "utf8")
      .digest("hex");
    if (gatePrepared.manifestHash !== expectedManifestHash || gatePrepared.runtime !== plan.runtime ||
        gatePrepared.policyId !== plan.policyId || gatePrepared.artifactId.length === 0 ||
        !/^[0-9a-f]{64}$/.test(gatePrepared.artifactHash)) {
      throw new GateOperationError(
        "PREPARATION_FAILED",
        "prepare",
        "Gate prepared identities do not match the frozen evaluation plan",
      );
    }
    const selection = makeSelection(
      prepared,
      session,
      gatePrepared,
      sdk,
      deadlines,
      signal,
      diagnosticSink,
      retainedDiagnosticFailures,
    );
    if (plan.replay.kind === "generate") {
      report = await runClientNegotiatedWithReport(
        plan.replay.target,
        plan.replay.config,
        plan.replay.traceConfig,
        selection,
        {
          ...(plan.replay.spec === undefined ? {} : { spec: plan.replay.spec }),
          signal,
          deadlines,
        },
      );
    } else {
      report = await runClientWithTracesNegotiatedWithReport(
        plan.replay.target,
        plan.replay.config,
        [...plan.replay.tracePaths],
        selection,
        { signal, deadlines },
      );
    }
  } catch (error) {
    primary = error;
    await emitDiagnostic(diagnosticSink, "evaluate", errorFamily(error), error, retainedDiagnosticFailures);
  }

  if (session !== undefined) {
    const summary = primary instanceof ReplayMismatchError
      ? { status: "mismatch" }
      : isTimedOut(primary)
        ? { status: "timedOut" }
        : isCancelled(primary)
          ? { status: "cancelled" }
          : primary === undefined
            ? { status: "passed" }
            : { status: "failed", failureFamily: errorFamily(primary) };
    try {
      const operation = summary.status === "cancelled" || summary.status === "timedOut"
        ? await session.cancel(summary.status === "timedOut" ? "deadline" : "user-cancel", {
            timeoutMs: deadlines.receiveMs,
          })
        : await session.close(summary, { timeoutMs: deadlines.receiveMs });
      cleanup = await waitSucceeded(operation, undefined, deadlines.receiveMs);
    } catch (error) {
      await emitDiagnostic(diagnosticSink, "cleanup", "cleanup", error, retainedDiagnosticFailures);
    }
  }
  if (client !== undefined) {
    try {
      await client.close();
      clientClosed = true;
    } catch (error) {
      await emitDiagnostic(diagnosticSink, "cleanup", "cleanup", error, retainedDiagnosticFailures);
    }
  } else {
    clientClosed = true;
  }
  let cleanupStatus = session === undefined
    ? (sessionOpenUnconfirmed ? "unconfirmed" as const
      : client === undefined || clientClosed ? "confirmed" as const : "unconfirmed" as const)
    : cleanupTag(cleanup, clientClosed);
  if (primary !== undefined &&
      (replayCleanupFailure(primary) !== undefined || errorFamily(primary) === "cleanup") &&
      cleanupStatus === "confirmed") {
    cleanupStatus = "failed";
  }
  const result = publicResult(
    runId,
    primary,
    report,
    cleanupStatus,
    disclosure,
  );
  if (retainedDiagnosticFailures.length > 0) {
    retainedSinkFailures.set(result, Object.freeze(retainedDiagnosticFailures.map((error) =>
      (error instanceof Error ? error.message : "diagnostic sink failed").slice(0, 4_096))));
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
