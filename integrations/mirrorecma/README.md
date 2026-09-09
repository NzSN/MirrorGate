# Trusted MirrorECMA evaluator integration

The accepted [implementation boundary](../../../MirrorECMA/docs/implementation-boundary-design.md)
makes this optional integration the planned home for Gate-aware evaluation
composition. MirrorECMA itself keeps generic MBT against caller-supplied
implementations; the coordinating agent requests authoring directly from Gate.
The integration will supply a deferred implementation factory/proxy using public
APIs from both libraries and retain Gate ownership through admission and cleanup.
Current helpers and smoke commands below are existing behavior, not evidence of
completed facade extraction or a supported new integration package. See AH8 in
the [hosting task ledger](../../docs/agent-hosting-tasks.md).

The planned [reusable harness](../../../MirrorECMA/docs/mbt-harness-design.md)
supports source tests, CLI, and an optional
[evaluation-service wrapper](../../docs/evaluation-service-design.md) under this
integration. Applications supply approved suite modules. Service access is a
whole-evaluation interface, separate from public-port calls to the implementation;
no service package/endpoint is implemented by the existing smoke wrapper below.

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
