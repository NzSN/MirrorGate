/** Local application acceptance: trusted suite stays outside frozen submission. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  frameworkCatalogDigest,
  runMutationCampaign,
  spawnMirror,
} from "mirrorecma";
import { evaluateSuite, writeTrustedReceipt } from "../dist/index.js";
const integration = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceGate = resolve(integration, "../..");
const argv = process.argv.slice(2);
const folder = argv.shift();
let receiptPath;
let profilePath;
let installedRegistryPath;
while (argv.length) {
  const flag = argv.shift();
  const value = argv.shift();
  assert(value, "Gate application flag requires a value");
  if (flag === "--receipt" && !receiptPath) receiptPath = value;
  else if (flag === "--host-profile" && !profilePath) profilePath = value;
  else if (flag === "--installed-registry" && !installedRegistryPath)
    installedRegistryPath = value;
  else assert.fail("unknown or duplicate Gate application flag");
}
assert(
  folder && receiptPath,
  "Usage: node application-program-gate.mjs APPLICATION --receipt NEW_FILE [--installed-registry FILE] [--host-profile APPROVED_PROFILE]",
);
assert(
  !(profilePath && installedRegistryPath),
  "installed qualification does not run the optional authoring profile",
);
const installedRegistry = installedRegistryPath
  ? JSON.parse(await readFile(resolve(installedRegistryPath), "utf8"))
  : undefined;
const installedRoot = installedRegistryPath
  ? dirname(resolve(installedRegistryPath))
  : undefined;
const frameworkInput = installedRegistry
  ? JSON.parse(
      await readFile(
        resolve(installedRoot, installedRegistry.frameworkInput),
        "utf8",
      ),
    )
  : undefined;
const ecma = installedRegistry
  ? resolve(installedRoot, installedRegistry.applicationValidationRoot)
  : resolve(process.env.MIRRORECMA_ROOT ?? join(sourceGate, "../MirrorECMA"));
const gatePaths = installedRegistry
  ? {
      mirror: resolve(installedRoot, installedRegistry.mirrorServer),
      nodeShimRoot: resolve(installedRoot, installedRegistry.gate.nodeShimRoot),
      supervisorRoot: resolve(installedRoot, installedRegistry.gate.supervisor),
      python: installedRegistry.gate.python,
      policyWriter: join(integration, "scripts/application-policy.py"),
      nodeRuntime: resolve(
        installedRoot,
        installedRegistry.installation.runtimeTrees.find(
          (item) => item.runtimeId === "node-runtime",
        ).root,
      ),
    }
  : {
      mirror:
        process.env.MIRROR_BIN ??
        resolve(ecma, "../Mirrors/.lake/build/bin/mirror"),
      nodeShimRoot: sourceGate,
      supervisorRoot: join(sourceGate, "supervisor"),
      python: process.env.MIRRORGATE_PYTHON ?? "/usr/bin/python3",
      policyWriter: join(integration, "scripts/application-policy.py"),
      nodeRuntime: process.env.MIRRORGATE_NODE_RUNTIME_ROOT,
    };
assert(gatePaths.nodeRuntime, "pinned Gate Node runtime root is required");
assert(
  typeof gatePaths.python === "string" && gatePaths.python.startsWith("/"),
  "absolute installed Gate Python path is required",
);
const { loadApplication, checkArtifacts } = await import(
  pathToFileURL(join(ecma, "examples/application-validation/suite.mjs"))
);
const { sha256 } = await import(
  pathToFileURL(join(ecma, "examples/application-validation/regenerate.mjs"))
);
assert.equal(
  process.version,
  "v24.15.0",
  "Gate acceptance requires the pinned Node runtime",
);
const hostProfile = profilePath
  ? JSON.parse(await readFile(profilePath, "utf8"))
  : undefined;
const app = await loadApplication(folder);
await checkArtifacts(
  app,
  installedRegistry
    ? {
        prevalidated: {
          status: "verified",
          catalogRaw: frameworkInput.catalogRaw,
          catalogSelectionRef: frameworkInput.selectionRef,
        },
      }
    : {},
);
const scratch = await mkdtemp(join(tmpdir(), `gate-${folder}-`));
const policyFile = join(scratch, "policy.json");
const outcomes = [];
let mutationCampaign;
let protectedInputs;
let campaignDefinition;
let catalogIdentity;
let fidelity;
try {
  const submissions = join(scratch, "submissions");
  await mkdir(submissions);
  const canary = join(scratch, "private-oracle-canary");
  await writeFile(canary, "private evaluator data", { mode: 0o600 });
  const policy = spawnSync(
    gatePaths.python,
    [
      gatePaths.policyWriter,
      policyFile,
      submissions,
      gatePaths.nodeShimRoot,
      gatePaths.nodeRuntime,
      folder,
      app.suite.adapterId,
      app.model.targetProfile,
      app.model.stateComputerContractVersion,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PYTHONPATH: gatePaths.supervisorRoot,
      },
    },
  );
  if (policy.error) throw policy.error;
  assert.equal(policy.status, 0, policy.stderr);
  const config = JSON.parse(await readFile(policyFile, "utf8"));
  const nodeRoot = config.policies[0].runtimes[0].runtimeMounts.find(
    (mount) => mount.destination === "/runtime/node",
  ).source;
  config.schema = "mirrorgate.control-policy/v2";
  config.agentProfiles = hostProfile ? [hostProfile] : [];
  config.policies[0].agentProfileIds = hostProfile ? [hostProfile.id] : [];
  config.policies[0].buildPlans = [
    {
      id: "application.node",
      profile: "node-esm/v1",
      entryPoint: "adapter.mjs",
      sourceFiles: hostProfile
        ? ["adapter.mjs"]
        : folder === "work-queue"
          ? [
              "adapter.mjs",
              "service.mjs",
              "queue.js",
              "validation-faults.mjs",
              "queue-fixture.mjs",
              "fidelity.mjs",
              "package.json",
            ]
          : ["adapter.mjs", "service.mjs", "fidelity.mjs", "package.json"],
      runtimeSha256: await sha256(join(nodeRoot, "bin/node")),
      dependencies: [],
    },
  ];
  const publicKit = join(scratch, "public-kit");
  if (hostProfile) {
    const { generateAdapterKit } = await import(
      pathToFileURL(join(sourceGate, "sdk/node/adapter-kit.mjs"))
    );
    await generateAdapterKit(app.publicManifest, {
      directory: publicKit,
      behavior: await readFile(
        join(app.directory, "PUBLIC-CONTRACT.md"),
        "utf8",
      ),
    });
  }
  await writeFile(policyFile, JSON.stringify(config));
  const fidelityVariants =
    !hostProfile && folder === "lease-service"
      ? [
          "observer-shadow-unchecked",
          "observer-shadow-enforced",
          "observer-throws",
          "observer-invalid",
        ]
      : [];
  const variants = hostProfile
    ? ["authored"]
    : [
        "correct",
        ...Object.keys(app.faults),
        "crash",
        "hang",
        "cancel",
        ...fidelityVariants,
      ];
  const leaseTrace =
    folder === "lease-service"
      ? JSON.parse(await readFile(app.trace, "utf8"))
      : undefined;
  const leaseShadow = leaseTrace
    ? [...leaseTrace.states, ...leaseTrace.states].map((state) => ({
        Owners: state.owners["#set"].map((item) => item["#bigint"]),
        Epoch: state.epoch["#bigint"],
        Expires: state.expires["#bigint"],
        Now: state.now["#bigint"],
        Accepted: state.accepted,
        Writes: state.writes["#bigint"],
      }))
    : [];
  for (const variant of variants) {
    const controlCase = ["crash", "hang", "cancel"].includes(variant);
    const fidelityCase = fidelityVariants.includes(variant);
    const source = join(submissions, variant);
    await mkdir(source);
    if (!hostProfile) {
      await copyFile(
        join(
          app.directory,
          folder === "work-queue" ? "gate-service.mjs" : "service.mjs",
        ),
        join(source, "service.mjs"),
      );
      if (folder !== "work-queue")
        await copyFile(
          join(ecma, "examples/application-validation/fidelity.mjs"),
          join(source, "fidelity.mjs"),
        );
      if (folder === "work-queue") {
        await copyFile(
          join(ecma, "dist-test/examples/work-queue/queue.js"),
          join(source, "queue.js"),
        );
        for (const name of ["validation-faults.mjs", "queue-fixture.mjs"])
          await copyFile(join(app.directory, name), join(source, name));
        await copyFile(
          join(ecma, "examples/application-validation/fidelity.mjs"),
          join(source, "fidelity.mjs"),
        );
      }
      await writeFile(join(source, "package.json"), '{"type":"module"}\n');
      await writeFile(
        join(source, "adapter.mjs"),
        `import {existsSync} from 'node:fs';
import {createAdapter as create} from './service.mjs';
import {instrumentApplicationAdapter,withObserverControl} from './fidelity.mjs';
if (existsSync(${JSON.stringify(canary)}) || existsSync(${JSON.stringify(app.config.specPath)})) throw new Error('private runtime file exposed');
export async function createAdapter() {
  const actual = await create(${JSON.stringify(fidelityCase ? "overlapping-ownership" : controlCase ? "correct" : variant)});
  const shadow = ${JSON.stringify(leaseShadow)}.map((state)=>({Owners:new Set(state.Owners.map(BigInt)),Epoch:BigInt(state.Epoch),Expires:BigInt(state.Expires),Now:BigInt(state.Now),Accepted:state.Accepted,Writes:BigInt(state.Writes)}));
  const adapter = ${JSON.stringify(variant === "observer-shadow-unchecked" || variant === "observer-shadow-enforced")} ? withObserverControl(actual,'shadow',shadow) : ${JSON.stringify(variant === "observer-throws")} ? withObserverControl(actual,'throws') : ${JSON.stringify(variant === "observer-invalid")} ? withObserverControl(actual,'invalid') : actual;
  if (${JSON.stringify(controlCase)}) {
    for (const id of Object.keys(adapter.actions)) {
      if (id === 'Initialize') continue;
      adapter.actions[id] = ${variant === "crash" ? "() => process.exit(17)" : "() => new Promise(() => {})"};
    }
  }
  return instrumentApplicationAdapter(${JSON.stringify(folder)}, adapter, {enforce:${JSON.stringify(variant !== "observer-shadow-unchecked")}}).adapter;
}
`,
      );
    }
    const started = performance.now();
    const controller = new AbortController();
    // The cancellation control is triggered when the model requests the first
    // transition, so preparation cannot consume the cancellation timer.
    let cancelTimer;
    const mirror =
      variant === "cancel"
        ? () => {
            const transport = spawnMirror(
              gatePaths.mirror,
            );
            return {
              send: (line) => transport.send(line),
              close: () => {
                clearTimeout(cancelTimer);
                return transport.close();
              },
              async *[Symbol.asyncIterator]() {
                for await (const line of transport) {
                  if (
                    !cancelTimer &&
                    JSON.parse(line).proto_step === "next_step"
                  ) {
                    cancelTimer = setTimeout(
                      () => controller.abort("application acceptance"),
                      25,
                    );
                  }
                  yield line;
                }
              },
            };
          }
        : gatePaths.mirror;
    const outcome = await evaluateSuite(app.suite, {
      mirror,
      environment: {
        taskRef: `${folder}-${variant}`,
        policyId: folder,
        runtime: "node-v1",
        gate: {
          kind: "owned",
          launcher: {
            command: gatePaths.python,
            args: ["-m", "mirrorgate.cli"],
            env: { ...process.env, PYTHONPATH: gatePaths.supervisorRoot },
          },
          policyFile,
        },
      },
      submission: {
        kind: "source",
        buildPlanId: "application.node",
        authoring: !!hostProfile,
        input: { rootId: "submission", relativePath: variant },
      },
      ...(hostProfile
        ? {
            agent: {
              profileId: hostProfile.id,
              publicTask: {
                instructions:
                  "Implement the supplied public contract from scratch. Use only public_contract, gate_exec and submit. " +
                  'The approved toolId is python; gate_exec args may be ["-c", "Python code"]. ' +
                  "Write self-contained adapter.mjs exporting createAdapter() in the writable /workspace. " +
                  "Use the generated public declarations and Node built-ins only. The approved Node ESM profile prepares the entry point. " +
                  "Submit when complete. Do not inspect private evaluator files.",
                files: [
                  {
                    path: "PUBLIC-CONTRACT.md",
                    text: await readFile(
                      join(app.directory, "PUBLIC-CONTRACT.md"),
                      "utf8",
                    ),
                  },
                  {
                    path: "port.json",
                    text: await readFile(join(publicKit, "port.json"), "utf8"),
                  },
                  {
                    path: "adapter.d.ts",
                    text: await readFile(
                      join(publicKit, "adapter.d.ts"),
                      "utf8",
                    ),
                  },
                ],
              },
            },
          }
        : {}),
      signal: controller.signal,
      timeouts: {
        registrationMs: 30_000,
        actionMs: variant === "hang" ? 200 : 5_000,
        receiveMs: 30_000,
        cleanupMs: 10_000,
      },
      ...(installedRegistry
        ? {
            framework: {
              catalogRaw: frameworkInput.catalogRaw,
              selectionRef: frameworkInput.selectionRef,
              combinationId: installedRegistry.combinationId,
              observed: frameworkInput.observed,
              ...(frameworkInput.approval
                ? { approval: frameworkInput.approval }
                : {}),
            },
          }
        : {}),
    });
    outcomes.push({
      variant,
      fixedFixtureProbe: "enforced",
      durationMs: performance.now() - started,
      ...outcome,
    });
    assert.equal(
      outcome.receipt.cleanup.status,
      "confirmed",
      JSON.stringify(outcome),
    );
    assert.deepEqual(outcome.receipt.cleanup.remainingResources, []);
    const expected = fidelityCase
      ? variant === "observer-shadow-unchecked"
        ? "passed"
        : "failed"
      : controlCase
      ? { crash: "failed", hang: "timedOut", cancel: "cancelled" }[variant]
      : ["correct", "authored"].includes(variant)
        ? "passed"
        : "mismatch";
    assert.equal(outcome.outcome, expected, JSON.stringify(outcome));
    if (expected === "passed") {
      assert.equal(outcome.suiteResult.acceptance.status, "met");
      assert.equal(outcome.suiteResult.evidence.tracesCompleted, 2);
      assert.equal(
        outcome.suiteResult.evidence.transitionsMatched,
        String(2 * app.length),
      );
    }
    if (hostProfile) {
      assert.equal(outcome.receipt.hosting?.outcome, "submitted");
      assert.equal(
        outcome.receipt.hosting.submission.sourceHash,
        outcome.receipt.implementation.sourceHash,
      );
    } else if (variant !== "correct" && !controlCase && !fidelityCase) {
      const error = outcome.suiteResult.failure;
      assert.equal(error?.kind, "mismatch");
      assert.equal(error.stateIndex, app.faults[variant].step);
      assert.equal(error.traceIndex, app.faults[variant].trace ?? 0);
      assert.equal(
        outcome.suiteResult.trustedError?.action,
        app.faults[variant].action,
      );
    }
  }
} finally {
  if (!hostProfile) {
    const digestJson = (value) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const closureSha = async (paths) =>
      digestJson(
        await Promise.all(
          [...paths]
            .sort()
            .map(async (path) => ({ path, sha256: await sha256(path) })),
        ),
      );
    const fidelityPath = join(
      ecma,
      "examples/application-validation/fidelity.mjs",
    );
    const servicePath = join(
      app.directory,
      folder === "work-queue" ? "gate-service.mjs" : "service.mjs",
    );
    const implementationFiles =
      folder === "work-queue"
        ? [
            servicePath,
            join(ecma, "dist-test/examples/work-queue/queue.js"),
            join(app.directory, "validation-faults.mjs"),
            join(app.directory, "queue-fixture.mjs"),
            fidelityPath,
          ]
        : [servicePath, fidelityPath];
    const implementationSha = await closureSha(implementationFiles);
    const probeId = {
      "work-queue": "persisted-queue-json/v1",
      "persistent-transfer": "transfer-payload-journal/v1",
      "lease-service": "lease-ownership-token-writes/v1",
    }[folder];
    protectedInputs = {
      suite: {
        id: app.suite.id,
        sha256: digestJson({
          id: app.suite.id,
          replay: app.suite.replay,
          acceptance: app.suite.acceptance,
        }),
      },
      model: {
        id: `${folder}.model/v1`,
        sha256: await sha256(app.config.specPath),
      },
      generatedInterface: {
        id: `${folder}.interface/v1`,
        sha256: await closureSha([
          join(app.directory, "artifacts", "bundle", `${app.module}.suite.ts`),
          join(
            ecma,
            "dist-validation",
            "examples",
            folder,
            "artifacts",
            "bundle",
            `${app.module}.suite.js`,
          ),
          join(
            app.directory,
            "artifacts",
            "bundle",
            ".suite-bundle-generated.json",
          ),
        ]),
      },
      corpus: {
        id: `${folder}.ordered-corpus/v1`,
        sha256: digestJson(
          app.suite.replay.traces.map((trace) => trace.sha256),
        ),
      },
      acceptance: {
        id: `${folder}.acceptance/v1`,
        sha256: digestJson(app.suite.acceptance),
      },
      observer: {
        id: `${folder}.observer/v1`,
        sha256: await closureSha(
          folder === "work-queue"
            ? [join(app.directory, "queue-fixture.mjs")]
            : [servicePath],
        ),
      },
      correctImplementation: {
        id: `${folder}/correct`,
        sha256: implementationSha,
      },
      probes: [
        {
          id: probeId,
          sha256: await closureSha(
            folder === "work-queue"
              ? [join(app.directory, "queue-fixture.mjs"), fidelityPath]
              : [servicePath, fidelityPath],
          ),
        },
      ],
      executionProfiles: [
        {
          id: "gate-node-esm/v1",
          sha256: digestJson({
            policy: await sha256(policyFile),
            runner: await sha256(fileURLToPath(import.meta.url)),
            node: process.version,
          }),
        },
      ],
    };
    const catalogRaw = installedRegistry
      ? Buffer.from(frameworkInput.catalogRaw, "utf8")
      : await readFile(
          resolve(ecma, "../Mirrors/catalog/framework-catalog.json"),
        );
    const catalog = JSON.parse(catalogRaw.toString("utf8"));
    const selectedCombination = catalog.combinations.find(
      (item) => item.combinationId === "candidate.node-gate",
    );
    assert(selectedCombination, "candidate.node-gate catalog combination missing");
    catalogIdentity = {
      selectionRef: {
        schemaVersion: "mirrors.framework-catalog/v1",
        selectionKind: "sha256",
        selectionValue: frameworkCatalogDigest(catalogRaw),
      },
      combinationId: selectedCombination.combinationId,
      componentRefs: selectedCombination.componentIds.map(
        (componentId) =>
          catalog.components.find(
            (component) => component.componentRef.componentId === componentId,
          ).componentRef,
      ),
    };
    const campaign = {
      schema: "mirrorecma.mutation-campaign/v1",
      id: app.mutationCampaign.id,
      revision: app.mutationCampaign.revision,
      evidenceLinks: {
        catalogSelectionRef: {
          ...catalogIdentity.selectionRef,
        },
      },
      denominator: app.mutationCampaign.denominator,
      protected: protectedInputs,
      mutants: app.mutationCampaign.mutants.map((mutant) => ({
        ...mutant,
        implementation: {
          id: `${folder}/${mutant.id}`,
          sha256: digestJson({ implementationSha, variant: mutant.id }),
        },
        resetPlanId: `${folder}.gate-fresh-worker/v1`,
        probeIds: [probeId],
      })),
    };
    mutationCampaign = await runMutationCampaign(campaign, {
      path: "gate",
      observedProtected: protectedInputs,
      policy: {
        maxMutants: 256,
        totalBudgetMs: 300_000,
        perRunBudgetMs: 30_000,
        cleanupBudgetMs: 10_000,
      },
      evaluate: async (scenario) => {
        const variant = scenario.kind === "correct" ? "correct" : scenario.id;
        const evaluated = outcomes.find((item) => item.variant === variant);
        if (!evaluated?.suiteResult)
          throw new Error(`missing Gate outcome for ${variant}`);
        const local = evaluated.suiteResult.cleanup.status;
        const physical = evaluated.receipt.cleanup;
        const physicalConfirmed =
          physical.status === "confirmed" &&
          physical.remainingResources.length === 0;
        return {
          suiteResult: evaluated.suiteResult,
          cleanup: [
            {
              scope: "local-cooperative",
              requirement: "required",
              status:
                local === "succeeded"
                  ? "confirmed"
                  : local === "failed"
                    ? "failed"
                    : "unconfirmed",
            },
            {
              scope: "gate-physical",
              requirement: "required",
              status: physicalConfirmed
                ? "confirmed"
                : physical.status === "failed"
                  ? "failed"
                  : "unconfirmed",
            },
          ],
          probe:
            evaluated.fixedFixtureProbe === "enforced" &&
            ["passed", "mismatch"].includes(evaluated.outcome)
              ? { status: "passed" }
              : {
                  status: "not_run",
                  code: "fixed_fixture_probe_unavailable",
                },
          evidenceRef: { gateRunId: evaluated.receipt.runId },
        };
      },
    });
    assert.equal(mutationCampaign.status, "complete", JSON.stringify(mutationCampaign));
    assert.equal(mutationCampaign.acceptance.status, "met", JSON.stringify(mutationCampaign));
    assert.equal(mutationCampaign.denominator, app.mutationCampaign.denominator);
    assert.equal(mutationCampaign.requiredOnPath, app.mutationCampaign.denominator);
    assert.deepEqual(
      mutationCampaign.mutants.map((item) => item.id),
      app.mutationCampaign.mutants.map((item) => item.id),
    );
    campaignDefinition = {
      id: campaign.id,
      revision: campaign.revision,
      denominator: campaign.denominator,
      orderedCaseIds: campaign.mutants.map((item) => item.id),
      cases: campaign.mutants.map((item) => ({
        id: item.id,
        implementation: item.implementation,
        expected: item.expected,
        probeIds: item.probeIds,
      })),
    };
    const byVariant = (id) => outcomes.find((item) => item.variant === id);
    const standard = ["correct", ...Object.keys(app.faults)].map(byVariant);
    assert(standard.every((item) => item?.fixedFixtureProbe === "enforced"));
    if (folder === "lease-service") {
      const shadowUnchecked = byVariant("observer-shadow-unchecked");
      const shadowEnforced = byVariant("observer-shadow-enforced");
      const observerThrows = byVariant("observer-throws");
      const observerInvalid = byVariant("observer-invalid");
      assert.equal(shadowUnchecked?.outcome, "passed");
      assert.equal(shadowEnforced?.outcome, "failed");
      assert.equal(observerThrows?.suiteResult?.failure?.kind, "implementation");
      assert.equal(observerInvalid?.suiteResult?.failure?.kind, "codec");
      fidelity = {
        schema: "mirrorgate.observer-fidelity/v1",
        method: "actual-facts-vs-observation",
        probeIdentity: protectedInputs.probes[0],
        normalCases: "passed",
        shadowControl: {
          reportedReplay: "passed",
          actualFactsComparison: {
            status: "failed",
            code: "probe_observer_divergence",
            enforcedOutcome: "failed",
          },
        },
        observerError: "implementation_failure",
        invalidObservation: "codec_failure",
      };
    } else {
      fidelity = {
        schema: "mirrorgate.observer-fidelity/v1",
        method: "actual-facts-vs-observation",
        probeIdentity: protectedInputs.probes[0],
        normalCases: "passed",
        shadowControl: {
          status: "not_applicable",
          reason: "real Gate shadow negative is retained by lease-service",
        },
      };
    }
  }
  const receipt = {
    schema: "mirrorgate.application-validation/v2",
    application: folder,
    authoring: hostProfile
      ? "actual Gate-hosted restricted runtime"
      : "not exercised; source submissions",
    node: process.version,
    runnerSha256: await sha256(fileURLToPath(import.meta.url)),
    publicContractSha256: await sha256(
      join(app.directory, "PUBLIC-CONTRACT.md"),
    ),
    model: await sha256(app.config.specPath),
    referenceImplementation: await sha256(
      join(app.directory, folder === "work-queue" ? "queue.ts" : "service.mjs"),
    ),
    trace: await sha256(app.trace),
    interface: app.model.semanticDigest,
    ...(mutationCampaign
      ? {
          catalog: catalogIdentity,
          protected: protectedInputs,
          campaignDefinition,
          mutationCampaign,
          fidelity,
          controls: ["crash", "hang", "cancel"].map((id) => {
            const item = outcomes.find((outcome) => outcome.variant === id);
            return {
              id,
              outcome: item.outcome,
              cleanup: item.receipt.cleanup,
            };
          }),
        }
      : {}),
    outcomes,
  };
  try {
    const persisted = await writeTrustedReceipt(receipt, {
      path: resolve(receiptPath),
    });
    assert.equal(
      persisted.status,
      "written",
      "private aggregate receipt persistence failed",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
console.log(
  `${folder}: ${outcomes.length} real sandbox evaluations passed; all cleanup confirmed`,
);
