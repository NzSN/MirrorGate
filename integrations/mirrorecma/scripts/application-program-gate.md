# Three-application Gate acceptance

This repository-local acceptance runner uses public Gate/MirrorECMA APIs and
the shared application suite from the compatible MirrorECMA checkout. It is
development tooling, not a published installed-consumer command. Gate's existing
installed suite consumer is the independent installed-package acceptance path.
This runner uses the same `SuiteDefinition` as local application replay through
`evaluateSuite`; it no longer reconstructs a model descriptor or registry tuple.

Build MirrorECMA's core, examples and application generated bindings as described
in `MirrorECMA/examples/application-validation/README.md`. Prepare Gate's existing
dependencies and integration build. A non-root Linux controller, working
Bubblewrap namespaces and Node 24.15.0 are required. The full standalone Gate
gate remains `bash scripts/test.sh`.

From the Gate root:

```bash
export MIRRORECMA_ROOT=/absolute/MirrorECMA
export MIRRORGATE_NODE_RUNTIME_ROOT=/absolute/node-v24.15.0-linux-x64
export PATH="$MIRRORGATE_NODE_RUNTIME_ROOT/bin:$PATH"
export MIRROR_BIN=/absolute/Mirrors/.lake/build/bin/mirror
export MODEL_INTERFACE_GEN=/absolute/Mirrors/.lake/build/bin/model_interface_gen
node integrations/mirrorecma/scripts/application-program-gate.mjs work-queue --receipt /private/new-queue.json
node integrations/mirrorecma/scripts/application-program-gate.mjs persistent-transfer --receipt /private/new-transfer.json
node integrations/mirrorecma/scripts/application-program-gate.mjs lease-service --receipt /private/new-lease.json
```

The installed qualification command is:

```bash
RUNTIME/runtimes/node/bin/node \
  RUNTIME/packages/mirrorgate-mirrorecma/scripts/application-program-gate-all.mjs \
  PRIVATE_OUTPUT
```

The wrapper accepts only an empty owner-only mode-`0700` output directory. It
derives `RUNTIME/installed-registry.json`, runs the installed single-application
runner once each for WorkQueue, PersistentTransfer and LeaseService, and retains
`work-queue-gate-receipt.json`, `persistent-transfer-gate-receipt.json` and
`lease-service-gate-receipt.json`. These are the native
`mirrorgate.application-validation/v2` results. The stdout summary does not
replace them with a synthetic aggregate receipt.

The installed registry binds the Mirror executable, application tree, Node
runtime, framework input, absolute Python executable, supervisor Python root and
a Gate Node shim root containing both `runtimes/node/worker.mjs` and
`sdk/node/protocol.mjs`. The integration package includes the single runner,
aggregate wrapper and `application-policy.py`. No checkout path,
`MIRRORECMA_ROOT`, `MIRROR_BIN`, compiler or model checker participates in the
installed campaigns.

The runner derives model identity from the generated handle and supplies only
operator policy, the pinned runtime and approved submission roots. Its Node ESM
profile selects exact source files without a custom build command or hooks. Each case gets frozen source/build
handoff, a deferred worker admitted after model match, and the same trusted
suite. Correct implementations must pass, behavioral mutants must reach their
pinned mismatch, process exits must fail, hangs must time out, and cancellation
must be distinct. Every case requires confirmed Gate cleanup and no remaining
resource IDs. Private file-access canaries run during execution. The standard preparation
profile copies approved files without executing application code; custom-build
isolation remains covered by the backend gates.

Receipts use the shared atomic, exclusive private receipt writer and retain
private diagnostics. The parent directory must already exist, belong to the
evaluator, and be mode `0700`; destination files are mode `0600`. Persistence
failure fails the command independently after cleanup.
They record the actual prepared artifact/source identities separately from the
reference implementation digest. The three application models/traces/bindings
stay evaluator-side. `PUBLIC-CONTRACT.md` is the separately reviewed author input.

## Actual restricted authoring

An operator may supply an existing approved managed-agent profile with its
private credential reference. Renew its dispatcher audit against the current
Gate/runtime bytes using `python3 -m mirrorgate.agent_audit --profile PROFILE`
with Gate's `supervisor` on `PYTHONPATH`. Admission enforces supported runtime,
profile, receipt freshness and tool restrictions; this runner never replaces
admission with a synthetic host or plain subprocess.

```bash
node integrations/mirrorecma/scripts/application-program-gate.mjs lease-service \
  --receipt /private/new-authored-lease.json --host-profile /private/approved-profile.json
```

This mode runs one fresh author, not the mutant matrix. Start with the source
matrix before authoring. The only application material supplied is the public
contract and generated public kit declarations/manifest; the public environment
describes the approved Node ESM profile and tool.
The implementer writes a self-contained adapter.mjs with Node built-ins, then
submits. Preparation requires no build script. The
evaluator verifies submission/preparation source identity and evaluates the
fixed private model. A failed attempt is evidence, not permission to disclose
private diagnostics or reopen a submitted workspace. Repairs require a fresh
attempt with separately reviewed feedback.

The 2026-09-16 execution summary is in
`Mirrors/Docs/application-validation-program.md`; it distinguishes source,
actual-author and full-backend results. Runtime credentials and raw host logs
remain outside these repositories.

The migrated source matrices passed all 23 original cases (7 queue, 8 transfer,
8 lease) with confirmed physical cleanup. Each correct case also satisfies the
same suite acceptance requirements and exact matched counts as local replay.
These runs did not include a new managed author or independent onboarding study;
the optional host-profile path requires an approved operator profile.
