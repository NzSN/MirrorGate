import type { ApalacheConfig, State } from "mirrorecma";
import {
  MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  decodeContractV1,
  decodeSemanticDescriptor,
  semanticDescriptorDigest,
  semanticDigestFromHex,
  type GeneratedModelInterface,
  type ModelType,
  type SemanticDescriptor,
  type SemanticDigest,
} from "mirrorecma";

export const SANDBOX_PUBLIC_MANIFEST_SCHEMA = "mirrorgate.port/v1" as const;
export const SANDBOX_ASYNC_TARGET_PROFILE = "mirrorecma-async-v1" as const;
export const SANDBOX_ASYNC_COMPUTER_CONTRACT =
  "mirrors.async-state-computer/v1" as const;

const MANIFEST_BYTES = 262_144;
const MANIFEST_NODES = 8_192;
const MANIFEST_DEPTH = 96;
const TYPE_DEPTH = 32;
const STABLE_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

export type SandboxPortableType =
  | { readonly kind: "int" | "bool" | "str" | "null" }
  | { readonly kind: "seq" | "set"; readonly element: SandboxPortableType }
  | { readonly kind: "tuple"; readonly elements: readonly SandboxPortableType[] }
  | {
      readonly kind: "record";
      readonly fields: readonly {
        readonly wireName: string;
        readonly type: SandboxPortableType;
      }[];
    }
  | {
      readonly kind: "map";
      readonly key: { readonly kind: "str" };
      readonly value: SandboxPortableType;
    }
  | {
      readonly kind: "variant";
      readonly cases: readonly {
        readonly tag: string;
        readonly payload: SandboxPortableType;
      }[];
    };

export interface SandboxPublicManifest {
  readonly schema: typeof SANDBOX_PUBLIC_MANIFEST_SCHEMA;
  readonly interfaceDigest: string;
  readonly initializers: readonly SandboxPortOperation[];
  readonly actions: readonly SandboxPortOperation[];
  readonly observations: readonly SandboxPortObservation[];
}

export interface SandboxPortOperation {
  readonly id: string;
  readonly inputs: readonly { readonly id: string; readonly type: SandboxPortableType }[];
}

export interface SandboxPortObservation {
  readonly id: string;
  readonly type: SandboxPortableType;
}

export interface SandboxReplayContext {
  readonly signal: AbortSignal;
  readonly deadline: number;
}

/** The only native capability supplied to a sandbox generated binding. */
export interface SandboxNativePort {
  invoke(
    operationId: string,
    inputs: Readonly<Record<string, unknown>>,
    context: SandboxReplayContext,
  ): Promise<void>;
  observe(context: SandboxReplayContext): Promise<Readonly<Record<string, unknown>>>;
}

export interface SandboxAsyncBinding {
  readonly semanticDigest: SemanticDigest;
  readonly computer: (
    input: Readonly<{ action: string; payload: State; previous: State }>,
    context: SandboxReplayContext,
  ) => Promise<State>;
  assertCompatibleConfig(config: ApalacheConfig): void | Promise<void>;
  coverage?(): Readonly<Record<string, number>> | Promise<Readonly<Record<string, number>>>;
  dispose(): void | Promise<void>;
}

export interface SandboxAuthoringBundle {
  /** Approved declarations/examples only; never the normalized private contract. */
  readonly files: Readonly<Record<string, string>>;
}

/** Verified static model metadata plus its reviewed native binding constructor. */
export interface SandboxCompiledModel {
  readonly metadata: GeneratedModelInterface;
  readonly descriptor: SemanticDescriptor;
  readonly adapterId: string;
  readonly targetProfile: typeof SANDBOX_ASYNC_TARGET_PROFILE;
  readonly stateComputerContractVersion: typeof SANDBOX_ASYNC_COMPUTER_CONTRACT;
  /** Compiler-owned sanitized manifest, cross-checked against the descriptor. */
  readonly publicManifest: SandboxPublicManifest;
  readonly createBinding: (
    port: SandboxNativePort,
    config: ApalacheConfig,
  ) => SandboxAsyncBinding | Promise<SandboxAsyncBinding>;
  readonly authoringBundle?: SandboxAuthoringBundle;
}

