# Native MirrorRust orchestration acceptance

This integration composes the public MirrorRust negotiated runner with the
public MirrorGate Rust SDK. Gate preparation precedes Mirrors registration;
authorization and worker acquisition occur only in MirrorRust's validated
post-match adapter factory. Model configuration, expected state, trace paths,
and raw Mirrors messages remain in the trusted evaluator.

The Counter adapter is a reviewed acceptance fixture with target identity
`mirrorrust-counter-fixture-v1`. It embeds the compiler-produced Counter
contract and semantic digest, but it is not a generated `mirrorrust-v1`
binding and does not establish a general Rust emitter or application package.
The integration has no MirrorECMA or Node evaluator dependency. A Node process
is involved only when `node-v1` is selected as the sandboxed worker runtime.

`run_sandboxed` currently spawns a local Mirrors binary and uses its stdio
protocol. The generic caller supplies trace-generation options; the Counter
wrapper alone selects one trace and the Counter model's `View` operator. Remote
TCP/TLS Mirrors transports are outside this acceptance facade.

## Prepare and validate

Use compatible sibling checkouts of MirrorGate, MirrorRust and Mirrors. The
integration's Cargo manifest has an explicit sibling MirrorRust path dependency;
the acceptance runner checks that `MIRRORRUST_ROOT` names that actual dependency.
Run these commands from the MirrorGate root after preparing Rust 1.96 and the
Linux/Bubblewrap backend:

```sh
cargo fetch --manifest-path runtimes/rust/Cargo.toml --locked
cargo fetch --manifest-path sdk/rust/Cargo.toml --locked
cargo fetch --manifest-path integrations/mirrorrust/Cargo.toml --locked
cargo fetch --manifest-path ../MirrorRust/Cargo.toml --locked
bash scripts/test-control-rust.sh

MIRRORRUST_ROOT=/absolute/path/to/MirrorRust \
MIRRORS_ROOT=/absolute/path/to/Mirrors \
APALACHE_MC=/absolute/path/to/pinned/apalache-mc \
MIRRORGATE_NODE_RUNTIME_ROOT=/absolute/path/to/node-v24.15.0 \
bash conformance/control-v1/run-rust
```

Build the matching Mirrors executable first (`lake build mirror` in Mirrors).
The live gate requires the Apalache version recorded in that checker's
`tools/ci/versions.env`, Node 24.15 for Node-worker rows, and working non-root
namespaces. It fails if required tools or isolation are unavailable. Its Node
sentinel separately verifies that the Rust evaluator/Rust-worker row invokes no
Node runtime.

## Library boundary

[`run_sandboxed`](src/lib.rs) accepts reviewed model metadata, a sandbox plan and
a caller-supplied worker-to-`LocalBinding` factory. `run_counter_sandboxed` adds
only the fixture's Counter projection. Select `ReplayMode::Traces` with prepared
trace paths or `ReplayMode::Generate` with explicit trace-generation settings.
The Rust SDK starts or attaches to Gate; the integration owns model admission,
binding lifetime and cleanup-result composition.

Inspect both `SandboxOutcome.result` and its evidence. Successful model replay
does not replace the required worker/session cleanup and controller-close
receipts. A failed model match must never authorize or acquire the worker.

[Accepted results and limits](../../docs/rust-evaluator-sdk-status.md) include the
20-row live matrix and cross-facade comparison. The
[language guide](../../docs/client-language-support.md) describes the separate
Node and C++ integration paths. This documentation update does not rerun those
dated acceptance results or publish either crate.
