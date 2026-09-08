import {encodeValue, validateManifest, validateType} from './protocol.mjs';

function portableType(type) {
  validateType(type);
  switch (type.kind) {
    case 'int': case 'bool': case 'str': case 'null':
      return {kind: type.kind};
    case 'seq': case 'set':
      return {kind: type.kind, element: portableType(type.element)};
    case 'tuple':
      return {kind: 'tuple', elements: type.elements.map(portableType)};
    case 'record':
      return {kind: 'record', fields: type.fields.map(field => ({
        wireName: field.wireName,
        type: portableType(field.type),
      }))};
    case 'map':
      return {kind: 'map', key: {kind: 'str'}, value: portableType(type.value)};
    case 'variant':
      return {kind: 'variant', cases: type.cases.map(item => ({
        tag: item.tag,
        payload: portableType(item.payload),
      }))};
    default:
      throw new TypeError(`Unsupported portable type ${type.kind}`);
  }
}

/**
 * Produce the worker-visible manifest from an already verified generated
 * descriptor. Model names, wire actions, projections, provenance and other
 * descriptor fields are intentionally not copied.
 */
export function createPublicManifest(descriptor, interfaceDigest) {
  if (!descriptor || typeof descriptor !== 'object') throw new TypeError('A verified model descriptor is required');
  const operations = collection => {
    if (!Array.isArray(collection)) throw new TypeError('Invalid public operation collection');
    return collection.map(operation => {
      if (!operation || typeof operation !== 'object' || !Array.isArray(operation.inputs)) {
        throw new TypeError('Invalid public operation');
      }
      return {
        id: operation.id,
        inputs: operation.inputs.map(input => {
          if (!input || typeof input !== 'object') throw new TypeError('Invalid public operation input');
          return {id: input.id, type: portableType(input.type)};
        }),
      };
    });
  };
  if (!Array.isArray(descriptor.observations)) throw new TypeError('Invalid public observation collection');
  const manifest = {
    schema: 'mirrorgate.port/v1',
    interfaceDigest,
    initializers: operations(descriptor.initializers),
    actions: operations(descriptor.actions),
    observations: descriptor.observations.map(observation => {
      if (!observation || typeof observation !== 'object') throw new TypeError('Invalid public observation');
      return {id: observation.id, type: portableType(observation.type)};
    }),
  };
  return validateManifest(manifest);
}

function toWorker(type, value) {
  switch (type.kind) {
    case 'int': case 'bool': case 'str': case 'null': return value;
    case 'seq':
      if (!Array.isArray(value)) throw new TypeError('Expected native sequence');
      return value.map(item => toWorker(type.element, item));
    case 'tuple':
      if (!Array.isArray(value) || value.length !== type.elements.length) throw new TypeError('Expected native tuple');
      return type.elements.map((item, index) => toWorker(item, value[index]));
    case 'set': {
      if (!Array.isArray(value)) throw new TypeError('Expected generated set array');
      const result = new Set(value.map(item => toWorker(type.element, item)));
      if (result.size !== value.length) throw new TypeError('Duplicate generated set element');
      return result;
    }
    case 'map': {
      if (!Array.isArray(value)) throw new TypeError('Expected generated map entries');
      const result = new Map();
      for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || result.has(entry[0])) {
          throw new TypeError('Invalid or duplicate generated map key');
        }
        result.set(entry[0], toWorker(type.value, entry[1]));
      }
      return result;
    }
    case 'record': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected generated record');
      const expected = type.fields.map(field => field.wireName).sort();
      const actual = Object.keys(value).sort();
      if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
        throw new TypeError('Generated record fields mismatch');
      }
      return Object.fromEntries(type.fields.map(field => [field.wireName, toWorker(field.type, value[field.wireName])]));
    }
    case 'variant': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected generated variant');
      const keys = Object.keys(value).sort();
      if (keys.length !== 2 || keys[0] !== 'tag' || keys[1] !== 'value') throw new TypeError('Generated variant fields mismatch');
      const found = type.cases.find(item => item.tag === value.tag);
      if (!found) throw new TypeError('Unknown declared variant');
      return {tag: value.tag, value: toWorker(found.payload, value.value)};
    }
    default: throw new TypeError(`Unsupported portable type ${type.kind}`);
  }
}

function fromWorker(type, value) {
  switch (type.kind) {
    case 'int': case 'bool': case 'str': case 'null': return value;
    case 'seq': return value.map(item => fromWorker(type.element, item));
    case 'tuple': return type.elements.map((item, index) => fromWorker(item, value[index]));
    case 'set': return [...value].map(item => fromWorker(type.element, item));
    case 'map': return [...value].map(([key, item]) => [key, fromWorker(type.value, item)]);
    case 'record': return Object.fromEntries(type.fields.map(field => [field.wireName, fromWorker(field.type, value[field.wireName])]));
    case 'variant': {
      const found = type.cases.find(item => item.tag === value.tag);
      return {tag: value.tag, value: fromWorker(found.payload, value.value)};
    }
    default: throw new TypeError(`Unsupported portable type ${type.kind}`);
  }
}

/** Convert generated MirrorECMA set/map arrays to the Node worker SDK values. */
export function toWorkerValue(type, value) {
  validateType(type);
  const result = toWorker(type, value);
  encodeValue(type, result);
  return result;
}

/** Convert validated Node worker SDK values to generated MirrorECMA arrays. */
export function fromWorkerValue(type, value) {
  validateType(type);
  encodeValue(type, value);
  return fromWorker(type, value);
}
