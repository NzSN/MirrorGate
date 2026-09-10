# Trusted MirrorECMA evaluator integration

`mirrorgate-mirrorecma` is the optional, Gate-owned TypeScript integration. Its
source extraction, prepared/control-v1 provider, hosted-v2 local workflow and
trusted/public receipts are integrated and verified in the destination. The
package is private and tested through installed consumption; it is not published.
Actual Codex authoring, the installed MCP protocol harness, MirrorECMA 2 core/live
checks and coordinated gates passed. Real outside-Codex MCP registration and the
complete actual-implementer workflow also passed;
[final validation](../../docs/managed-workflow-validation.md) records authoritative
results.

The integration imports only the public `mirrorecma`, `mirrorgate/control` and
`mirrorgate/worker` APIs. MirrorECMA owns negotiation, replay, comparisons and
generic binding lifetime; Gate owns worker admission, physical cleanup and this
integration. Neither the Gate supervisor nor basic SDK depends on MirrorECMA.

## Local workflow

`evaluateImplementation(plan, options)` owns the complete local composition:
connect to Gate, start an approved managed author when requested, wait for explicit
submission, prepare, supply the deferred factory to an ordinary suite, and join
physical cleanup. It also accepts approved source without authoring and prebuilt
artifacts. Gate's controller/runtime integration supplies hosting; this package
does not launch a second agent process or implement another broker.

```ts
import { evaluateImplementation } from "mirrorgate-mirrorecma";

const outcome = await evaluateImplementation({
  taskRef: "counter", gate: approvedGateEndpoint,
  policyId: "counter", runtime: "node-v1",
  submission: approvedSource, agent: approvedAgentRequest,
  model: generatedCounterModel,
  suite: {
    id: "counter-suite", revision: approvedSuiteRevision,
    modelRevision: approvedModelRevision,
    context: { mirror, modelConfig, tracePaths },
    run: runCounterSuite,
  },
}, { signal });

// Full model/failure/source/cleanup evidence remains trusted.
retainTrustedReceipt(outcome.receipt);
return outcome.publicResult;
```

The [workflow contract](WORKFLOW.md) and public declarations define exact inputs,
ownership, deadlines and bounded disclosure. Model outcome and physical cleanup
are independent receipt fields; a model pass with unconfirmed cleanup is an
overall failure. Suite/model revision labels are supplied by the trusted caller;
they are not authenticated merely by being passed to this function.

For the standard `mirrorgate/hosting-tool`, configure
`createHostedEvaluationHandler({taskRef: approvedDefinition})` as `onSubmitted`.
The integration uses the original dedicated owner, rechecks the committed source,
and explicitly hands back cleanup through the trusted `completeCleanup` callback.
It neither reconstructs a run handle nor reconnects to adopt a submitted session.

The [installed Counter consumer](examples/counter/README.md) supplies only its
configuration, generated contract and the same generic suite as MirrorECMA's
source tests/CLI. Normal evaluation does no client compilation or repository
packing. The optional [evaluation service](service/README.md) invokes this same
workflow and publishes only its public result.

## Prepared implementation provider

A trusted host prepares an artifact using the public Gate SDK, retaining the same
owner connection. It then passes that session and preparation receipt to
`createPreparedImplementationProvider`. Construction validates model/manifest
and artifact identities but does not authorize or launch a worker.

```ts
import { createPreparedImplementationProvider } from "mirrorgate-mirrorecma";

const provider = await createPreparedImplementationProvider({
  session, prepared, model,
  policyId: "approved-counter",
  runtime: "node-v1",
});

let summary: { status: "passed" | "failed" } = { status: "failed" };
try {
  // The application suite accepts a generic AsyncAdapterFactory, independent
  // of Gate. It registers this factory with verify + require negotiation.
  await counterSuite(context, provider.factory);
  summary = { status: "passed" };
} finally {
  // In actual application code, supply the evaluated outcome and retain both
  // its primary failure and this independent trusted cleanup receipt.
  const cleanup = await provider.close(summary);
}
```

The provider also exposes an exact compiled `selection` for direct use with
MirrorECMA's negotiated report runners. Its factory is single-use and admits the
worker only after MirrorECMA supplies required-match authority. Only a bounded
attestation is sent to Gate; private model configuration, transport, iterator,
expected state and trace coordinates never enter worker calls.

Ownership transfers when provider construction is called, including validation
failures. `close()` closes the owning session **and its original client**; use a
dedicated owner connection, not one managing unrelated sessions. It must run even
when negotiation fails before invoking the factory. No serialized handle,
reconnect, process adoption, or hosted-control-v2 fields are supported here.

