import { readFileSync } from "node:fs";
import {
  MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  decodeSemanticDescriptor,
  semanticDescriptorDigest,
  type GeneratedModelInterface,
  type SemanticDescriptor,
} from "mirrorecma";
import {
  SANDBOX_ASYNC_COMPUTER_CONTRACT,
  SANDBOX_ASYNC_TARGET_PROFILE,
  SandboxModelError,
  createSandboxPublicManifest,
  prepareSandboxModel,
  type SandboxCompiledModel,
} from "../src/sandbox-model.js";

function counterDescriptor(): SemanticDescriptor {
  const lock = JSON.parse(readFileSync(
    new URL("./fixtures/model-interface/counter/Counter.mirror-interface.lock.json", import.meta.url),
    "utf8",
  )) as Record<string, unknown>;
  const {
    contract: _contract,
    semanticDigest: _semanticDigest,
    provenance: _provenance,
    provenanceDigest: _provenanceDigest,
    ...descriptor
  } = lock;
  return decodeSemanticDescriptor({ ...descriptor, schema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA });
}

function model(descriptor = counterDescriptor()): SandboxCompiledModel {
  const metadata: GeneratedModelInterface = {
    semanticDigest: semanticDescriptorDigest(descriptor),
    contract: {
      schema: "mirrors.model-interface/v1",
      interfaceVersion: descriptor.interfaceVersion,
      model: { module: descriptor.model.module, source: "/private/specs/Counter.tla" },
      wire: {
        actionVariable: descriptor.runProfile.actionVariable,
        parameterVariable: descriptor.runProfile.configuredParamVar,
      },
      initializers: descriptor.initializers.map((action) => ({
        id: action.id,
        wireAction: action.wireAction,
        wireAliases: action.wireAliases,
        inputs: action.inputs.map((input) => ({ id: input.id, from: input.from })),
      })),
      actions: descriptor.actions.map((action) => ({
        id: action.id,
        wireAction: action.wireAction,
        wireAliases: action.wireAliases,
        inputs: action.inputs.map((input) => ({ id: input.id, from: input.from })),
      })),
      observations: descriptor.observations.map((observation) => ({
        id: observation.id,
        wireName: observation.wireName,
        provenance: observation.provenance,
      })),
    },
  };
  return {
    metadata,
    descriptor,
    adapterId: "counter.generated-async-v1",
    targetProfile: SANDBOX_ASYNC_TARGET_PROFILE,
    stateComputerContractVersion: SANDBOX_ASYNC_COMPUTER_CONTRACT,
    publicManifest: createSandboxPublicManifest(descriptor, semanticDescriptorDigest(descriptor)),
    createBinding: () => { throw new Error("not used by model preflight"); },
  };
}

test("sandbox manifest contains only stable declared IDs and portable types", () => {
  const prepared = prepareSandboxModel(model());
  expect(prepared.manifest).toEqual({
    schema: "mirrorgate.port/v1",
    interfaceDigest: semanticDescriptorDigest(counterDescriptor()),
    initializers: [{ id: "Initialize", inputs: [] }],
    actions: [{ id: "Tick", inputs: [{ id: "Stride", type: { kind: "int" } }] }],
    observations: [{ id: "Count", type: { kind: "int" } }],
  });
  expect(prepared.manifestJson).not.toContain("/private");
  expect(prepared.manifestJson).not.toContain("action_taken");
  expect(prepared.manifestJson).not.toContain("parameters");
  expect(prepared.manifestJson).not.toContain("stride");
  expect(prepared.manifestJson).not.toContain("count");
});

test("manifest preflight rejects opaque values before Gate can be loaded", () => {
  const descriptor = counterDescriptor();
  const opaque = {
    ...descriptor,
    observations: [{ ...descriptor.observations[0]!, type: { kind: "opaqueItf", description: "private" } }],
  } as SemanticDescriptor;
  expect(() => createSandboxPublicManifest(
    opaque,
    semanticDescriptorDigest(opaque),
  )).toThrow(expect.objectContaining<SandboxModelError>({ code: "sandbox_model_invalid" }));
});

test("model preflight verifies descriptor identity and exact async profile", () => {
  const valid = model();
  expect(() => prepareSandboxModel({ ...valid, adapterId: "" })).toThrow(SandboxModelError);
  expect(() => prepareSandboxModel({
    ...valid,
    metadata: { ...valid.metadata, semanticDigest: "0".repeat(64) },
  })).toThrow(SandboxModelError);
  expect(() => prepareSandboxModel({
    ...valid,
    targetProfile: "mirrorecma-v1" as typeof SANDBOX_ASYNC_TARGET_PROFILE,
  })).toThrow(SandboxModelError);
  expect(() => prepareSandboxModel({
    ...valid,
    metadata: {
      ...valid.metadata,
      contract: { ...valid.metadata.contract, interfaceVersion: "9.9.9" },
    },
  })).toThrow("descriptor identity and run profile do not match generated metadata");
});
