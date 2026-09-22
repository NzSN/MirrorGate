import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("installed aggregate runs each native campaign once from a relocated D tree", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "mirrorgate-all-"));
  try {
    const runtime = join(temporary, "relocated/runtime");
    const scripts = join(runtime, "packages/mirrorgate-mirrorecma/scripts");
    const output = join(temporary, "output");
    await mkdir(scripts, { recursive: true });
    await mkdir(output, { mode: 0o700 });
    await writeFile(join(runtime, "installed-registry.json"), "{}\n");
    await copyFile(
      resolve("scripts/application-program-gate-all.mjs"),
      join(scripts, "application-program-gate-all.mjs"),
    );
    await writeFile(join(scripts, "application-program-gate.mjs"), `
import {appendFileSync,writeFileSync} from 'node:fs';
const [application,flag,receipt,registryFlag,registry]=process.argv.slice(2);
if(flag!=='--receipt'||registryFlag!=='--installed-registry'||!registry) process.exit(9);
appendFileSync(${JSON.stringify(join(temporary, "calls"))},application+'\\n');
const denominator={'work-queue':9,'persistent-transfer':4,'lease-service':4}[application];
const cleanup={status:'confirmed',remainingResources:[],failures:[]};
const native={schema:'mirrorgate.application-validation/v2',application,
  authoring:'not exercised; source submissions',
  mutationCampaign:{schema:'mirrorecma.mutation-campaign-result/v1',testedPath:'gate',denominator,requiredOnPath:denominator,status:'complete',acceptance:{status:'met'}},
  fidelity:{schema:'mirrorgate.observer-fidelity/v1'},
  outcomes:[{receipt:{cleanup}}],controls:[{cleanup}]};
writeFileSync(receipt,JSON.stringify(native),{flag:'wx',mode:0o600});
`);
    const result = spawnSync(process.execPath, [
      join(scripts, "application-program-gate-all.mjs"),
      output,
    ], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect((await readFile(join(temporary, "calls"), "utf8")).trim().split("\n"))
      .toEqual(["work-queue", "persistent-transfer", "lease-service"]);
    for (const application of ["work-queue", "persistent-transfer", "lease-service"])
      expect(JSON.parse(await readFile(
        join(output, `${application}-gate-receipt.json`), "utf8",
      ))).toMatchObject({ schema: "mirrorgate.application-validation/v2", application });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
