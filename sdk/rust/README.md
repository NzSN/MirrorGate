# MirrorGate Rust control SDK

`mirrorgate-sdk` is the trusted-side Rust client for MirrorGate control-v1 and
worker-v1. It launches an owned stdio controller or attaches to a filesystem
Unix socket, creates connection-bound sessions, and turns a one-use worker
reservation into a managed public-port worker.

The SDK does not implement Mirrors negotiation, replay, expected-state
comparison, or controller policy. A trusted evaluator must obtain a validated
model match before it calls `Session::authorize`. MirrorGate remains the sole
owner of session transitions, isolation, process supervision, and physical
cleanup.

## Supported profile

- Rust 1.96, edition 2024; crate version `0.1.0`, unpublished.
- Linux evaluator and Linux/Bubblewrap controller; other host platforms are not validated.
- Control-v2 managed hosting is not implemented by this Rust SDK.
- MirrorGate control-v1 over owned stdio or an attached filesystem Unix socket.
- MirrorGate worker-v1 over a controller-issued, one-use Unix attachment.
- Strict bounded JSONL with duplicate-key rejection, safe integer checks,
  bounded depth/node/frame limits, and type-directed portable values.
- Synchronous calls with explicit deadlines and optional cancellation.

The default feature set rejects JSON numbers outside the interoperable safe
integer profile. The `arbitrary-precision` feature enables serde_json's
arbitrary-precision representation while preserving the same protocol checks.
It does not widen control-v1 or worker-v1 numeric semantics.

## Minimal evaluator flow

```rust,no_run
use mirrorgate_sdk::{
    ClientOptions, ControlClient, ControllerCommand, InputRef, OpenSession,
    PublicManifest, RequiredMatchAttestation, Submission, WorkerCallOptions,
    WorkerOptions,
};
use std::{collections::BTreeMap, time::Duration};

# fn run() -> Result<(), Box<dyn std::error::Error>> {
let exact_manifest_json = std::fs::read_to_string("public-manifest.json")?;
let manifest = PublicManifest::from_exact_json(&exact_manifest_json)?;
let options = ClientOptions {
    required_capabilities: vec![
        "control.local-stdio-v1".into(),
        "submission.prebuilt-v1".into(),
        "execution.compiled-verify-v1".into(),
        "worker.managed-unix-v1".into(),
        "worker.node-v1".into(),
        "backend.linux-bubblewrap-v1".into(),
        "cleanup.bounded-attempt-v1".into(),
    ],
    ..ClientOptions::default()
};
let control = ControlClient::launch(
    ControllerCommand {
        program: "/approved/bin/mirrorgate".into(),
        args: vec![
            "control".into(),
            "--stdio".into(),
            "--policy-file".into(),
            "/trusted/control-policy.json".into(),
        ],
        cwd: None,
        env: None,
    },
    options,
)?;
let session = control.open_session(OpenSession {
    policy_id: "approved-policy".into(),
    submission: Submission::Prebuilt {
        input: InputRef {
            root_id: "submission".into(),
            relative_path: "counter".into(),
        },
    },
    runtime: "node-v1".into(),
    manifest_json: exact_manifest_json,
    limits: None,
    model_revision_id: None,
})?;

let prepared = session.prepare()?.wait(Duration::from_secs(30))?;
let prepared = match prepared {
    mirrorgate_sdk::OperationOutcome::Succeeded(value) => value,
    other => return Err(format!("prepare failed: {other:?}").into()),
};

// Construct this only from the evaluator's validated Mirrors match.
let attestation = RequiredMatchAttestation::matched(
    "reviewed-registration-id",
    manifest.interface_digest().to_owned(),
    "reviewed-adapter-id",
    "reviewed-implementation-id",
    "mirrors.state-computer/v1",
);
let authorization = session.authorize(
    prepared.prepared_revision,
    prepared.challenge,
    attestation,
)?;
let reservation = session.acquire_worker(authorization)?;
let mut worker = reservation.connect(manifest, "node-v1", WorkerOptions::default())?;

worker.invoke("Initialize", &BTreeMap::new(), WorkerCallOptions::default())?;
let actual = worker.observe(WorkerCallOptions::default())?;
// Compare `actual` through the trusted Mirrors client here.

let worker_report = worker.finish("normal");
if !worker_report.cleanup_confirmed() {
    return Err("worker cleanup was not confirmed".into());
}
let session_cleanup = session.close(None)?.wait(Duration::from_secs(5))?;
if !matches!(session_cleanup, mirrorgate_sdk::OperationOutcome::Succeeded(_)) {
    return Err("session cleanup failed".into());
}
let receipt = control.close();
if !receipt.transport_closed || !receipt.process_shutdown_confirmed() {
    return Err("control shutdown was not confirmed".into());
}
# Ok(())
# }
```

`ControlClient::connect_unix` attaches to a shared controller. It validates the
socket's canonical filesystem path, type, ownership, and permissions. Closing an
attached client closes only its connection; its close receipt reports
`ProcessCloseState::NotOwned` and never terminates the daemon.

## Ownership and failures

`ControlClient` is the single strong connection owner. `Session`, `Operation`,
and reservation handles are bound to that owner and session; stale or foreign
handles fail before transport dispatch. An authorization and worker reservation
are non-cloneable and one-use. Dropping an unused reservation performs a bounded
best-effort release.

After an uncertain transport or protocol result, the affected connection or
worker is poisoned and does not retry a mutation. `ManagedWorker::finish`
preserves the first worker failure in `primary` and separately reports the
authoritative cleanup outcome. Only `cleanup_confirmed()` proves that Gate
reported a closed session with no remaining resources. Drop cleanup is bounded
best effort and is not success evidence.

Owned control shutdown is also explicit: `ControlClient::close` returns a cached
receipt indicating whether the transport closed and whether the owned child was
reaped after normal exit, termination, or kill. Keep this receipt in evaluator
evidence. An attached connection has no child process to reap.

## Validation

From the MirrorGate repository root:

```bash
RUSTUP_TOOLCHAIN=1.96.0 cargo fmt --manifest-path sdk/rust/Cargo.toml -- --check
RUSTUP_TOOLCHAIN=1.96.0 cargo test --manifest-path sdk/rust/Cargo.toml --locked --offline
RUSTUP_TOOLCHAIN=1.96.0 cargo test --manifest-path sdk/rust/Cargo.toml --locked --offline --all-features
RUSTUP_TOOLCHAIN=1.96.0 cargo clippy --manifest-path sdk/rust/Cargo.toml --locked --offline --all-targets -- -D warnings
RUSTUP_TOOLCHAIN=1.96.0 cargo clippy --manifest-path sdk/rust/Cargo.toml --locked --offline --all-features --all-targets -- -D warnings
```

The tests consume the shared control-v1 and worker-v1 vector corpora and include
owned/attached transport, correlation, owner/session isolation, cancellation,
deadline, EOF, malformed reply, partial acquisition, and cleanup-precedence
regressions. Unix-socket tests require permission to bind and connect local
sockets; an environment that forbids that operation has not run those gates.
