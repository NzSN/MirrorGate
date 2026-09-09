import type {PublicManifest, StreamReadable, StreamWritable, WorkerClient, WorkerClientOptions} from './worker.d.mts';

export declare const CONTROL_LIMITS: Readonly<{
  frameBytes: number;
  jsonDepth: number;
  jsonNodes: number;
  pendingOutputBytes: number;
  inflightRequests: number;
  errorMessageBytes: number;
  outputChunkBytes: number;
  attachmentFrameBytes: number;
}>;

export type ControlErrorCode =
  | 'VERSION_UNSUPPORTED' | 'CAPABILITY_UNAVAILABLE' | 'ARGUMENT_INVALID'
  | 'POLICY_DENIED' | 'HANDLE_INVALID' | 'STATE_INVALID' | 'LIMIT_EXCEEDED'
  | 'PREPARATION_FAILED' | 'BUILD_FAILED' | 'NEGOTIATION_ATTESTATION_INVALID'
  | 'BACKEND_ADMISSION_FAILED' | 'ATTACHMENT_FAILED' | 'WORKER_PROTOCOL_FAILED'
  | 'WORKER_EXITED' | 'CANCELLED' | 'DEADLINE_EXCEEDED' | 'CLEANUP_FAILED'
  | 'OPERATION_UNKNOWN' | 'AGENT_START_FAILED' | 'AGENT_EXITED' | 'AUDIT_UNAVAILABLE';

export type ControlErrorStage = 'bootstrap' | 'policy' | 'authoring' | 'prepare' | 'build' | 'authorize' | 'attach' | 'worker' | 'cleanup' | 'hosting';
export type CleanupReason = 'normal' | 'user-cancel' | 'deadline' | 'client-failure' | 'worker-failure';
export type CleanupMode = 'dispose-then-terminate' | 'terminate-only';
export type SessionPhase = 'open' | 'authoring' | 'submitted' | 'preparing' | 'prepared' | 'authorized' | 'reserved' | 'starting' | 'running' | 'closing' | 'closed' | 'cleanupFailed';
export type CleanupStatus = 'notStarted' | 'pending' | 'succeeded' | 'failed';

export class ControlProtocolError extends Error {
  readonly code: string;
}

export class ControlError extends Error {
  readonly code: ControlErrorCode;
  readonly stage: ControlErrorStage;
  readonly operationId?: number;
  constructor(error: {code: ControlErrorCode; stage: ControlErrorStage; message: string; operationId?: number});
}

export interface Capability {
  id: string;
  available: boolean;
  enforcedScope: 'connection' | 'session' | 'command' | 'process' | 'host-uid' | 'host' | 'none';
  limits: Record<string, number>;
  reason?: string;
}

export interface HelloLimits {
  maxFrameBytes: number;
  maxJsonDepth: number;
  maxJsonNodes: number;
  maxPendingOutputBytes: number;
  maxSessionsPerConnection: number;
  maxInflightRequestsPerConnection: number;
  maxCompletedOperationsPerSession: number;
  helloTimeoutMs: number;
  requestAckTimeoutMs: number;
  workerAttachmentTimeoutMs: number;
  sessionWallMs: number;
  gracefulStopMs: number;
  teardownMs: number;
}

export interface ControlHello {
  controlVersion: 1 | 2;
  instanceId: string;
  capabilities: Capability[];
  limits: HelloLimits;
}

export interface InputRef {rootId: string; relativePath: string}
export type Submission =
  | {kind: 'prebuilt'; input: InputRef}
  | {kind: 'source'; input: InputRef; buildPlanId: string; authoring: boolean};

export interface TightenedLimits {
  sessionWallMs?: number;
  executionWallMs?: number;
  commandCpuSeconds?: number;
  addressSpaceBytes?: number;
  uidProcesses?: number;
  openFiles?: number;
  fileBytes?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  snapshotFiles?: number;
  snapshotBytes?: number;
  tmpBytes?: number;
  scratchBytes?: number;
}

export interface OpenSessionOptions {
  policyId: string;
  submission: Submission;
  runtime: string;
  /** Exact public-manifest bytes represented as a JavaScript string. */
  manifestJson: string;
  limits?: TightenedLimits;
  modelRevisionId?: string;
}

export interface RequiredMatchAttestation {
  registrationId: string;
  request: 'verify';
  policy: 'require';
  status: 'matched';
  descriptorSchema: 'mirrors.model-interface-descriptor/v1';
  semanticDigest: string;
  adapterId: string;
  targetProfile: string;
  stateComputerContractVersion: string;
}

