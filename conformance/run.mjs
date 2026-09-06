import {strict as assert} from 'node:assert';
import {launchWorker} from './helpers.mjs';

for (const runtime of ['node-v1', 'rust-v1']) {
  const worker = await launchWorker(runtime);
  try {
    await worker.client.invoke('Initialize', {});
    assert.deepEqual(await worker.client.observe(), {Count: 0n});
    const big = 900719925474099312345678901234567890n;
    await worker.client.invoke('Tick', {Stride: big});
    assert.deepEqual(await worker.client.observe(), {Count: big});
    await worker.client.invoke('Tick', {Stride: -7n});
    assert.deepEqual(await worker.client.observe(), {Count: big - 7n});
    await worker.client.invoke('Initialize', {});
    assert.deepEqual(await worker.client.observe(), {Count: 0n});
  } finally { await worker.close(); }
  await worker.close();

  const faulty = await launchWorker(runtime, {faulty: true});
  try {
    await faulty.client.invoke('Initialize', {});
    assert.deepEqual(await faulty.client.observe(), {Count: 0n});
    await faulty.client.invoke('Tick', {Stride: 2n});
    assert.deepEqual(await faulty.client.observe(), {Count: 1n});
  } finally { await faulty.close(); }
  console.log(`${runtime}: isolated bigint/reset and actual faulty Counter observations passed.`);
}
console.log('Cross-language sandbox Counter conformance passed.');
