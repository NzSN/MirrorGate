import { readFileSync } from 'node:fs';
import { evaluateCounter } from './evaluate.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node run.mjs <approved-config.json>');
const configuration = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const controller = new AbortController();
const cancel = () => controller.abort('operator cancellation');
process.once('SIGINT', cancel);
try {
  const outcome = await evaluateCounter(configuration, {signal: controller.signal});
  process.stdout.write(`${JSON.stringify(outcome.publicResult)}\n`);
  process.exitCode = outcome.publicResult.status === 'passed' ? 0 : 1;
} finally {
  process.removeListener('SIGINT', cancel);
}
