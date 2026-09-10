# Shared worker protocol and runtime shims

Status: v1 wire shapes, values, limits, and lifecycle are frozen in
[port protocol v1](protocol-v1.md). The [schemas](../protocol/README.md),
[Python validator](../supervisor/mirrorgate/protocol.py), and
[shared vectors](../conformance/vectors.jsonl) implement its shape/value rules.
Worker and backend verification is recorded separately in the implementation plan.

## Scope and ownership

The worker protocol crosses the isolation boundary. It carries declared port
operations and actual observations. The existing Mirrors protocol remains in
trusted evaluation; private specification selection, invariant choices, expected
states, and raw trace/configuration payloads never belong on the worker channel.

The common protocol gives language shims the same semantic interface. It does
not impose the same native method syntax, object layout, or binary ABI. Model
resolution and generation remain in Mirrors. MirrorGate consumes a sanitized
public manifest and keeps policy independent of each client/runtime language.

## Identity and admission

The trusted evaluator selects the public interface, submission artifact, runtime,
and sandbox policy. A `mirrorgate.port/v1` manifest contains the interface digest,
initializers, actions, inputs, observations, and portable types. Unknown fields
are rejected. The shim validates it before loading submission-controlled code;
the adapter factory and SUT constructor run only on admitted `create`.

The public digest is supplied by the evaluator. The worker cannot reconstruct
an original Mirrors descriptor digest from a sanitized artifact. Record private
model identity separately: public interface identity does not identify hidden
invariants or evaluation traces. Worker declarations cannot grant privileges.

## Logical operations

| Wire operation | Purpose |
| --- | --- |
| `hello` | Agree on v1, public interface digest, and runtime |
| `create` | Construct a fresh binding/SUT after admission |
| `invoke` | Execute a declared initializer or action with its public inputs |
| `observe` | Read complete declared observations after the operation finishes |
| `cancel` | Request cooperative cancellation of the pending operation |
| `dispose` | Release owned resources at most once |

Requests use strictly increasing positive safe-integer IDs and one pending
ordinary operation. Cancellation is the only concurrent request. Its response
order is the original request's `CANCELLED` failure, then the cancellation's
success. Cancellation poisons the binding and does not prove callbacks or
external effects have stopped. The supervisor owns deadlines and forced teardown.

An initializer must precede the first observation/action. Every invocation must
be followed by exactly one observation. A declared initializer can reset the
application after a prior observation. Failure permits only disposal; malformed
framing/correlation terminates the channel. Cleanup cannot race a still-running
cancelled callback and must preserve the original failure.

## Values, framing, and generated proxies

The portable v1 profile uses Mirrors ModelType vocabulary and ITF value
semantics: exact decimal integers, booleans, strings, null, sets, sequences,
tuples, closed records, string-key maps, and tagged variants. Reject opaque
values and non-string map keys before invoking the SUT. Sets reject semantic
duplicates, including nested sets/maps whose serialized order differs.

The authoritative baseline is the
[generated-interface specification](https://github.com/NzSN/Mirrors/blob/main/Docs/generated-model-interface-spec.md).
MirrorGate's [v1 contract](protocol-v1.md) records its narrower supported profile
and limits. Protocol version, public semantic digest, and runtime version remain
separate identities.

Transport is UTF-8 JSONL with a required LF terminator and 65,535-byte payload
limit. The public manifest has a separate 262,144-byte limit. Duplicate object
keys, invalid Unicode, fractional/unsafe numeric tokens, unknown fields,
over-budget depth/nodes, and invalid value shapes are rejected.

A trusted proxy implements the generated public port by sending these messages.
It checks every worker reply's shape, correlation, identity, and typed result.
The language shim converts values, invokes the real implementation, and returns
observations. It never receives expected model state or raw `StateComputer`
arguments. Stderr is bounded separately and carries no trusted verdicts.

## Shared conformance

Use identical positive/negative vectors across validators and workers, then
exercise lifecycle, reset, cancellation, application failure, crash/EOF,
malformed output, and cleanup. Node and Rust are the first worker profiles.
The reference corpus is protocol acceptance evidence; actual sandbox-denial
checks provide separate isolation evidence. Neither proves observation fidelity.

Related: [v1 contract](protocol-v1.md), [architecture](architecture.md),
[isolation](sandbox/blind-validation.md), and [implementation plan](implementation-plan.md).