export interface PreparedSandboxModel {
  readonly model: SandboxCompiledModel;
  readonly semanticDigest: SemanticDigest;
  readonly manifest: SandboxPublicManifest;
  readonly manifestJson: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface GeneratedSandboxAsyncBinding {
  readonly computer: SandboxAsyncBinding["computer"];
  assertCompatibleConfig(config: ApalacheConfig): void | Promise<void>;
  coverage?(): Readonly<Record<string, number>> | Promise<Readonly<Record<string, number>>>;
}

export interface GeneratedSandboxModelInput {
  readonly metadata: GeneratedModelInterface;
  readonly descriptor: SemanticDescriptor;
  readonly adapterId: string;
  readonly publicManifest: SandboxPublicManifest;
  readonly targetProfile: typeof SANDBOX_ASYNC_TARGET_PROFILE;
  readonly stateComputerContractVersion: typeof SANDBOX_ASYNC_COMPUTER_CONTRACT;
  /** Generated mechanical stable-ID adapter, such as bindCounterAsyncPublicPort. */
  readonly bindPublicPort: (
    port: SandboxNativePort,
    config: ApalacheConfig,
  ) => GeneratedSandboxAsyncBinding | Promise<GeneratedSandboxAsyncBinding>;
  readonly authoringBundle?: SandboxAuthoringBundle;
}

/**
 * Build the facade model from compiler-owned metadata and its generated public-port adapter.
 * A real SUT constructor is deliberately absent from this interface.
 */
export function createSandboxCompiledModel(input: GeneratedSandboxModelInput): SandboxCompiledModel {
  const digest = semanticDigestFromHex(input.metadata.semanticDigest);
  const bindPublicPort = input.bindPublicPort;
  const candidate: SandboxCompiledModel = Object.freeze({
    metadata: input.metadata,
    descriptor: input.descriptor,
    adapterId: input.adapterId,
    targetProfile: input.targetProfile,
    stateComputerContractVersion: input.stateComputerContractVersion,
    publicManifest: input.publicManifest,
    createBinding: async (port: SandboxNativePort, config: ApalacheConfig): Promise<SandboxAsyncBinding> => {
      const binding = await bindPublicPort(port, config);
      return Object.freeze({
        semanticDigest: digest,
        computer: binding.computer,
        assertCompatibleConfig: binding.assertCompatibleConfig.bind(binding),
        ...(binding.coverage === undefined ? {} : { coverage: binding.coverage.bind(binding) }),
        dispose: () => undefined,
      });
    },
    ...(input.authoringBundle === undefined ? {} : { authoringBundle: input.authoringBundle }),
  });
  // Capture and validate every inert generated artifact at construction time;
  // evaluation preflight repeats this over the already immutable snapshot.
  return prepareSandboxModel(candidate).model;
}

export class SandboxModelError extends Error {
  readonly code = "sandbox_model_invalid" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxModelError";
  }
}

function invalid(message: string): never {
  throw new SandboxModelError(message);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function requireScalarString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || utf8Bytes(value) < 1 || utf8Bytes(value) > maxBytes ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !STABLE_ID.test(value)) invalid(`${label} is invalid`);
  return value;
}

