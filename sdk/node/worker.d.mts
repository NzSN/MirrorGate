import type {WorkerReservation} from './control.d.mts';

export type PortableType =
  | {kind: 'int' | 'bool' | 'str' | 'null'}
  | {kind: 'seq' | 'set'; element: PortableType}
  | {kind: 'tuple'; elements: PortableType[]}
  | {kind: 'record'; fields: Array<{wireName: string; type: PortableType}>}
  | {kind: 'map'; key: {kind: 'str'}; value: PortableType}
  | {kind: 'variant'; cases: Array<{tag: string; payload: PortableType}>};

export interface PublicManifest {
  schema: 'mirrorgate.port/v1';
  interfaceDigest: string;
  initializers: Array<{id: string; inputs: Array<{id: string; type: PortableType}>}>;
  actions: Array<{id: string; inputs: Array<{id: string; type: PortableType}>}>;
  observations: Array<{id: string; type: PortableType}>;
}

export interface PublicModelDescriptor {
  initializers: Array<{id: string; inputs: Array<{id: string; type: PortableType}>}>;
  actions: Array<{id: string; inputs: Array<{id: string; type: PortableType}>}>;
  observations: Array<{id: string; type: PortableType}>;
}

export function createPublicManifest(
  descriptor: PublicModelDescriptor,
  interfaceDigest: string,
): PublicManifest;

/** Convert generated set/map arrays to worker SDK Set/Map values. */
export function toWorkerValue(type: PortableType, value: unknown): unknown;

/** Convert worker SDK Set/Map values to generated set/map arrays. */
export function fromWorkerValue(type: PortableType, value: unknown): unknown;

export interface WorkerCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WorkerClientOptions {
  manifest: PublicManifest;
  runtime: string;
  timeoutMs?: number;
  cancellationGraceMs?: number;
  cleanupTimeoutMs?: number;
  terminationGraceMs?: number;
  stderrLimit?: number;
  onStderr?: (chunk: Uint8Array) => void;
}

export interface StreamReadable {
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'error' | 'end', listener: (error?: Error) => void): unknown;
  resume?(): unknown;
}

export interface StreamWritable {
  on(event: 'error', listener: (error: Error) => void): unknown;
  write(chunk: string | Uint8Array): unknown;
  end(): unknown;
}

export interface IsolatedWorkerTransport {
  readable: StreamReadable;
  writable: StreamWritable;
  closed: Promise<unknown>;
  terminate(reason?: string): unknown;
  onClose?(listener: (error: Error) => void): void;
}

export interface ManagedWorkerTransport extends IsolatedWorkerTransport {
  managed: true;
  beginRelease(reason: string): Promise<{cleanupMode: 'dispose-then-terminate' | 'terminate-only'}>;
  finishRelease(release: {cleanupMode: 'dispose-then-terminate' | 'terminate-only'}): Promise<unknown>;
  requestCancellation(reason: string): Promise<unknown>;
}

export interface SupervisorCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export class ProtocolError extends Error {
  readonly code: string;
}

export class WorkerClient {
  static launch(options: WorkerClientOptions & {supervisor: SupervisorCommand}): Promise<WorkerClient>;
  static fromIsolatedTransport(transport: IsolatedWorkerTransport, options: WorkerClientOptions): Promise<WorkerClient>;
  static fromManagedTransport(transport: ManagedWorkerTransport, options: WorkerClientOptions): Promise<WorkerClient>;
  readonly manifest: PublicManifest;
  readonly runtime: string;
  readonly state: string;
  readonly terminalError: ProtocolError | null;
  readonly primaryError: ProtocolError | null;
  invoke(actionId: string, inputs: Record<string, unknown>, options?: WorkerCallOptions): Promise<void>;
  observe(options?: WorkerCallOptions): Promise<Record<string, unknown>>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PublicPortProxy {
  invoke(id: string, inputs: Record<string, unknown>, options?: WorkerCallOptions): Promise<void>;
  observe(options?: WorkerCallOptions): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
}

export function createPortProxy(client: WorkerClient): Readonly<PublicPortProxy>;

export interface ManagedWorkerFactoryOptions extends WorkerClientOptions {
  reservation: WorkerReservation;
}

export function createManagedWorker(options: ManagedWorkerFactoryOptions): Promise<WorkerClient>;
