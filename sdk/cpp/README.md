# MirrorGate C++ control SDK

This library is the native control-v1 facade and managed worker-v1 port client.
It does not contain Mirrors replay, expected-state comparison, or orchestration
policy. The MirrorGate controller remains the single owner of session phases,
preparation, authorization, worker admission, process termination, and cleanup.

The public headers are:

- `mirrorgate/control.hpp`: owned stdio and attached filesystem-Unix control,
  connection-bound sessions and operations, event correlation, and status.
- `mirrorgate/managed_worker.hpp`: one-use worker attachment, worker-v1
  hello/create/invoke/observe/cancel interpretation, and type-directed native
  values for the portable v1 profile.
- `mirrorgate/json.hpp`: bounded duplicate-aware strict JSON used by both
  channels. Control and worker limits remain distinct.

`ControlClient::launch` starts only the evaluator-supplied approved command and
owns that control child. `ControlClient::connect` verifies the filesystem socket
and parent ownership/modes and never terminates the attached daemon. A
`ManagedWorker` is created only from a `worker.acquire` descriptor belonging to
its `Session`. Its close path first calls `worker.release`; it sends one
cooperative worker `dispose` only when Gate returns
`dispose-then-terminate`, and otherwise waits for Gate-owned termination.

Minimal native flow:

```cpp
auto control = mirrorgate::ControlClient::launch(
    {"/approved/bin/mirrorgate", "control", "--stdio",
     "--policy-file", "/trusted/control-policy.json"},
    {"control.local-stdio-v1", "submission.prebuilt-v1",
     "execution.compiled-verify-v1", "worker.managed-unix-v1",
     "worker.node-v1", "backend.linux-bubblewrap-v1",
     "cleanup.bounded-attempt-v1"});

auto session = control->open_session({
    {"policyId", "approved-policy"},
    {"submission", {{"kind", "prebuilt"},
                    {"input", {{"rootId", "submission"},
                               {"relativePath", "counter"}}}}},
    {"runtime", "node-v1"},
    {"manifestJson", exact_manifest_json}});
auto prepared = session.prepare().wait();
auto authorization = session.authorize(
    1, prepared.at("challenge"), validated_required_match_attestation);
auto worker = mirrorgate::ManagedWorker::attach(
    session, session.acquire_worker(authorization),
    mirrorgate::Manifest::parse(exact_manifest_json), "node-v1");

worker->invoke("Initialize", {});
auto initial = worker->observe();
worker->invoke("Tick", {{"Stride", mirrorgate::NativeValue::bigint("2")}});
auto actual = worker->observe();
worker->close();
session.close().wait();
auto close_receipt = control->close_with_result();
if (!close_receipt.transport_closed ||
    !close_receipt.process_shutdown_confirmed()) {
  throw std::runtime_error("control shutdown was not confirmed");
}
```

`close_with_result()` is additive to the existing idempotent, `noexcept`
`close()`. For owned stdio it reports whether the child was reaped after normal
exit, SIGTERM, or SIGKILL within the bounded close path. Attached Unix clients
report a closed connection with `process_state = not_owned`. Custom transports
that do not implement a receipt remain `unconfirmed`, so orchestration facades
can fail closed without replacing an earlier model or application failure.

The C++ API uses nlohmann/json exactly 3.11.3 under its MIT license. It is a
build dependency, not a MirrorCPP or runtime dependency. CMake first accepts an
exact installed package. An offline toolchain may instead set
`MIRRORGATE_NLOHMANN_JSON_INCLUDE_DIR` to a provisioned 3.11.3 include root.
The build never downloads or vendors the dependency implicitly.

Run the standalone gate with:

```bash
MIRRORGATE_NLOHMANN_JSON_INCLUDE_DIR=/path/to/nlohmann-3.11.3/single_include \
  bash scripts/test-control-cpp.sh
```

Set `MIRRORGATE_CPP_REAL_CONTROL=1` to add the real Linux/Bubblewrap controller
tests. Those tests require a working unprivileged Bubblewrap backend and the
pinned runtime roots used by the repository's full gate.
