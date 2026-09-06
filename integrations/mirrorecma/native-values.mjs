/** Mechanical conversion between MirrorECMA native arrays and Gate Set/Map values. */
function convert(type, value, toGate) {
  switch (type.kind) {
    case 'int': case 'bool': case 'str': case 'null': return value;
    case 'seq': return value.map(item => convert(type.element, item, toGate));
    case 'tuple': return value.map((item, index) => convert(type.elements[index], item, toGate));
    case 'set': {
      const items = [...value].map(item => convert(type.element, item, toGate));
      return toGate ? new Set(items) : items;
    }
    case 'map': {
      const pairs = [...value].map(([key, item]) => [key, convert(type.value, item, toGate)]);
      return toGate ? new Map(pairs) : pairs;
    }
    case 'record': return Object.fromEntries(type.fields.map(field => [field.wireName, convert(field.type, value[field.wireName], toGate)]));
    case 'variant': {
      const found = type.cases.find(item => item.tag === value.tag);
      if (!found) throw new TypeError('Unknown declared variant');
      return {tag: value.tag, value: convert(found.payload, value.value, toGate)};
    }
    default: throw new TypeError(`Unsupported portable type ${type.kind}`);
  }
}
export const toGateNative = (type, value) => convert(type, value, true);
export const toMirrorNative = (type, value) => convert(type, value, false);
