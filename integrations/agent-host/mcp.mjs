import {ControlFrameDecoder} from '../../sdk/node/control.mjs';
import {publicToolError} from './tool.mjs';

const MAX_INFLIGHT = 16;
const MAX_OUTPUT = 4 * 1_048_576;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));

/** Standard JSONL MCP transport over the supplied Gate hosting-tool handlers. */
export function serveHostingToolMcp(tool, {input = process.stdin, output = process.stdout} = {}) {
  let initialized = false, closing = false, closePromise;
  const pending = new Set();
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  function close() {
    if (!closePromise) {
      closing = true;
      input.off('data', onData);
      closePromise = Promise.resolve().then(() => tool.close()).catch(() => ({cleanupStatus: 'failed'}))
        .then(result => { resolveDone(result); return result; });
    }
    return closePromise;
  }
  function send(value) {
    if (closing) return;
    const frame = Buffer.from(`${JSON.stringify(value)}\n`);
    if (frame.length > 1_048_577 || (output.writableLength ?? 0) + frame.length > MAX_OUTPUT) { void close(); return; }
    try { output.write(frame); } catch { void close(); }
  }
  const rpcError = (id, code, message) => send({jsonrpc: '2.0', id, error: {code, message}});
  async function request(message) {
    const id = message.id;
    if (!exact(message, ['jsonrpc', 'method'], ['id', 'params']) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        (id !== undefined && !((typeof id === 'string' && id.length <= 128) || Number.isSafeInteger(id)))) {
      rpcError(null, -32600, 'Invalid request'); return;
    }
    if (id === undefined) {
      if (message.method === 'notifications/initialized' && initialized) return;
      return; // Notifications never gain a mutating tool path.
    }
    if (pending.has(id) || pending.size >= MAX_INFLIGHT) { rpcError(id, -32600, 'Duplicate or excessive request'); return; }
    pending.add(id);
    try {
      let result;
      if (message.method === 'initialize') {
        if (initialized || !exact(message.params, ['protocolVersion', 'capabilities', 'clientInfo'], ['_meta']) ||
            typeof message.params.protocolVersion !== 'string' || !object(message.params.capabilities) ||
            !object(message.params.clientInfo) ||
            typeof message.params.clientInfo.name !== 'string' || typeof message.params.clientInfo.version !== 'string') {
          rpcError(id, -32602, 'Invalid initialization'); return;
        }
        initialized = true;
        // Client implementation metadata is inert and never affects admission.
        result = {protocolVersion: '2024-11-05', capabilities: {tools: {}}, serverInfo: {name: 'mirrorgate-hosting-tool', version: '0.1.0'}};
      } else if (!initialized) { rpcError(id, -32000, 'Initialize first'); return; }
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/list') {
        if (message.params !== undefined && (!exact(message.params, [], ['_meta']) ||
            (Object.hasOwn(message.params, '_meta') && !object(message.params._meta)))) {
          rpcError(id, -32602, 'Invalid list parameters'); return;
        }
        // MCP request metadata (including progressToken: 0) is inert. It
        // neither grants hosting authority nor enables pagination/other args.
        result = {tools: tool.tools};
      } else if (message.method === 'tools/call') {
        if (!exact(message.params, ['name', 'arguments'], ['_meta']) || typeof message.params.name !== 'string') {
          rpcError(id, -32602, 'Invalid tool parameters'); return;
        }
        try {
          const value = await tool.call(message.params.name, message.params.arguments);
          result = {content: [{type: 'text', text: JSON.stringify(value)}]};
        } catch (error) { result = {isError: true, content: [{type: 'text', text: JSON.stringify(publicToolError(error))}]}; }
      } else { rpcError(id, -32601, 'Method not found'); return; }
      send({jsonrpc: '2.0', id, result});
    } finally { pending.delete(id); }
  }
  const decoder = new ControlFrameDecoder(message => { void request(message).catch(() => { rpcError(message.id ?? null, -32603, 'Request failed'); }); });
  const onData = chunk => {
    try { decoder.push(chunk); }
    catch { rpcError(null, -32700, 'Invalid JSONL frame'); void close(); }
  };
  input.on('data', onData);
  input.once('end', () => { try { decoder.end(); } catch { rpcError(null, -32700, 'Incomplete JSONL frame'); } void close(); });
  input.once('error', () => { void close(); });
  output.once('error', () => { void close(); });
  return Object.freeze({done, close});
}
