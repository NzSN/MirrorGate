import {validateManifest} from '../../sdk/node/protocol.mjs';

/** Trusted exporter: caller supplies an already verified Mirrors descriptor/lock. */
export function publicManifest(descriptor, interfaceDigest) {
  const operation = action => ({id: action.id, inputs: action.inputs.map(input => ({id: input.id, type: structuredClone(input.type)}))});
  return validateManifest({
    schema: 'mirrorgate.port/v1', interfaceDigest,
    initializers: descriptor.initializers.map(operation),
    actions: descriptor.actions.map(operation),
    observations: descriptor.observations.map(observation => ({id: observation.id, type: structuredClone(observation.type)})),
  });
}
