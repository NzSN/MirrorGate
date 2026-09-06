# Rust worker SDK

Status: implemented native `rust-v1` shim for the shared
[port/v1 contract](protocol-v1.md). Protocol conformance does not establish
sandbox isolation. A raw executable has its launching user's filesystem and
process permissions; use the trusted supervisor to run a submission.

## Build and launch

The root Rust toolchain pin is 1.96.0. Dependencies are pinned exactly in
`runtimes/rust/Cargo.toml` and transitively in `Cargo.lock`.

```bash
cargo build --manifest-path runtimes/rust/Cargo.toml --locked --offline
cargo test --manifest-path runtimes/rust/Cargo.toml --locked --offline
runtimes/rust/target/debug/mirrorgate-counter-worker \
  --manifest conformance/manifests/counter.json
```

`--offline` requires the locked dependencies to be cached; a first dependency
fetch belongs in the trusted toolchain preparation step. On a host where the
installed `stable` alias reports exactly `rustc 1.96.0` and `cargo 1.96.0`, a
scoped `RUSTUP_TOOLCHAIN=stable` override can use that installation without
altering the toolchain pin or installing another copy.

Copy the executable and public manifest into the frozen submission artifact.
The trusted evaluator must admit that artifact, its public manifest, runtime,
and sandbox policy before launching any submitted native code. Launch it inside
the sandbox from its first instruction. The subsequent protocol handshake is
an additional identity and lifecycle check; it is not a prerequisite that a
native executable can enforce before its own startup code runs.

Inside an execution sandbox the command is, for example:

```text
/artifact/mirrorgate-counter-worker --manifest /artifact/counter.json
```

The Linux binary uses the platform C runtime. Its required dynamic loader and
libraries must be in the approved runtime mounts. It does not need Cargo, Rust
source, a complete Mirrors client, private models, or network access at runtime.
Build scripts and Cargo compilation execute in the separate build environment.

Add `--faulty` only to exercise the deliberately broken Counter fixture: its
actual increment subtracts one from the requested stride. The observer reads
that Counter's actual count, so `Tick(2)` reports `1`. The normal Counter uses
`num_bigint::BigInt` for both state and inputs, preserving values beyond 64 bits
and JavaScript's safe integer range. Effective value size remains subject to
the protocol frame, depth, and node budgets.

## Native adapter seam

The library `mirrorgate_worker` is reusable; the protocol loop is independent of
Counter. Implement `Adapter` and pass a deferred factory to `run_worker`:

```rust,ignore
let manifest = Manifest::load(public_manifest_path)?;
run_worker(manifest, "rust-v1", move |manifest, cancellation| {
    cancellation.check()?;
    // Construct the real SUT here, after admitted hello and create.
    Ok(Box::new(MyAdapter::new(manifest)?))
})?;
```

This deferral applies to the factory managed by the SDK. The submitted native
executable already contains application code: linked libraries, startup
constructors, pre-`main` initialization, or code before `run_worker` can execute
before `hello` or `create`. A factory closure can also capture a SUT constructed
earlier. The SDK cannot constrain such code. Adapter authors must defer managed
SUT construction to the factory, and the trusted launcher must confine the
whole native executable independently of whether it follows that convention.

The trait methods are:

```rust,ignore
fn invoke(&mut self, action: &str, inputs: &serde_json::Value,
          cancellation: &CancellationToken) -> Result<(), WorkerError>;
fn observe(&mut self, cancellation: &CancellationToken)
           -> Result<serde_json::Value, WorkerError>;
fn dispose(&mut self, cancellation: &CancellationToken)
           -> Result<(), WorkerError>;
```

The shared manifest and value validator check exact action/input/observation
IDs, full portable type semantics, and all bounds before dispatch or output.
The adapter receives validated portable values and converts them into native
application types. A generated Rust port can implement this dispatch boundary;
model generation remains owned by Mirrors. `invoke` and `dispose` use Rust's
unit return type, so they cannot accidentally return an observation payload.

All integers use canonical tagged decimal strings on the wire. The parser also
validates ordinary JSON number tokens using exact decimal arithmetic before
Serde sees them: `1.0` and `10e-1` normalize to `1`, while rounded fractions,
unsafe integers, and nonintegral values are rejected. Duplicate JSON object
keys are rejected during parsing before conversion to `serde_json::Value`.
Sets and maps reject semantic duplicates without losing sequence, tuple,
record, or variant distinctions. Tagged-looking record keys remain ordinary
record keys when required by their declared type.

## Lifecycle and cancellation

Manifest validation and a successful `hello` precede the SDK-managed factory
invocation. `hello` does not invoke that factory; `create` invokes it without
automatically initializing the resulting adapter. The evaluator
must invoke a declared initializer, observe, and then alternate action/reset
invocation with observation. Any callback or validation failure poisons the
session, leaving only disposal available.

An adapter thread owns the SUT and serializes callbacks. A bounded control queue
keeps stdin reception responsive while callbacks run. Cancellation sets the
shared cooperative token and retires the pending request with `CANCELLED` before
acknowledging the cancel request. A late callback completion is ignored. Disposal
is queued behind that callback, so cleanup cannot race application mutation.
Callbacks performing long work must check the token; cancellation acknowledgement
does not prove external effects have stopped. The supervisor enforces hard
termination deadlines for noncooperative callbacks or pending disposal.

Disposal consumes the owned adapter before calling its cleanup, preventing a
second cleanup even if the first fails or panics. Panics are reported as bounded
`APPLICATION` failures; process aborts or resource exhaustion still require
supervisor handling. Protocol stdout is reserved for the shim. Application logs
belong on stderr and remain untrusted, bounded supervisor output.

## Verification

`tests/shared_vectors.rs` consumes the same
[JSONL conformance corpus](../conformance/vectors.jsonl) as the Python and Node
implementations. `tests/lifecycle.rs` drives actual worker processes to check:

- Correct and faulty Counter observations, large integers, and reset.
- No SDK-managed factory invocation before admitted `create` or for
  preconstruction disposal; this does not test or prohibit arbitrary native
  startup code.
- Input rejection before callbacks and observation enforcement after invocation.
- Callback errors/panics, invalid and excessive observations, and poisoned state.
- Responsive cancellation, response order, late-return suppression, and cleanup
  after callback quiescence.
- Terminal cleanup failure, duplicate JSON keys, and reused request IDs.

The separate `mirrorgate-sdk-fixture` binary is a controlled SDK test fixture
with injected callback failures and audit events. It is not the application
worker or a production submission template.
