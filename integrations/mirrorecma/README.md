# Trusted MirrorECMA evaluator integration

This example retains MirrorECMA, generated bindings, full model files, trace
files, and reports on the evaluator host. Only public shim code, a sanitized
port manifest, and the submitted adapter/SUT are placed in the worker artifact.
It never mounts the evaluator repository into the sandbox.

The Counter integration drives both Node and Rust through a generated async
port proxy. It verifies correct and deliberately faulty increments. The queue
integration drives a real asynchronous filesystem SUT in the Node worker and
detects duplicate-handling failure using the same observation path.

MirrorGate's Node SDK represents sets/maps as native `Set`/`Map`; MirrorECMA's
dynamic binding uses arrays of elements/entries. `native-values.mjs` performs
that type-directed representation conversion. Input projections and expected
state stay with the trusted generated/dynamic binding. Only cancellation, not
private replay coordinates/configuration, is forwarded into worker context.

Run from the MirrorGate root after building the native worker:

```bash
bash scripts/build.sh
MIRRORECMA_ROOT=/absolute/path/to/MirrorECMA \
MIRRORS_ROOT=/absolute/path/to/Mirrors \
node integrations/mirrorecma/smoke.mjs
```

The MirrorECMA checkout must include report/async APIs, generated async Counter,
and queue artifacts; these are coordinated development dependencies, not a
claim that an older published client already includes them. Install its locked
dependencies and build the Mirrors executable first. The integration compiles
the client into ignored `.work/ecma`; it does not modify client sources.

The smoke uses known public development models copied to an evaluator-only
temporary directory to verify the runtime handoff. Those models are not claimed
to be previously unseen tests. Independent private evaluation requires separately
held cases, a frozen submission, and an explicit result-disclosure policy.

The public manifest exporter strips model names/paths, wire labels, projections,
invariants, provenance, and other non-port fields. The caller must provide a
verified source descriptor/lock and expected semantic identity. Sanitization
does not cryptographically authenticate an arbitrary supplied digest or determine
whether a public field's contents reveal a private fact.
