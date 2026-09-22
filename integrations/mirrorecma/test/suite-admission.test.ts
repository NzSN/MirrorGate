import type { SuiteDefinition } from "mirrorecma";
import { evaluateSuiteWithDependencies } from "../src/suite.js";

test("catalog refusal occurs before provider, session, worker, or suite construction", async () => {
  let effects = 0;
  const dependencies = new Proxy(
    {},
    {
      get() {
        effects++;
        throw new Error("Gate dependency must remain untouched");
      },
    },
  );
  await expect(
    evaluateSuiteWithDependencies(
      {} as SuiteDefinition<unknown>,
      {
        mirror: "unused",
        environment: {
          taskRef: "catalog-refusal",
          policyId: "unused",
          runtime: "node-v1",
        },
        framework: {
          catalogRaw: JSON.stringify({
            schemaVersion: "mirrors.framework-catalog/v999",
          }),
          selectionRef: {
            schemaVersion: "mirrors.framework-catalog/v1",
            selectionKind: "sha256",
            selectionValue: "0".repeat(64),
          },
          combinationId: "candidate.node-gate",
          observed: {} as never,
        },
      },
      dependencies as never,
    ),
  ).rejects.toMatchObject({ code: "catalog_invalid" });
  expect(effects).toBe(0);
});
