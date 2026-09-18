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
