# Shared worker protocol and runtime shims

Status: proposed protocol design. Exact schema, transport, limits, and version
strings are not frozen by this document.

## Scope

The worker protocol crosses the isolation boundary. It carries declared port
operations and actual observations, while the existing Mirrors protocol remains
inside trusted evaluation. Private specification selection, invariant choices,
expected state, and raw trace/configuration payloads are outside its scope.

A shared protocol makes workers interchangeable at the semantic interface. It
does not require the same native method syntax, object layout, or binary ABI.

## Identity and admission

Before invoking application code, the evaluator and supervisor should verify:

- the worker-protocol version and supported capabilities;
- the public semantic interface identity;
- the selected language/runtime profile and submission artifact;
- the public operation/type manifest allowed by the evaluator;
- the trusted sandbox policy and requested resource profile.

Private model identity is recorded separately by the evaluator. An interface
digest identifies the agreed port semantics, not every private model behavior
or invariant used to test it. Worker-declared capabilities are checked against
trusted requirements; they cannot grant the worker additional privileges.

## Logical messages

These names describe responsibilities rather than final wire operation names:

| Operation | Direction | Purpose |
| --- | --- | --- |
| Handshake | Both | Correlate protocol, public interface, runtime, and capabilities |
| Create | Evaluator to worker | Construct a fresh local binding/SUT after admission |
| Initialize / invoke action | Evaluator to worker | Execute one declared operation with only its public inputs |
| Observe | Evaluator to worker | Read the complete declared observation after the action finishes |
| Result / failure | Worker to evaluator | Return operation completion, observations, or bounded application failure |
| Cancel | Evaluator to worker | Request cancellation of the current operation |
| Dispose | Evaluator to worker | Release the local SUT and owned resources |

The supervisor additionally controls process launch and forced termination.
Those controls do not need to be expressible as worker-granted capabilities.

Every request/response needs correlation and a defined terminal outcome.
Version 1 should serialize operations per worker to retain deterministic
action/observation ordering. Define how handshake errors, duplicate responses,
unknown IDs, unsolicited messages, and responses after cancellation terminate
the session. Cancellation and process teardown must work even when an action is
pending; whether Create is a wire operation or part of the launch handshake is
an open schema decision.

## Values and generated proxies

Use the public model-interface type/value semantics maintained by Mirrors.
Integers require lossless representation; sets, sequences, tuples, records,
maps, variants, and null must retain their distinctions. A final encoding must
define canonicalization, malformed-value rejection, duplicate handling, and
resource bounds before shims claim compatibility.

The current cross-language portable profile is narrower than every individual
client's capabilities: for example, it restricts map key/path support and does
not include opaque values. A worker must advertise and validate support rather
than silently truncate or reinterpret an unsupported value. The authoritative
baseline is the
[generated-interface specification](https://github.com/NzSN/Mirrors/blob/main/Docs/generated-model-interface-spec.md),
not a copied type table maintained independently in MirrorGate.

A trusted generated proxy implements the public port by sending these messages.
The language shim converts the serialized public values to native input types,
calls the submitted implementation, and converts observations back. All shims
preserve stable action/input/observation IDs and obey the same lifecycle rules.

Start with one shared value contract and generated or small native codecs.
JSONL over a supervisor-supplied channel is a candidate transport; another
framed transport can implement the same logical interface. The Mirrors JSONL
frame bound must not be silently assumed to define this new protocol's limits.

## Lifecycle and failures

An action completes only when the implementation has finished the work that its
observer must see. The evaluator requests observation afterward; it never
substitutes a predicted model value for missing implementation output.

Failures, cancellation, and invalid observations must leave the binding in a
defined terminal/poisoned state. Specify at-most-once disposal and preserve the
original failure when cleanup also fails. Do not retry a timed-out mutation
automatically: its side effects may already have happened.

The trusted evaluator validates every returned shape and message before using
it. Bound stderr/log output separately from the protocol channel; worker output
must not be able to impersonate evaluator messages. Private mismatch reports
are not replies to worker operations.

## Shared conformance suite

Run the same vectors against each shim: successful operation/observation
sequences, exact integers, collection semantics, initialization/reset,
malformed inputs, unsupported capabilities, correlation errors, callback
failures, cancellation, crash/EOF, disposal, and output limits.

At least two languages are needed to validate the claimed shared design. Begin
with Node and one native language, then extend the matrix. This protocol and
its conformance corpus should be versioned independently of SDK releases and
semantic interface digests.

Related: [architecture](architecture.md), [isolation](blind-validation.md),
and [implementation plan](implementation-plan.md).