export interface CommandResult {exitCode: number; stdoutBytes: number; stderrBytes: number}
export interface Prepared {
  preparedRevision: number;
  artifactId: string;
  artifactHash: string;
  sourceHash?: string;
  manifestHash: string;
  runtime: string;
  policyId: string;
  challenge: string;
}
export interface CleanupResult {phase: SessionPhase; cleanupStatus: CleanupStatus; remainingResources: string[]}
export interface SessionStatus {
  phase: SessionPhase;
  resources: {authoringProcesses: number; buildProcesses: number; workers: number; snapshots: number};
  cleanup: {status: CleanupStatus; remainingResources: string[]};
}
export interface OutcomeSummary {
  status: 'passed' | 'mismatch' | 'failed' | 'cancelled' | 'timedOut';
  failureFamily?: string;
}

export type OperationOutcome<T> =
  | {operationId: number; status: 'pending'}
  | {operationId: number; status: 'succeeded'; result: T}
  | {operationId: number; status: 'failed'; error: {code: ControlErrorCode; stage: ControlErrorStage; message: string; operationId?: number}};

export interface ControlRequestOptions {signal?: AbortSignal; timeoutMs?: number}
export interface ControlWaitOptions {signal?: AbortSignal; timeoutMs?: number}

export interface PublicTask {readonly instructions: string; readonly files: readonly {readonly path: string; readonly text: string}[]}
export interface HostingLimits {
  wallMs: number; stdoutBytes: number; stderrBytes: number;
  progressRecords: number; progressBytes: number; progressRecordBytes: number;
}
export interface HostedRun {
  runId: string;
  phase: 'starting' | 'running' | 'submitting' | 'cleaning' | 'finished';
  cleanup: {status: CleanupStatus; remainingResources: string[]};
  limits: HostingLimits;
  progress: {firstSeq: number; nextSeq: number; truncated: boolean; records: {seq: number; message: string}[]};
  outcome?: 'submitted' | 'failed' | 'cancelled' | 'timedOut';
  submission?: {submissionId: string; sourceHash: string; sourceRevision: 1};
  error?: {code: ControlErrorCode; stage: ControlErrorStage; message: string; operationId?: number};
}
export interface StartAgentOptions {profileId: string; publicTask: PublicTask; limits?: Partial<HostingLimits>}
export class HostedAgentRun {
  private constructor();
  readonly session: ControlSession;
  readonly id: string;
  readonly latest: Readonly<HostedRun> | null;
  status(options?: ControlRequestOptions): Promise<Readonly<HostedRun>>;
  /** Joins bounded hosting cleanup; acknowledgement timeout is at least 7 seconds. */
  cancel(reason?: CleanupReason, options?: ControlRequestOptions): Promise<Readonly<HostedRun>>;
  /** Stops waiting on cancellation; use cancel() to cancel the hosted run. */
  wait(options?: ControlWaitOptions & {pollMs?: number}): Promise<Readonly<HostedRun>>;
}

export class OperationHandle<T> {
  private constructor();
  readonly session: ControlSession;
  readonly id: number;
  readonly cleanupMode?: CleanupMode;
  status(options?: ControlRequestOptions): Promise<OperationOutcome<T>>;
  wait(options?: ControlWaitOptions): Promise<Exclude<OperationOutcome<T>, {status: 'pending'}>>;
}

export class AuthorizationHandle {
  private constructor();
  readonly session: ControlSession;
  readonly id: string;
}

export interface WorkerEndpoint {kind: 'unix'; path: string}
export interface ManagedWorkerConnectOptions extends Omit<WorkerClientOptions, 'manifest' | 'runtime'> {
  manifest?: PublicManifest;
  runtime?: string;
}

export class WorkerReservation {
  private constructor();
  readonly session: ControlSession;
  readonly id: string;
  readonly endpoint: Readonly<WorkerEndpoint>;
  readonly attachmentToken: string;
  readonly attachmentTimeoutMs: number;
  readonly releaseMode: 'control-v1';
  connect(options?: ManagedWorkerConnectOptions): Promise<WorkerClient>;
  release(reason?: CleanupReason, options?: ControlRequestOptions): Promise<OperationHandle<CleanupResult>>;
}