Binding disposal closes the proxy and worker. Final provider cleanup joins that
disposal and Gate cleanup using an independent bounded budget. It seals further
admission, checks delayed factory continuations, and reports `confirmed`, `failed`
or `unconfirmed` separately from model conformance. Cleanup failures and remaining
resources are trusted evidence, not an agent-visible projection. The local
workflow and optional service compose this provider without duplicating admission logic.

## Legacy migration

Existing consumers may change their Gate-aware imports to:

```ts
import {
  evaluateSandboxed, createSandboxCompiledModel, sandboxDiagnosticFailures,
} from "mirrorgate-mirrorecma/legacy";
```

The existing facade plan, author callback, redacted result and bounded diagnostics
retain their shape. The implementation and manifest-validation/failure tests have
moved into this package. The destination MirrorECMA 2 cutover removes the old
Gate-specific source/exports and passes core/live validation. No forwarding
import from MirrorECMA to this package is introduced. Generic MBT consumers keep
importing `mirrorecma` alone. The integration peer contract accepts public
MirrorECMA 1.x/2.x APIs; publication remains separate from verified local delivery.

## Package checks

With compatible local public peer packages and development dependencies installed:

```bash
npm run build
npm test
MIRRORECMA_ROOT=/absolute/path/to/MirrorECMA node scripts/packed-consumer.mjs
MIRRORECMA_ROOT=/absolute/path/to/MirrorECMA \
MIRRORS_ROOT=/absolute/path/to/Mirrors \
MIRRORGATE_NODE_RUNTIME_ROOT=/approved/node-v24.15.0-linux-x64 \
node scripts/packed-consumer.mjs --sandbox
# Installed app, hosted/source/prebuilt/CLI and optional HTTP-service checks:
node scripts/installed-workflow.mjs --service
```

The packed consumer gate compiles ESM/TypeScript imports using only installed
package exports. Its sandbox tier uses the generated Counter binding, real
Mirrors replay and restricted Node workers to check correct/faulty implementations
through both the prepared provider and `/legacy` facade. A wrong model digest
is also rejected before any provider worker launches. A denied backend is a
failure, not a sandbox pass. This is prepared/control-v1 evidence; it does not
claim managed-agent authoring or optional evaluation-service delivery.

The copied Counter lock and generated binding in `test/fixtures` retain their
compiler-owned bytes from MirrorECMA's existing fixture. Do not hand-edit generated
output. The package's focused tests retain manifest bounds, private projection,
authoring output limits, diagnostic sink bounds, cancellation and failure paths.

## Broader cross-client smoke

This example retains MirrorECMA, generated bindings, full model files, trace
files, and reports on the evaluator host. Only public shim code, a sanitized
port manifest, and the submitted adapter/SUT are placed in the worker artifact.
It never mounts the evaluator repository into the sandbox.

The Counter integration drives both Node and Rust through a generated async
port proxy. It verifies correct and deliberately faulty increments. Queue is a
later fixture and is not part of this first advertised profile.

MirrorGate's public Node worker SDK exports the manifest sanitizer and the
type-directed bridge between generated arrays and native Set/Map values.
Input projections and expected state stay with the trusted generated binding.
Only cancellation, not private replay coordinates/configuration, is forwarded
into worker context.

Run from the MirrorGate root after building the native worker:

```bash
bash scripts/build.sh
MIRRORECMA_ROOT=/absolute/path/to/MirrorECMA \
MIRRORCPP_ROOT=/absolute/path/to/MirrorCPP \
MIRRORS_ROOT=/absolute/path/to/Mirrors \
APALACHE_MC=/absolute/path/to/apalache-mc \
node integrations/mirrorecma/smoke.mjs
```

The wrapper runs the shared required-backend gate, including the independent
MirrorCPP facade rather than treating one TypeScript demonstration as SO12.
The MirrorECMA checkout must include report/async APIs and generated async
Counter artifacts; these are coordinated development dependencies, not a
claim that an older published client already includes them. Install its locked
dependencies and build the Mirrors executable first. The integration compiles
the client and consumes a packed Gate SDK from an isolated temporary package
tree; it does not modify client sources.

The smoke uses known public development models copied to an evaluator-only
temporary directory to verify the runtime handoff. Those models are not claimed
to be previously unseen tests. Independent private evaluation requires separately
held cases, a frozen submission, and an explicit result-disclosure policy.

The public manifest exporter strips model names/paths, wire labels, projections,
invariants, provenance, and other non-port fields. The caller must provide a
verified source descriptor/lock and expected semantic identity. Sanitization
does not cryptographically authenticate an arbitrary supplied digest or determine
whether a public field's contents reveal a private fact.

Focused extraction evidence is recorded in [VALIDATION.md](VALIDATION.md).

Dated workflow friction and proposed changes are tracked in the
[restricted workflow follow-ups](../../docs/restricted-workflow-followups.md).
Those items remain unimplemented until their owning code and gates land.
