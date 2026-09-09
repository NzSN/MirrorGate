#!/usr/bin/env node
import {createConfiguredHostingTool, readHostingToolConfig} from './config.mjs';
import {serveHostingToolMcp} from './mcp.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') throw new Error('Invalid command');
  const config = await readHostingToolConfig(args[1]);
  const server = serveHostingToolMcp(createConfiguredHostingTool(config));
  const stop = () => { void server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await server.done;
    if (result.cleanupStatus !== 'succeeded') process.exitCode = 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); process.stdin.pause(); }
}

main().catch(() => { console.error('MirrorGate hosting-tool startup or cleanup failed.'); process.exitCode = 1; });
