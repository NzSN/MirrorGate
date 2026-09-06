/** MirrorGate v1 public protocol. See protocol/ and shared conformance vectors. */
export const LIMITS = Object.freeze({frameBytes: 65535, manifestBytes: 262144, depth: 96, nodes: 8192, semanticDepth: 32});
const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const INTEGER = /^(?:0|-?[1-9][0-9]*)$/;
const DIGEST = /^[0-9a-f]{64}$/;
export class ProtocolError extends Error {
  constructor(code, message) { super(message); this.name = 'ProtocolError'; this.code = code; }
}
const bad = (message, code = 'SCHEMA') => { throw new ProtocolError(code, message); };
export function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function exact(value, keys, code = 'SCHEMA') {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) bad('Unexpected object fields', code);
}
function scalarString(value) { return typeof value === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value); }
function name(value) { if (!scalarString(value) || Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > 128) bad('Invalid public field name'); }
function id(value) { if (typeof value !== 'string' || !ID.test(value)) bad('Invalid stable identifier'); }
function requestId(value) { if (!Number.isSafeInteger(value) || value <= 0) bad('Invalid request ID'); }
function ownObject(entries) { return Object.fromEntries(entries); }

/** JSON.parse accepts duplicate keys; this bounded parser deliberately does not. */
export function parseJson(text, maxBytes = LIMITS.frameBytes) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) bad('JSON byte limit exceeded', 'LIMIT');
  let pos = 0; let nodes = 0;
  const ws = () => { while (pos < text.length && /[ \t\r\n]/.test(text[pos])) pos++; };
  const string = () => {
    const start = pos++;
    while (pos < text.length) {
      const c = text[pos++];
      if (c === '"') {
        let result;
        try { result = JSON.parse(text.slice(start, pos)); } catch { bad('Malformed JSON string', 'FRAME'); }
        if (!scalarString(result)) bad('Non-scalar Unicode string', 'FRAME');
        return result;
      }
      if (c === '\\') pos++;
    }
    bad('Unterminated JSON string', 'FRAME');
  };
  const value = depth => {
    if (depth > LIMITS.depth || ++nodes > LIMITS.nodes) bad('JSON structural limit exceeded', 'LIMIT');
    ws(); const c = text[pos];
    if (c === '"') return string();
    if (c === '{') {
      pos++; ws(); const entries = []; const seen = new Set();
      if (text[pos] === '}') { pos++; return {}; }
      while (pos < text.length) {
        ws(); if (text[pos] !== '"') bad('Expected object key', 'FRAME');
        const key = string(); if (seen.has(key)) bad('Duplicate JSON object key', 'FRAME'); seen.add(key);
        ws(); if (text[pos++] !== ':') bad('Expected colon', 'FRAME');
        entries.push([key, value(depth + 1)]); ws();
        const sep = text[pos++]; if (sep === '}') return ownObject(entries);
        if (sep !== ',') bad('Expected object separator', 'FRAME');
      }
      bad('Unterminated JSON object', 'FRAME');
    }
    if (c === '[') {
      pos++; ws(); const result = [];
      if (text[pos] === ']') { pos++; return result; }
      while (pos < text.length) {
        result.push(value(depth + 1)); ws(); const sep = text[pos++];
        if (sep === ']') return result;
        if (sep !== ',') bad('Expected array separator', 'FRAME');
      }
      bad('Unterminated JSON array', 'FRAME');
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, pos)) { pos += literal.length; return result; }
    }
    const matched = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(pos));
    if (matched) {
      const token = matched[0]; pos += token.length;
      const parts = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
      let digits = (parts[2] + (parts[3] ?? '')).replace(/^0+/, '');
      const scale = Number(parts[4] ?? '0') - (parts[3]?.length ?? 0);
      if (!digits) return 0;
      if (!Number.isSafeInteger(scale)) bad('Unsafe JSON number', 'FRAME');
      if (scale < 0) {
        const remove = -scale;
        if (remove >= digits.length || !digits.endsWith('0'.repeat(Math.min(remove, digits.length)))) bad('Fractional JSON number', 'FRAME');
        digits = digits.slice(0, digits.length - remove);
      } else {
        if (digits.length + scale > 16) bad('Unsafe JSON number', 'FRAME');
        digits += '0'.repeat(scale);
      }
      const n = Number(parts[1] + digits);
      if (!Number.isSafeInteger(n)) bad('Unsafe JSON number', 'FRAME'); return n;
    }
    bad('Malformed JSON value', 'FRAME');
  };
  const result = value(0); ws(); if (pos !== text.length) bad('Trailing JSON content', 'FRAME'); return result;
}

