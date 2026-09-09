import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {ControlClient, parseControlJson} from '../../sdk/node/control.mjs';
import {createHostingTool, HostingToolError, validateApprovedTasks} from './tool.mjs';

function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new HostingToolError('INVALID_CONFIGURATION');
  }
}

export async function readHostingToolConfig(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new HostingToolError('INVALID_CONFIGURATION');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await file.stat();
    if (!status.isFile() || status.size > 1_048_576 || (status.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && status.uid !== process.getuid())) throw new HostingToolError('INVALID_CONFIGURATION');
    const bytes = await file.readFile();
    if (bytes.length > 1_048_576) throw new HostingToolError('INVALID_CONFIGURATION');
    const config = parseControlJson(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    validateHostingToolConfig(config);
    return config;
  } finally { await file.close(); }
}

export function validateHostingToolConfig(config) {
  exact(config, ['schema', 'controller', 'tasks'], ['requiredCapabilities', 'maxRuns']);
  if (config.schema !== 'mirrorgate.hosting-tool/v1') throw new HostingToolError('INVALID_CONFIGURATION');
  const endpoint = config.controller;
  if (endpoint?.kind === 'attached') {
    exact(endpoint, ['kind', 'socketPath']);
    if (typeof endpoint.socketPath !== 'string' || !isAbsolute(endpoint.socketPath)) throw new HostingToolError('INVALID_CONFIGURATION');
  } else if (endpoint?.kind === 'owned') {
    exact(endpoint, ['kind', 'controller']);
    exact(endpoint.controller, ['command', 'args'], ['cwd', 'env']);
    if (typeof endpoint.controller.command !== 'string' || !endpoint.controller.command ||
        !Array.isArray(endpoint.controller.args) || endpoint.controller.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
        (endpoint.controller.cwd !== undefined && typeof endpoint.controller.cwd !== 'string') ||
        (endpoint.controller.env !== undefined && (!endpoint.controller.env || typeof endpoint.controller.env !== 'object' ||
          Array.isArray(endpoint.controller.env) || Object.values(endpoint.controller.env).some(value => typeof value !== 'string')))) throw new HostingToolError('INVALID_CONFIGURATION');
  } else throw new HostingToolError('INVALID_CONFIGURATION');
  if (config.requiredCapabilities !== undefined && (!Array.isArray(config.requiredCapabilities) || config.requiredCapabilities.length > 63 ||
      config.requiredCapabilities.some(id => typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(id)) ||
      new Set(config.requiredCapabilities).size !== config.requiredCapabilities.length)) throw new HostingToolError('INVALID_CONFIGURATION');
  if (config.maxRuns !== undefined && (!Number.isSafeInteger(config.maxRuns) || config.maxRuns < 1 || config.maxRuns > 128)) throw new HostingToolError('INVALID_CONFIGURATION');
  validateApprovedTasks(config.tasks);
  return config;
}

/** Data-only installed configuration; the in-process callback stays trusted. */
export function createConfiguredHostingTool(config, {onSubmitted} = {}) {
  validateHostingToolConfig(config);
  config = parseControlJson(JSON.stringify(config));
  const options = {controlVersion: 2, requiredCapabilities: config.requiredCapabilities ?? [], closeTimeoutMs: 7_000};
  const endpoint = config.controller;
  return createHostingTool({tasks: config.tasks, maxRuns: config.maxRuns, onSubmitted,
    connect: () => endpoint.kind === 'attached'
      ? ControlClient.connectUnix({...options, socketPath: endpoint.socketPath})
      : ControlClient.launch({...options, controller: endpoint.controller}),
  });
}
