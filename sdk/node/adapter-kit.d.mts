import type {PublicManifest} from './worker.d.mts';
export interface KitIdentity {schema: 'mirrorgate.adapter-kit/v1'; nativeRepresentation: 'mirrors.node-native/v1'; manifestSha256: string; files: Record<string, string>}
export function generateAdapterKit(manifest: PublicManifest, options: {directory: string; behavior?: string}): Promise<KitIdentity>;
export function checkAdapterKit(manifest: PublicManifest, options: {directory: string}): Promise<{current: boolean; stale: string[]}>;
/** Executes submitted code; invoke only in an admitted development sandbox or trusted local context. */
export function checkAdapterStructure(manifest: PublicManifest, module: {createAdapter: (...args: never[]) => unknown}, options: {samples: Array<{action: string; inputs: Record<string, unknown>}>; dispose?: boolean}): Promise<{structural: true; resets: number; calls: number; disposalExercised: boolean}>;
