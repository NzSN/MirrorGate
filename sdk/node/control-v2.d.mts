import type {PublicTask, HostingLimits, HostedRun} from './control.d.mts';
export declare const HOSTING_CAPABILITY: 'hosting.fresh-agent-v1';
export declare const HOSTING_LIMITS: Readonly<HostingLimits>;
export function validatePublicTask(value: unknown): PublicTask;
export function validateHostingLimits(value: unknown, options?: {complete?: boolean}): Partial<HostingLimits>;
export function validateHostedRun(value: unknown): HostedRun;
export function validateHostingError(value: unknown): unknown;
export function validateControlV2Request(value: object): object;
export function validateControlV2Response(value: object, context: {request: object; operation?: string; terminalValidator?: (value: unknown) => void}): object;
export function validateControlV2Event(value: object, context?: {operation?: string}): object;
export {validateOperationRecord} from './control.mjs';

export declare const PUBLIC_ENVIRONMENT_CAPABILITY: 'hosting.public-environment-v1';
export interface PublicEnvironment {
  schema: 'mirrorgate.public-environment/v1';
  profileId: 'node-esm/v1' | 'custom-build/v1' | 'prebuilt/v1';
  stages: Record<'authoring' | 'build' | 'execution', {root: string; writable: string[]}>;
  entryPoint: string;
  tools: string[];
  limits: Record<string, number>;
}
export interface PublicContract {schema: 'mirrorgate.public-contract/v2'; task: PublicTask; tools: string[]; environment: PublicEnvironment}
export function validatePublicContract(value: unknown): PublicContract;
