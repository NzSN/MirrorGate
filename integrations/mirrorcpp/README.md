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

The facade retains immutable `SandboxEvidence::primary_failure` and
`cleanup_failure` records. It captures the SDK worker snapshot before generated
disposal runs and restores a normalized local adapter failure to its trusted
Gate code. Worker-authored codes remain diagnostic values; their public code
is `mirrorgate.worker_application`. Ordinary Mirrors negotiation and
`step_mismatch` retain their original kind, expected/actual states and hints.
A successful body followed by failed cleanup returns failure; an earlier body
failure wins and the cleanup record remains available separately. Equal human
messages from ordinary adapters do not acquire Gate authority.

On the selected remote WSL host, the replay-only failure gate requires no model
checker or model service:

```bash
MIRRORCPP_ROOT=/absolute/path/to/MirrorCPP \
MIRRORS_ROOT=/absolute/path/to/Mirrors \
MIRRORCPP_DEPENDENCY_CACHE=/prepared/MirrorCPP/build/_deps \
MIRRORGATE_NODE_RUNTIME_ROOT=/pinned/node/root \
bash conformance/control-v1/run-cpp-failures
```

It exercises real Gate preparation, authorization, Bubblewrap workers, generated
Counter callbacks and the public MirrorCPP runner for wrong-ID replies,
disconnects, application errors, forged control/deadline codes, deadlines,
cancellation and cleanup failure. Both owned and attached control modes run;
attached rows retain an independent authorized worker and prove it still works
after facade cleanup. Correct, faulty and negotiation controls use checked-in
traces. A failing approved source-build command exercises a real `BUILD_FAILED`
reply; an attached-only denied-mount control exercises backend admission while
the independent worker remains live through its pinned mount. The standalone
C++ SDK and close-receipt tests additionally cover local
preconditions, encoding, owned snapshot lifetime, equal messages, primary
versus cleanup precedence and unconfirmed process shutdown. Backend denial is
exercised in attached mode; it does not claim every OS/backend failure profile.

SO7 requires a distinct combined worker transport/protocol failure family. The
two actual broker-fault rows inject an uncorrelated worker response ID. Gate's
broker rejects that response before relaying it, so the SDK observes its own
`CONTROL_DISCONNECTED` transport failure with an empty original stage and the
local invoke/observe operation. The facade must preserve that observable code,
origin and context. Evidence records the injected wrong-ID scenario separately
in `faultInjection`; it does not infer a finer broker cause from message text
or an exit code. Direct SDK tests that receive invalid responses without the
broker retain their `worker_protocol` classification. A finer authenticated
broker diagnostic channel is an optional future change, outside this repair.

The deliberate `error-cleanup` row must return its original structured cleanup
failure with no body-failure snapshot. It can report `cleanup: "failed"`; it
still requires confirmed control shutdown, external process-absence evidence
and continued operation of the other attached session. All other rows require
successful cleanup. Evidence serializes the actual cleanup outcome.

By default the script builds in its owned temporary directory. For diagnostic
iterations, `MIRRORGATE_CPP_FAILURE_BUILD_DIR` may name a new absolute private
build directory in the validation namespace. Never share it between concurrent
invocations or use an old qualification build. The harness checks an existing
cache's source and explicit `CXX` executable identity, configures normally and
keeps bounded parallelism; changed files rebuild through CMake dependencies.
The exit trap removes only its temporary submissions/socket workspace and
never removes this externally selected build directory.