export class FrameDecoder {
  constructor(onMessage) { this.buffer = Buffer.alloc(0); this.onMessage = onMessage; }
  push(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < data.length) {
      const end = data.indexOf(10, start); const part = data.subarray(start, end < 0 ? data.length : end);
      if (this.buffer.length + part.length > LIMITS.frameBytes) bad('Frame byte limit exceeded', 'LIMIT');
      this.buffer = Buffer.concat([this.buffer, part]);
      if (end < 0) return;
      if (this.buffer.includes(13)) bad('CR is forbidden in JSONL frames', 'FRAME');
      let line; try { line = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(this.buffer); } catch { bad('Invalid UTF-8', 'FRAME'); }
      this.buffer = Buffer.alloc(0); const message = parseJson(line);
      if (!object(message)) bad('A frame must contain an object', 'FRAME');
      this.onMessage(message); start = end + 1;
    }
  }
  end() { if (this.buffer.length) bad('Unterminated JSONL frame', 'FRAME'); }
}
export function frame(value) {
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output) > LIMITS.frameBytes) bad('Frame byte limit exceeded', 'LIMIT');
  // Apply the same structural bounds to output as input.
  if (!object(parseJson(output))) bad('A frame must contain an object', 'FRAME');
  return `${output}\n`;
}

