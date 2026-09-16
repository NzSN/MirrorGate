import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {resolve, parse, join} from 'node:path';
import {validateManifest} from './protocol.mjs';
export {checkAdapterStructure} from './adapter-check.mjs';

const VERSION = 'mirrorgate.adapter-kit/v1';
const NATIVE = 'mirrors.node-native/v1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const quote = value => JSON.stringify(value);
function native(type) {
  switch (type.kind) {
    case 'int': return 'bigint';
    case 'bool': return 'boolean';
    case 'str': return 'string';
    case 'null': return 'null';
    case 'seq': return `Array<${native(type.element)}>`;
    case 'set': return `Set<${native(type.element)}>`;
    case 'map': return `Map<string, ${native(type.value)}>`;
    case 'tuple': return `[${type.elements.map(native).join(', ')}]`;
    case 'record': return `{ ${type.fields.map(f => `${quote(f.wireName)}: ${native(f.type)}`).join('; ')} }`;
    case 'variant': return type.cases.map(c => `{ tag: ${quote(c.tag)}; value: ${native(c.payload)} }`).join(' | ');
    default: throw new TypeError('Unsupported public type');
  }
}
async function outputs(input) {
  validateManifest(input);
  // Revalidation after a JSON copy ensures caller-owned getters/objects are not retained.
  const manifest = validateManifest(JSON.parse(JSON.stringify(input)));
  const ops = [...manifest.initializers, ...manifest.actions];
  const declarations = `// Generated public Node worker contract. ${NATIVE}\nexport interface Context { readonly signal: AbortSignal }\nexport interface Adapter {\n  actions: {\n${ops.map(op => `    ${quote(op.id)}: (inputs: { ${op.inputs.map(i => `${quote(i.id)}: ${native(i.type)}`).join('; ')} }, context: Context) => void | Promise<void>;`).join('\n')}\n  };\n  observe(context: Context): { ${manifest.observations.map(o => `${quote(o.id)}: ${native(o.type)}`).join('; ')} } | Promise<{ ${manifest.observations.map(o => `${quote(o.id)}: ${native(o.type)}`).join('; ')} }>;\n  dispose?(): void | Promise<void>;\n}\nexport function createAdapter(): Adapter | Promise<Adapter>;\n`;
  const stub = `// Map these public operations to the real application.\n/** @returns {import('./adapter.js').Adapter} */\nexport function createAdapter() {\n  return {\n    actions: {\n${ops.map(op => `      [${quote(op.id)}]: (_inputs, _context) => { throw new Error(${quote('Unimplemented operation: ' + op.id)}); },`).join('\n')}\n    },\n    observe(_context) { throw new Error('Unimplemented observation'); },\n  };\n}\n`;
  const protocol = await readFile(new URL('./protocol.mjs', import.meta.url), 'utf8');
  const checker = (await readFile(new URL('./adapter-check.mjs', import.meta.url), 'utf8')).replace("'./protocol.mjs'", "'./adapter-codec.mjs'");
  const cli = `\nimport {readFile} from 'node:fs/promises';\nconst flags = process.argv.slice(2);\nif (!flags.includes('--trusted-local')) throw new Error('Run in approved Gate development sandbox or explicitly opt into trusted local execution with --trusted-local');\nconst sampleArg = flags.find(value => value.startsWith('--samples='));\nif (!sampleArg) throw new Error('Provide --samples=public-samples.json with explicit public wire inputs');\nconst manifest = JSON.parse(await readFile(new URL('./port.json', import.meta.url), 'utf8'));\nconst samples = JSON.parse(await readFile(sampleArg.slice(10), 'utf8'));\nconst adapter = await import('./adapter.mjs');\nconsole.log(JSON.stringify(await checkAdapterStructure(manifest, adapter, {samples, dispose: flags.includes('--dispose')})));\n`;
  const files = {'adapter.d.ts': declarations, 'port.json': json(manifest), 'adapter-codec.mjs': protocol, 'check-adapter.mjs': checker + cli};
  const ownership = {schema: VERSION, nativeRepresentation: NATIVE, manifestSha256: hash(files['port.json']),
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)]))};
  return {files: {...files, 'adapter-kit.json': json(ownership)}, stub, ownership};
}
async function directory(path, create) {
  if (typeof path !== 'string' || !path) throw new TypeError('Kit directory is required');
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await mkdir(current, {mode: 0o700}); info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError('Kit directory contains a symlink or non-directory');
  }
  return absolute;
}
async function existing(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new TypeError('Kit file must be a regular non-linked file');
    return await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function generateAdapterKit(manifest, {directory: target, behavior} = {}) {
  if (behavior !== undefined && typeof behavior !== 'string') throw new TypeError('Approved behavior must be text');
  const generated = await outputs(manifest);
  const root = await directory(target, true);
  const oldText = await existing(join(root, 'adapter-kit.json'));
  const old = oldText === null ? null : JSON.parse(oldText);
  const ownedNames = Object.keys(generated.ownership.files);
  if (old && (old.schema !== VERSION || old.nativeRepresentation !== NATIVE ||
      !old.files || Object.keys(old.files).sort().join(',') !== ownedNames.sort().join(',') ||
      Object.keys(old).sort().join(',') !== 'files,manifestSha256,nativeRepresentation,schema' ||
      Object.values(old.files).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))) throw new TypeError('Unrecognized kit ownership');
  for (const name of Object.keys(generated.files)) {
    const text = await existing(join(root, name));
    if (text !== null && name !== 'adapter-kit.json' && (!old || old.files[name] !== hash(text))) throw new Error(`Refusing to overwrite unowned or modified file: ${name}`);
  }
  const seeds = {'adapter.mjs': generated.stub, ...(behavior === undefined ? {} : {'PUBLIC-CONTRACT.md': behavior})};
  for (const name of Object.keys(seeds)) if (await existing(join(root, name)) !== null) delete seeds[name];
  for (const [name, content] of Object.entries({...generated.files, ...seeds})) {
    const temp = join(root, `.kit-${process.pid}-${randomUUID()}`);
    try { await writeFile(temp, content, {flag: 'wx', mode: 0o600}); await rename(temp, join(root, name)); }
    finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return generated.ownership;
}
export async function checkAdapterKit(manifest, {directory: target} = {}) {
  const generated = await outputs(manifest);
  const root = await directory(target, false);
  const stale = [];
  for (const [name, content] of Object.entries(generated.files)) if (await existing(join(root, name)) !== content) stale.push(name);
  return Object.freeze({current: stale.length === 0, stale});
}
