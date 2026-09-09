import type {ControlClient, ControlSession, ControllerCommand, HostedRun, OpenSessionOptions, StartAgentOptions} from '../../sdk/node/control.mjs';
import type {StreamReadable, StreamWritable} from '../../sdk/node/worker.d.mts';

export interface ApprovedHostingTask {session: OpenSessionOptions; agent: StartAgentOptions}
export interface HostedSubmissionContext {
  /** Dedicated owner for this task. Never serialize or replace this connection. */
  client: ControlClient;
  session: ControlSession;
  run: Readonly<HostedRun>;
  taskRef: string;
  signal: AbortSignal;
  /** Explicit receipt handoff after the trusted provider has completed cleanup. */
  completeCleanup(receipt: {status: 'succeeded' | 'failed'}): void;
}
export interface PublicHostingStatus {
  runRef: string;
  taskRef: string;
  phase: string;
  accepted?: boolean;
  outcome?: 'submitted' | 'failed' | 'cancelled' | 'timedOut';
  cleanup?: {status: string; remainingResourceCount: number};
  submission?: {sourceHash: string; sourceRevision: 1};
  progress?: {firstSeq: number; nextSeq: number; truncated: boolean; records: {seq: number; message: string}[]};
  failure?: {code: string};
  evaluation?: {phase: 'running' | 'finished' | 'failed' | 'cancelled'};
  sessionCleanup?: {status: 'succeeded' | 'failed'};
}
export interface TrustedHostingCompletion {
  hosting?: Readonly<HostedRun>;
  result?: unknown;
  error?: unknown;
  cleanup?: {status: 'succeeded' | 'failed'};
}
export interface HostingTool {
  readonly tools: readonly {name: string; description: string; inputSchema: object}[];
  call(name: string, args: object): Promise<PublicHostingStatus>;
  /** Trusted local access only; never exposed by the MCP dispatcher. */
  completion(runRef: string): Promise<TrustedHostingCompletion>;
  close(): Promise<{cleanupStatus: 'succeeded' | 'failed'}>;
}
export class HostingToolError extends Error {readonly code: string; readonly runRef?: string}
export const HOSTING_TOOLS: HostingTool['tools'];
export function createHostingTool(options: {
  connect(): Promise<ControlClient>;
  tasks: Readonly<Record<string, ApprovedHostingTask>>;
  onSubmitted?(context: HostedSubmissionContext): Promise<unknown>;
  maxRuns?: number;
}): HostingTool;
export interface HostingToolConfig {
  schema: 'mirrorgate.hosting-tool/v1';
  controller: {kind: 'attached'; socketPath: string} | {kind: 'owned'; controller: ControllerCommand};
  tasks: Record<string, ApprovedHostingTask>;
  requiredCapabilities?: string[];
  maxRuns?: number;
}
export function readHostingToolConfig(path: string): Promise<HostingToolConfig>;
export function validateHostingToolConfig(config: unknown): HostingToolConfig;
export function createConfiguredHostingTool(config: HostingToolConfig, hooks?: {
  onSubmitted?(context: HostedSubmissionContext): Promise<unknown>;
}): HostingTool;
export function serveHostingToolMcp(tool: HostingTool, options?: {
  input?: StreamReadable;
  output?: StreamWritable & {writableLength?: number};
}): {done: Promise<{cleanupStatus: 'succeeded' | 'failed'}>; close(): Promise<{cleanupStatus: 'succeeded' | 'failed'}>};