export type ControlEvent =
  | {v: 1 | 2; kind: 'event'; seq: number; sessionId: string; event: 'operation.finished'; data: OperationOutcome<unknown>}
  | {v: 1 | 2; kind: 'event'; seq: number; sessionId: string; event: 'authoring.output' | 'build.output'; data: {operationId: number; stream: 'stdout' | 'stderr'; chunk: number; bytesBase64: string}}
  | {v: 1 | 2; kind: 'event'; seq: number; sessionId: string; event: 'worker.started' | 'worker.ready'; data: {workerId: string}}
  | {v: 1 | 2; kind: 'event'; seq: number; sessionId: string; event: 'worker.exited'; data: {workerId: string; reason: CleanupReason; exitCode?: number}}
  | {v: 1 | 2; kind: 'event'; seq: number; sessionId: string; event: 'worker.closing'; data: {workerId: string; reason: CleanupReason}}
  | {v: 1 | 2; kind: 'event'; seq: number; sessionId: string; event: 'session.closed'; data: CleanupResult}
  | {v: 2; kind: 'event'; seq: number; sessionId: string; event: 'agent.updated' | 'agent.finished'; data: {run: HostedRun}};

export class ControlSession {
  private constructor();
  readonly client: ControlClient;
  readonly id: string;
  readonly runtime: string;
  readonly manifestJson: string;
  readonly manifest: PublicManifest;
  startAgent(request: StartAgentOptions, options?: ControlRequestOptions): Promise<HostedAgentRun>;
  /** Inspect an accepted run even if its start reply was lost above the SDK. */
  agentStatus(options?: ControlRequestOptions): Promise<Readonly<HostedRun> | null>;
  authoringExec(request: {toolId: string; arguments: string[]; cwd?: string}, options?: ControlRequestOptions): Promise<OperationHandle<CommandResult>>;
  prepare(options?: ControlRequestOptions): Promise<OperationHandle<Prepared>>;
  authorize(request: {preparedRevision: number; challenge: string; attestation: RequiredMatchAttestation}, options?: ControlRequestOptions): Promise<AuthorizationHandle>;
  acquireWorker(authorization: AuthorizationHandle, options?: ControlRequestOptions): Promise<WorkerReservation>;
  releaseWorker(worker: WorkerReservation, reason?: CleanupReason, options?: ControlRequestOptions): Promise<OperationHandle<CleanupResult>>;
  status(options?: ControlRequestOptions): Promise<SessionStatus>;
  cancel(reason?: CleanupReason, options?: ControlRequestOptions): Promise<OperationHandle<CleanupResult>>;
  close(outcomeSummary?: OutcomeSummary, options?: ControlRequestOptions): Promise<OperationHandle<CleanupResult>>;
  onEvent(listener: (event: ControlEvent) => void, options?: {replay?: boolean}): () => void;
}

export interface ControlClientOptions {
  /** Defaults to v1. V2 requires hosting.fresh-agent-v1 and never downgrades. */
  controlVersion?: 1 | 2;
  requiredCapabilities?: string[];
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  stderrLimit?: number;
  onStderr?: (chunk: Uint8Array) => void;
}

export interface ControllerCommand {command: string; args: string[]; cwd?: string; env?: Record<string, string>}
export interface ControlTransport {
  readable: StreamReadable;
  writable: StreamWritable & {writableLength?: number};
  closed: Promise<unknown>;
  stop(): unknown;
  ownership?: 'owned' | 'attached';
  onClose?(listener: (error: Error) => void): void;
}

export class ControlClient {
  static launch(options: ControlClientOptions & {controller: ControllerCommand}): Promise<ControlClient>;
  static connectUnix(options: ControlClientOptions & {socketPath: string}): Promise<ControlClient>;
  static fromTransport(transport: ControlTransport, options?: ControlClientOptions): Promise<ControlClient>;
  readonly hello: Readonly<ControlHello>;
  readonly terminalError: Error | null;
  readonly transport: ControlTransport;
  openSession(args: OpenSessionOptions, options?: ControlRequestOptions): Promise<ControlSession>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

export function parseControlJson(text: string, maxBytes?: number): unknown;
export function controlFrame(value: object, maxBytes?: number): Uint8Array;
export function validateControlRequest(message: object): object;
export function validateControlResponse(message: object, context: {request?: object; op?: string; requiredCapabilities?: string[]; terminalValidator?: (value: unknown) => void; operation?: string}): object;
export function validateControlEventEnvelope(message: object): object;
export function validateControlEvent(message: object, context?: {operation?: string}): object;
export function validateOperationRecord(value: object, operation: string, options?: {terminal?: boolean}): object;
export function validateAttachmentRecord(message: object, options?: {success?: boolean}): object;
export class ControlFrameDecoder {
  constructor(onMessage: (message: object) => void, options?: {maxBytes?: number});
  push(chunk: string | Uint8Array): void;
  end(): void;
}
