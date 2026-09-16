// Shared by the public kit and SDK. Imports are supplied explicitly by the caller.
import {validateManifest, encodeFields, decodeFields} from './protocol.mjs';

export async function checkAdapterStructure(manifest, module, {samples, dispose = false} = {}) {
  validateManifest(manifest);
  if (!module || typeof module.createAdapter !== 'function') throw new TypeError('Adapter must export createAdapter');
  if (!Array.isArray(samples) || !samples.length) throw new TypeError('Explicit public samples are required');
  const operations = new Map([...manifest.initializers, ...manifest.actions].map(op => [op.id, op]));
  if (!manifest.initializers.some(op => op.id === samples[0]?.action)) throw new TypeError('Samples must begin with an initializer');
  const calls = samples.map(sample => {
    if (!sample || Object.keys(sample).sort().join(',') !== 'action,inputs' || !operations.has(sample.action)) throw new TypeError('Invalid public sample');
    const operation = operations.get(sample.action);
    // Samples use the public tagged wire representation, avoiding JSON bigint loss.
    return {operation, inputs: decodeFields(operation.inputs, sample.inputs)};
  });
  const context = Object.freeze({signal: new AbortController().signal});
  // A new factory invocation is the worker reset contract. There is no shadow state.
  let disposalCount = 0;
  for (let reset = 0; reset < 2; reset++) {
    const adapter = await module.createAdapter();
    if (!adapter || !adapter.actions || typeof adapter.observe !== 'function' ||
        (adapter.dispose !== undefined && typeof adapter.dispose !== 'function') ||
        Object.keys(adapter.actions).length !== operations.size ||
        [...operations.keys()].some(id => !Object.hasOwn(adapter.actions, id) || typeof adapter.actions[id] !== 'function')) {
      throw new TypeError('Adapter handlers must exactly match public stable IDs');
    }
    try {
      for (const {operation, inputs} of calls) {
        // Give each reset/call a fresh decoded value, even when the adapter mutates input.
        const fresh = decodeFields(operation.inputs, encodeFields(operation.inputs, inputs));
        if (await adapter.actions[operation.id](fresh, context) !== undefined) throw new TypeError('Action must return undefined');
        encodeFields(manifest.observations, await adapter.observe(context));
      }
    } finally {
      if (dispose && adapter.dispose) { await adapter.dispose(); disposalCount++; }
    }
  }
  return Object.freeze({structural: true, resets: 2, calls: calls.length * 2, disposalExercised: disposalCount > 0});
}