function clonePortableType(type: ModelType, path: string, depth = 0): SandboxPortableType {
  if (depth > TYPE_DEPTH) invalid(`${path}: public type is too deep`);
  switch (type.kind) {
    case "int": case "bool": case "str": case "null":
      return Object.freeze({ kind: type.kind });
    case "seq": case "set":
      return Object.freeze({
        kind: type.kind,
        element: clonePortableType(type.element, `${path}.element`, depth + 1),
      });
    case "tuple":
      return Object.freeze({
        kind: "tuple" as const,
        elements: Object.freeze(type.elements.map((item, index) =>
          clonePortableType(item, `${path}.elements[${index}]`, depth + 1))),
      });
    case "record": {
      const seen = new Set<string>();
      const fields = type.fields.map((field, index) => {
        const wireName = requireScalarString(field.wireName, `${path}.fields[${index}].wireName`, 128);
        if (seen.has(wireName)) invalid(`${path}: duplicate record field ${wireName}`);
        seen.add(wireName);
        return Object.freeze({
          wireName,
          type: clonePortableType(field.type, `${path}.${wireName}`, depth + 1),
        });
      });
      return Object.freeze({ kind: "record" as const, fields: Object.freeze(fields) });
    }
    case "map":
      if (type.key.kind !== "str") invalid(`${path}: only string map keys are portable`);
      return Object.freeze({
        kind: "map" as const,
        key: Object.freeze({ kind: "str" as const }),
        value: clonePortableType(type.value, `${path}.value`, depth + 1),
      });
    case "variant": {
      if (type.cases.length === 0) invalid(`${path}: variant must have a case`);
      const seen = new Set<string>();
      const cases = type.cases.map((item, index) => {
        const tag = requireScalarString(item.tag, `${path}.cases[${index}].tag`, 128);
        if (seen.has(tag)) invalid(`${path}: duplicate variant tag ${tag}`);
        seen.add(tag);
        return Object.freeze({
          tag,
          payload: clonePortableType(item.payload, `${path}.${tag}`, depth + 1),
        });
      });
      return Object.freeze({ kind: "variant" as const, cases: Object.freeze(cases) });
    }
    case "opaqueItf":
      return invalid(`${path}: opaqueItf is not portable to a sandbox worker`);
  }
}

function samePath(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function requireContractMatchesDescriptor(
  metadata: GeneratedModelInterface,
  descriptor: SemanticDescriptor,
): void {
  const contract = metadata.contract;
  if (contract.interfaceVersion !== descriptor.interfaceVersion ||
      contract.model.module !== descriptor.model.module ||
      contract.wire.actionVariable !== descriptor.runProfile.actionVariable ||
      contract.wire.parameterVariable !== descriptor.runProfile.configuredParamVar) {
    invalid("descriptor identity and run profile do not match generated metadata");
  }
  const matchAction = (
    phase: "initialize" | "transition",
    action: SemanticDescriptor["actions"][number],
    actionIndex: number,
  ) => {
    const sourceItems = phase === "initialize" ? contract.initializers : contract.actions;
    const source = sourceItems[actionIndex];
    if (source === undefined || source.wireAction !== action.wireAction ||
        !samePath(source.wireAliases, action.wireAliases) ||
        source.inputs.length !== action.inputs.length) {
      invalid(`descriptor action ${action.id} does not match generated metadata`);
    }
    for (let index = 0; index < action.inputs.length; index += 1) {
      const expected = source.inputs[index]!;
      const actual = action.inputs[index]!;
      if (expected.id !== actual.id || !samePath(expected.from, actual.from) ||
          (expected.expectedType !== undefined && !samePath(expected.expectedType, actual.type))) {
        invalid(`descriptor input ${action.id}.${actual.id} does not match generated metadata`);
      }
    }
  };
  if (contract.initializers.length !== descriptor.initializers.length ||
      contract.actions.length !== descriptor.actions.length ||
      contract.observations.length !== descriptor.observations.length) {
    invalid("descriptor collections do not match generated metadata");
  }
  descriptor.initializers.forEach((item, index) => matchAction("initialize", item, index));
  descriptor.actions.forEach((item, index) => matchAction("transition", item, index));
  for (let index = 0; index < descriptor.observations.length; index += 1) {
    const observation = descriptor.observations[index]!;
    const source = contract.observations[index];
    if (source === undefined || source.wireName !== observation.wireName ||
        source.provenance !== "implementation" ||
        (source.expectedType !== undefined && !samePath(source.expectedType, observation.type))) {
      invalid(`descriptor observation ${observation.id} does not match generated metadata`);
    }
  }
}

function assertManifestStructure(value: unknown, depth = 0, count = { nodes: 0 }): void {
  count.nodes += 1;
  if (depth > MANIFEST_DEPTH || count.nodes > MANIFEST_NODES) {
    invalid("public manifest exceeds structural limits");
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertManifestStructure(item, depth + 1, count));
  } else if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((item) => assertManifestStructure(item, depth + 1, count));
  }
}