export function validateType(type, depth = 0) {
  if (depth > LIMITS.semanticDepth) bad('Type depth limit exceeded', 'LIMIT');
  if (!object(type)) bad('Invalid public type');
  const child = t => validateType(t, depth + 1);
  switch (type.kind) {
    case 'int': case 'bool': case 'str': case 'null': exact(type, ['kind']); break;
    case 'seq': case 'set': exact(type, ['kind', 'element']); child(type.element); break;
    case 'tuple':
      exact(type, ['kind', 'elements']); if (!Array.isArray(type.elements)) bad('Invalid tuple elements'); type.elements.forEach(child); break;
    case 'record': {
      exact(type, ['kind', 'fields']); if (!Array.isArray(type.fields)) bad('Invalid record fields'); const seen = new Set();
      for (const field of type.fields) { exact(field, ['wireName', 'type']); name(field.wireName); if (seen.has(field.wireName)) bad('Duplicate record field'); seen.add(field.wireName); child(field.type); } break;
    }
    case 'map': exact(type, ['kind', 'key', 'value']); exact(type.key, ['kind']); if (type.key.kind !== 'str') bad('Only string map keys are portable'); child(type.value); break;
    case 'variant': {
      exact(type, ['kind', 'cases']); if (!Array.isArray(type.cases) || type.cases.length === 0) bad('Invalid variant cases'); const seen = new Set();
      for (const c of type.cases) { exact(c, ['tag', 'payload']); name(c.tag); if (seen.has(c.tag)) bad('Duplicate variant tag'); seen.add(c.tag); child(c.payload); } break;
    }
    default: bad('Unsupported public type');
  }
  return type;
}
export function validateManifest(manifest) {
  // Enforce object/aggregate bounds even for evaluator-owned in-memory values.
  parseJson(JSON.stringify(manifest), LIMITS.manifestBytes);
  exact(manifest, ['schema', 'interfaceDigest', 'initializers', 'actions', 'observations']);
  if (manifest.schema !== 'mirrorgate.port/v1' || !DIGEST.test(manifest.interfaceDigest)) bad('Invalid manifest identity');
  if (!Array.isArray(manifest.initializers) || manifest.initializers.length === 0 || !Array.isArray(manifest.actions) || !Array.isArray(manifest.observations) || manifest.observations.length === 0) bad('Invalid public port collections');
  const operations = new Set();
  for (const action of [...manifest.initializers, ...manifest.actions]) {
    exact(action, ['id', 'inputs']); id(action.id); if (operations.has(action.id)) bad('Duplicate operation ID'); operations.add(action.id);
    if (!Array.isArray(action.inputs)) bad('Invalid input collection'); const inputs = new Set();
    for (const input of action.inputs) { exact(input, ['id', 'type']); id(input.id); if (inputs.has(input.id)) bad('Duplicate input ID'); inputs.add(input.id); validateType(input.type); }
  }
  const outputs = new Set();
  for (const observation of manifest.observations) { exact(observation, ['id', 'type']); id(observation.id); if (outputs.has(observation.id)) bad('Duplicate observation ID'); outputs.add(observation.id); validateType(observation.type); }
  return manifest;
}
export function validateRequest(req) {
  if (!object(req) || req.v !== 1) bad('Unsupported protocol version'); requestId(req.id);
  switch (req.op) {
    case 'hello': exact(req, ['v', 'id', 'op', 'interfaceDigest', 'runtime']); if (!DIGEST.test(req.interfaceDigest)) bad('Invalid interface digest'); id(req.runtime); break;
    case 'create': case 'observe': case 'dispose': exact(req, ['v', 'id', 'op']); break;
    case 'invoke': exact(req, ['v', 'id', 'op', 'action', 'inputs']); id(req.action); if (!object(req.inputs)) bad('Invalid inputs envelope'); break;
    case 'cancel': exact(req, ['v', 'id', 'op', 'requestId']); requestId(req.requestId); if (req.requestId >= req.id) bad('Cancellation must target an earlier request'); break;
    default: bad('Unknown request operation');
  }
  return req;
}
export function validateResponse(reply) {
  if (!object(reply) || reply.v !== 1) bad('Unsupported response version'); requestId(reply.id);
  if (reply.ok === true) exact(reply, ['v', 'id', 'ok', 'result']);
  else if (reply.ok === false) { exact(reply, ['v', 'id', 'ok', 'error']); exact(reply.error, ['code', 'message']); if (typeof reply.error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(reply.error.code)) bad('Invalid error code'); if (!scalarString(reply.error.message) || Buffer.byteLength(reply.error.message) > 1024) bad('Invalid error message'); }
  else bad('Invalid response status');
  return reply;
}
function canonical(type, value) {
  switch (type.kind) {
    case 'seq': return JSON.stringify(value.map(v => canonical(type.element, v)));
    case 'set': return JSON.stringify(value['#set'].map(v => canonical(type.element, v)).sort());
    case 'tuple': return JSON.stringify(type.elements.map((t, i) => canonical(t, value['#tup'][i])));
    case 'record': return JSON.stringify([...type.fields].sort((a, b) => a.wireName < b.wireName ? -1 : a.wireName > b.wireName ? 1 : 0).map(f => [f.wireName, canonical(f.type, value[f.wireName])]));
    case 'map': return JSON.stringify(value['#map'].map(([k, v]) => [k, canonical(type.value, v)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    case 'variant': return JSON.stringify([value.tag, canonical(type.cases.find(c => c.tag === value.tag).payload, value.value)]);
    default: return JSON.stringify(value);
  }
}
function duplicates(type, values) { const seen = new Set(); for (const item of values) { const key = canonical(type, item); if (seen.has(key)) bad('Duplicate collection element', 'VALUE'); seen.add(key); } }
function valueDepth(depth) { if (depth > LIMITS.semanticDepth) bad('Value depth limit exceeded', 'LIMIT'); }
export function decodeValue(type, value, depth = 0) {
  valueDepth(depth); const child = (t, v) => decodeValue(t, v, depth + 1);
  switch (type.kind) {
    case 'int': exact(value, ['#bigint'], 'VALUE'); if (typeof value['#bigint'] !== 'string' || !INTEGER.test(value['#bigint'])) bad('Invalid integer encoding', 'VALUE'); return BigInt(value['#bigint']);
    case 'bool': if (typeof value !== 'boolean') bad('Expected boolean', 'VALUE'); return value;
    case 'str': if (!scalarString(value)) bad('Expected Unicode string', 'VALUE'); return value;
    case 'null': if (value !== null) bad('Expected null', 'VALUE'); return null;
    case 'seq': if (!Array.isArray(value)) bad('Expected sequence', 'VALUE'); return Array.from(value, v => child(type.element, v));
    case 'set': exact(value, ['#set'], 'VALUE'); if (!Array.isArray(value['#set'])) bad('Expected set elements', 'VALUE'); { const decoded = value['#set'].map(v => child(type.element, v)); duplicates(type.element, value['#set']); return new Set(decoded); }
    case 'tuple': exact(value, ['#tup'], 'VALUE'); if (!Array.isArray(value['#tup']) || value['#tup'].length !== type.elements.length) bad('Tuple arity mismatch', 'VALUE'); return type.elements.map((t, i) => child(t, value['#tup'][i]));
    case 'record': exact(value, type.fields.map(f => f.wireName), 'VALUE'); return ownObject(type.fields.map(f => [f.wireName, child(f.type, value[f.wireName])]));
    case 'map': {
      exact(value, ['#map'], 'VALUE'); if (!Array.isArray(value['#map'])) bad('Expected map entries', 'VALUE'); const result = new Map();
      for (const entry of value['#map']) { if (!Array.isArray(entry) || entry.length !== 2 || !scalarString(entry[0]) || result.has(entry[0])) bad('Invalid or duplicate map key', 'VALUE'); result.set(entry[0], child(type.value, entry[1])); } return result;
    }
    case 'variant': { exact(value, ['tag', 'value'], 'VALUE'); const c = type.cases.find(c => c.tag === value.tag); if (!c) bad('Unknown variant tag', 'VALUE'); return {tag: c.tag, value: child(c.payload, value.value)}; }
    default: bad('Unsupported value type', 'VALUE');
  }
}
export function encodeValue(type, value, depth = 0) {
  valueDepth(depth); const child = (t, v) => encodeValue(t, v, depth + 1);
  switch (type.kind) {
    case 'int': if (typeof value !== 'bigint') bad('Expected native bigint', 'VALUE'); return {'#bigint': value.toString()};
    case 'bool': case 'str': case 'null': decodeValue(type, value, depth); return value;
    case 'seq': if (!Array.isArray(value)) bad('Expected native sequence', 'VALUE'); return Array.from(value, v => child(type.element, v));
    case 'tuple': if (!Array.isArray(value) || value.length !== type.elements.length) bad('Expected native tuple', 'VALUE'); return {'#tup': type.elements.map((t, i) => child(t, value[i]))};
    case 'set': if (!(value instanceof Set)) bad('Expected native Set', 'VALUE'); { const encoded = [...value].map(v => child(type.element, v)); duplicates(type.element, encoded); return {'#set': encoded}; }
    case 'record': exact(value, type.fields.map(f => f.wireName), 'VALUE'); return ownObject(type.fields.map(f => [f.wireName, child(f.type, value[f.wireName])]));
    case 'map': if (!(value instanceof Map)) bad('Expected native Map', 'VALUE'); return {'#map': [...value].map(([k, v]) => { if (!scalarString(k)) bad('Expected string map key', 'VALUE'); return [k, child(type.value, v)]; })};
    case 'variant': { exact(value, ['tag', 'value'], 'VALUE'); const c = type.cases.find(c => c.tag === value.tag); if (!c) bad('Unknown variant tag', 'VALUE'); return {tag: c.tag, value: child(c.payload, value.value)}; }
    default: bad('Unsupported native type', 'VALUE');
  }
}
export function decodeFields(fields, value) { exact(value, fields.map(f => f.id), 'VALUE'); return ownObject(fields.map(f => [f.id, decodeValue(f.type, value[f.id])])); }
export function encodeFields(fields, value) { exact(value, fields.map(f => f.id), 'VALUE'); return ownObject(fields.map(f => [f.id, encodeValue(f.type, value[f.id])])); }
