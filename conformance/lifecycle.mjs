import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {FrameDecoder, frame, validateResponse} from '../sdk/node/protocol.mjs';
import {prepareWorker, counterManifest} from './helpers.mjs';

const fixtures = JSON.parse(await readFile(new URL('./lifecycle.json', import.meta.url), 'utf8'));
for (const runtime of ['node-v1', 'rust-v1']) {
  for (const scenario of fixtures.cases) {
    const bundle = await prepareWorker(runtime);
    const child = spawn(bundle.supervisor.command, bundle.supervisor.args, {
      cwd: bundle.supervisor.cwd, env: bundle.supervisor.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '', failure, waiter;
    const replies = [];
    const fail = error => { failure ??= error; if (waiter) { clearTimeout(waiter.timer); waiter.reject(failure); waiter = undefined; } };
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
    child.once('error', fail);
    child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 65536) { fail(new Error('Unbounded worker log')); child.kill('SIGTERM'); } });
    const decoder = new FrameDecoder(raw => {
      const reply = validateResponse(raw);
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(reply); waiter = undefined; }
      else replies.push(reply);
    });
    child.stdout.on('data', bytes => { try { decoder.push(bytes); } catch (error) { fail(error); } });
    child.stdout.on('end', () => { try { decoder.end(); } catch (error) { fail(error); } if (waiter) fail(new Error(`Worker EOF: ${stderr}`)); });
    function next() {
      if (failure) return Promise.reject(failure);
      if (replies.length) return Promise.resolve(replies.shift());
      return new Promise((resolve, reject) => { waiter = {resolve, reject, timer: setTimeout(() => fail(new Error(`Worker response deadline: ${stderr}`)), 5000)}; });
    }
    try {
      let id = 0;
      for (const step of scenario.steps) {
        const {op, expect, ...fields} = step;
        if (op === 'hello') Object.assign(fields, {interfaceDigest: counterManifest.interfaceDigest, runtime});
        child.stdin.write(frame({v: 1, id: ++id, op, ...fields}));
        const reply = await next();
        assert.equal(reply.id, id, scenario.name);
        assert.equal(reply.ok, expect.ok, `${runtime}/${scenario.name}/${op}`);
        if (Object.hasOwn(expect, 'result')) assert.deepEqual(reply.result, expect.result);
        if (Object.hasOwn(expect, 'code')) assert.equal(reply.error.code, expect.code);
      }
      assert.equal(replies.length, 0, 'unsolicited reply');
      child.stdin.end();
      let timer;
      const result = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Supervisor cleanup deadline')), 3000); })]).finally(() => clearTimeout(timer));
      assert.equal(result.code, 0, stderr);
      assert.equal(result.signal, null);
    } finally {
      child.kill('SIGTERM');
      await closed;
      await bundle.cleanup();
    }
  }
  console.log(`${runtime}: all ${fixtures.cases.length} shared lifecycle cases passed inside Bubblewrap.`);
}