/** Export only stable public operation IDs and portable types from a verified descriptor. */
export function createSandboxPublicManifest(
  descriptor: SemanticDescriptor,
  interfaceDigest: SemanticDigest,
): SandboxPublicManifest {
  if (descriptor.schema !== MODEL_INTERFACE_DESCRIPTOR_SCHEMA) invalid("descriptor schema is unsupported");
  const operations = new Set<string>();
  const operation = (item: SemanticDescriptor["actions"][number], label: string): SandboxPortOperation => {
    const id = requireId(item.id, `${label} ID`);
    if (operations.has(id)) invalid(`duplicate public operation ${id}`);
    operations.add(id);
    const inputs = item.inputs.map((input, index) => Object.freeze({
      id: requireId(input.id, `${label} ${id} input ${index} ID`),
      type: clonePortableType(input.type, `${id}.${input.id}`),
    }));
    if (new Set(inputs.map((input) => input.id)).size !== inputs.length) {
      invalid(`duplicate public input on ${id}`);
    }
    return Object.freeze({ id, inputs: Object.freeze(inputs) });
  };
  if (descriptor.initializers.length === 0) invalid("public manifest requires an initializer");
  if (descriptor.observations.length === 0) invalid("public manifest requires an observation");
  const observations = descriptor.observations.map((item, index) => Object.freeze({
    id: requireId(item.id, `observation ${index} ID`),
    type: clonePortableType(item.type, `observation.${item.id}`),
  }));
  if (new Set(observations.map((item) => item.id)).size !== observations.length) {
    invalid("duplicate public observation");
  }
  const manifest = Object.freeze({
    schema: SANDBOX_PUBLIC_MANIFEST_SCHEMA,
    interfaceDigest,
    initializers: Object.freeze(descriptor.initializers.map((item) => operation(item, "initializer"))),
    actions: Object.freeze(descriptor.actions.map((item) => operation(item, "action"))),
    observations: Object.freeze(observations),
  });
  assertManifestStructure(manifest);
  const encoded = JSON.stringify(manifest);
  if (utf8Bytes(encoded) > MANIFEST_BYTES) invalid("public manifest exceeds byte limit");
  return manifest;
}

export function prepareSandboxModel(model: SandboxCompiledModel): PreparedSandboxModel {
  if (model.targetProfile !== SANDBOX_ASYNC_TARGET_PROFILE) {
    invalid(`sandbox model target profile must be ${SANDBOX_ASYNC_TARGET_PROFILE}`);
  }
  if (model.stateComputerContractVersion !== SANDBOX_ASYNC_COMPUTER_CONTRACT) {
    invalid(`sandbox model computer contract must be ${SANDBOX_ASYNC_COMPUTER_CONTRACT}`);
  }
  requireScalarString(model.adapterId, "adapter ID", 128);
  if (typeof model.createBinding !== "function") invalid("sandbox binding constructor is missing");
  const metadata = Object.freeze({
    semanticDigest: model.metadata.semanticDigest,
    contract: decodeContractV1(structuredClone(model.metadata.contract)),
  });
  const descriptor = decodeSemanticDescriptor(structuredClone(model.descriptor));
  const authoringBundle = model.authoringBundle === undefined
    ? undefined
    : deepFreeze(structuredClone(model.authoringBundle));
  const snapshot = Object.freeze({
    metadata,
    descriptor,
    adapterId: model.adapterId,
    targetProfile: model.targetProfile,
    stateComputerContractVersion: model.stateComputerContractVersion,
    publicManifest: deepFreeze(structuredClone(model.publicManifest)),
    createBinding: model.createBinding,
    ...(authoringBundle === undefined ? {} : { authoringBundle }),
  });
  const semanticDigest = semanticDigestFromHex(metadata.semanticDigest);
  if (semanticDescriptorDigest(descriptor) !== semanticDigest) {
    invalid("descriptor digest does not match generated metadata");
  }
  requireContractMatchesDescriptor(metadata, descriptor);
  const manifest = createSandboxPublicManifest(descriptor, semanticDigest);
  if (canonicalJson(snapshot.publicManifest) !== canonicalJson(manifest)) {
    invalid("compiler-owned public manifest does not match the verified descriptor");
  }
  return Object.freeze({
    model: snapshot,
    semanticDigest,
    manifest: snapshot.publicManifest,
    manifestJson: JSON.stringify(snapshot.publicManifest),
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
