/** Run the three installed Gate campaigns and retain their native receipts. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [outputArgument] = process.argv.slice(2);
assert(
  outputArgument && process.argv.length === 3,
  "Usage: node application-program-gate-all.mjs OUTPUT_ROOT",
);
const outputRoot = resolve(outputArgument);
const outputInfo = await lstat(outputRoot);
assert(
  outputInfo.isDirectory() &&
    !outputInfo.isSymbolicLink() &&
    (outputInfo.mode & 0o777) === 0o700,
  "output root must be a pre-existing non-symlink mode-0700 directory",
);
if (typeof process.getuid === "function")
  assert.equal(outputInfo.uid, process.getuid(), "output root owner differs");
assert.deepEqual(await readdir(outputRoot), [], "Gate output root must start empty");

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(scriptDirectory, "../../..");
const registryPath = join(runtime, "installed-registry.json");
const single = join(scriptDirectory, "application-program-gate.mjs");
const applications = [
  ["work-queue", 9],
  ["persistent-transfer", 4],
  ["lease-service", 4],
];

async function boundedJson(path, limit = 32 * 1024 * 1024) {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    assert(info.isFile() && info.size <= limit, `${path} is not a bounded file`);
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function execute(argv) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stderr = [];
    let bytes = 0;
    child.stderr.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) child.kill("SIGKILL");
      else stderr.push(chunk);
    });
    child.stdout.resume();
    child.once("error", reject);
    child.once("close", (code, signal) =>
      done({
        code,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

for (const [application, denominator] of applications) {
  const receiptPath = join(outputRoot, `${application}-gate-receipt.json`);
  const result = await execute([
    single,
    application,
    "--receipt",
    receiptPath,
    "--installed-registry",
    registryPath,
  ]);
  assert.equal(
    result.code,
    0,
    `${application} Gate campaign failed (${result.code ?? result.signal}): ${result.stderr}`,
  );
  const receipt = await boundedJson(receiptPath);
  assert.equal(receipt.schema, "mirrorgate.application-validation/v2");
  assert.equal(receipt.application, application);
  assert.equal(receipt.authoring, "not exercised; source submissions");
  assert.equal(receipt.mutationCampaign?.schema, "mirrorecma.mutation-campaign-result/v1");
  assert.equal(receipt.mutationCampaign?.testedPath, "gate");
  assert.equal(receipt.mutationCampaign?.denominator, denominator);
  assert.equal(receipt.mutationCampaign?.requiredOnPath, denominator);
  assert.equal(receipt.mutationCampaign?.status, "complete");
  assert.equal(receipt.mutationCampaign?.acceptance?.status, "met");
  assert.equal(receipt.fidelity?.schema, "mirrorgate.observer-fidelity/v1");
  for (const item of [...receipt.outcomes, ...receipt.controls]) {
    assert.equal(item.receipt?.cleanup?.status ?? item.cleanup?.status, "confirmed");
    assert.deepEqual(
      item.receipt?.cleanup?.remainingResources ?? item.cleanup?.remainingResources,
      [],
    );
  }
}

assert.deepEqual(
  (await readdir(outputRoot)).sort(),
  applications.map(([application]) => `${application}-gate-receipt.json`).sort(),
);
console.log(
  JSON.stringify({
    schema: "mirrorgate.application-validation-aggregate/v1",
    applications: applications.map(([application]) => application),
    receipts: applications.map(
      ([application]) => `${application}-gate-receipt.json`,
    ),
  }),
);
