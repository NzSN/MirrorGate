# Native MirrorCPP orchestration acceptance

This integration is a trusted C++ model-facing facade over the public
MirrorGate C++ SDK and public MirrorCPP API. It prepares a Gate session before
model negotiation, then authorizes and acquires the worker only from
MirrorCPP's validated post-match adapter factory. The generated Counter binding
projects model inputs into public port operations; the worker never receives a
raw state-computer request, expected state, model configuration, or trace path.

The Counter driver is an acceptance fixture rather than a released generic
MirrorCPP package surface. `orchestration.hpp` exposes the reusable local facade
seam for another generated binding. It has no MirrorECMA dependency and embeds
no Node evaluator. Node is present only when the selected worker runtime is
`node-v1`; the same C++ facade also drives the native Rust worker.

Run the required local matrix with pinned tools already on `PATH`:

```bash
MIRRORCPP_ROOT=/absolute/path/to/MirrorCPP \
MIRRORECMA_ROOT=/absolute/path/to/MirrorECMA \
MIRRORS_ROOT=/absolute/path/to/Mirrors \
APALACHE_MC=/absolute/path/to/apalache-mc \
bash conformance/control-v1/run
```

The gate fails on missing checkouts, generated artifacts, compilers, runtime
trees, Mirrors, Apalache, or Bubblewrap enforcement. It runs correct,
deliberately faulty, and wrong-model-digest Counter cases across both facades ×
Node/Rust × owned/attached, through both checked-in traces and live `register`
generation. Faulty cases must produce a real Mirrors `step_mismatch` in which
the honest observation trails the expected count by one. Wrong-digest C++ cases
require zero binding calls, zero worker acquisitions, and zero `worker.started`
events. Each row requires a terminal Gate cleanup result with no remaining
resources and emits one JSONL evidence record. A sidecar manifest records the
packed SDK digest, dirty workspace identities, toolchains, runtime tree, and
native binaries used by the run.
