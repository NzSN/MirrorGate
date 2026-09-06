# Port protocol v1

Status: the first implementation contract. `protocol/*.schema.json`, the Python
validator, and `conformance/vectors.jsonl` implement the shape/value rules below.
Passing protocol tests is independent of the selected sandbox's isolation tests.

## Ownership and admission

The trusted evaluator publishes one `mirrorgate.port/v1` manifest. It contains
only `schema`, `interfaceDigest`, `initializers`, `actions`, and `observations`.
Operations contain `id` and `inputs`; inputs and observations contain `id` and
`type`. There must be at least one initializer and observation. Empty action and
input lists are permitted. Initializer/action IDs are unique together; input
IDs are unique within their operation; observation IDs are unique.

IDs and runtime names use `[A-Za-z][A-Za-z0-9_.-]{0,127}`. The initial runtimes
are `node-v1` and `rust-v1`. The digest is 64 lowercase hexadecimal characters,
provided and checked by the evaluator. It is the agreed public interface
identity: the worker cannot reconstruct the original Mirrors descriptor digest
from this intentionally sanitized artifact. MirrorGate neither derives nor
authenticates this identity by hashing the sanitized manifest.

Private specification paths, wire actions, projections, invariants, expected
states, configuration, and evaluator credentials never belong in this artifact.
Unknown fields are rejected throughout the manifest and protocol. A trusted
exporter must review field contents too: a schema cannot prove that a public
string does not disclose a private fact. Manifest bytes are frozen before launch;
the trusted launcher controls the manifest path, runtime, and execution policy.

## Framing and resource bounds

Messages are UTF-8 JSON objects followed by exactly one LF on a dedicated
protocol stream. The maximum payload is 65,535 bytes excluding LF. Reject an
unterminated final frame, empty lines, literal CR bytes, invalid UTF-8, duplicate
object keys, nonfinite numbers, lone Unicode surrogates, and invalid JSON.
Escaped carriage returns inside strings remain valid. JSON object/array nesting
is at most 96 (root depth zero); total JSON nodes are at most 8,192 (a scalar or
container counts as one; object keys are not additional nodes). Typed values
and type expressions additionally have semantic depth at most 32 (root zero).
All JSON numeric tokens must represent integral safe integers; model integers
use the tagged string representation below. Implementations must bound input
before application dispatch and output before writing a frame.

A manifest is a single JSON object of at most 262,144 UTF-8 bytes with the same
strict JSON/nesting/node rules. Its trailing whitespace is allowed. Public record
field names and variant tags are nonempty Unicode scalar strings of at most
128 UTF-8 bytes. Error messages are at most 1,024 UTF-8 bytes. Neither messages
nor stderr are an authority for evaluator instructions or verdicts.

## Requests and replies

Every request has `v: 1`, `id`, and `op`. IDs are strictly increasing positive
JSON integers no greater than 9,007,199,254,740,991. There is one pending ordinary
request. The only request permitted while it is pending is `cancel`.

| `op` | Additional required fields | Successful `result` |
| --- | --- | --- |
| `hello` | `interfaceDigest`, `runtime` | `{interfaceDigest, runtime}` |
| `create` | none | `null` |
| `invoke` | `action`, `inputs` | `null` |
| `observe` | none | exact observation-ID object |
| `dispose` | none | `null` |
| `cancel` | `requestId` | `null` |

`inputs` is an object keyed by the selected operation's stable input IDs.
Its fields and observed fields must exactly match the public manifest. No raw
Mirrors state, initial model snapshot, predicted observation, or trace metadata
is sent to the worker.

Success is exactly `{v:1,id,ok:true,result}`. Failure is exactly
`{v:1,id,ok:false,error:{code,message}}`; code uses `[A-Z][A-Z0-9_]{0,63}`.
The trusted caller additionally checks the reply ID and operation-specific
result shape; syntactic response validity alone is insufficient.

Stable errors are `FRAME`, `LIMIT`, `SCHEMA`, `VALUE`, `HANDSHAKE`, `LIFECYCLE`,
`APPLICATION`, and `CANCELLED`. Application failures must not be mistaken for a
model mismatch. The worker must not retry a failed or interrupted mutation.

## Lifecycle, cancellation, and teardown

The successful transition sequence is:

```text
awaitHello --hello--> awaitCreate --create--> needInitializer
needInitializer --invoke initializer--> needObserve
needObserve --observe--> readyAction
readyAction --invoke action OR initializer(reset)--> needObserve
```

The trusted evaluator validates admission before launching submitted code, and
the sandbox confines the complete worker executable from its first instruction.
The Node shim validates the manifest and defers submission-module import until
`create`. A statically linked native artifact can execute loader/pre-main code
before its SDK starts; the Rust guarantee covers its SDK-managed adapter factory,
not arbitrary native startup code. That managed factory runs only for admitted
`create`, after a successful handshake. `create` itself does not initialize the application.
Each successful invocation requires exactly one observation before another
operation. A reset is a declared initializer invoked from `readyAction`.

After hello (including a failed handshake), `dispose` is permitted from every
nonpending state, once. A failure poisons the binding; only disposal remains.
Disposal invokes owned cleanup at most once and closes the lifecycle even if
cleanup fails. A preconstruction disposal does not instantiate the SUT.

For a pending operation `i`, valid cancellation `j > i` targets `requestId:i`.
The worker emits the terminal response `i` with `CANCELLED` **first**, followed
by successful cancel response `j` with `null`. It enters the poisoned state and
ignores any eventual operation return; no observation or continuation follows.
The shim requests cooperative cancellation. This acknowledgement does not prove
callbacks or external effects have stopped; the supervisor owns deadline-based
termination. Cleanup must not race a still-running application callback; wait
for quiescence or let the supervisor terminate it. Pending dispose is not
cancellable: the supervisor terminates it at its cleanup deadline.

Malformed framing/JSON/request shapes, duplicate/decreasing IDs, ordinary
pipelining, and a cancel targeting the wrong pending ID terminate the channel.
A structured response is not required for these uncorrelatable violations.
An idle cancel or ordinary operation in the wrong state emits `LIFECYCLE` and
poisons. A hello identity/runtime mismatch emits `HANDSHAKE` and poisons.
Invalid typed values emit `VALUE`; callback failures emit `APPLICATION`.
Unexpected EOF, unsolicited/duplicate replies, wrong reply IDs, or invalid
operation results are terminal failures at the trusted caller. Preserve the
original failure when disposal/termination also fails.

## Portable value profile

The type vocabulary and ITF distinctions follow Mirrors' generated model
interface contract, with the explicit restrictions below. Protocol version,
interface digest, and runtime profile are independent identities.
[The source contract record](../protocol/source-contract.json) pins the upstream
contract and reference encoder revisions used by this profile.

| ModelType | Wire value |
| --- | --- |
| `{kind:"int"}` | `{"#bigint":"123"}` |
| `bool`, `str`, `null` | JSON boolean, scalar string, null |
| `{kind:"seq",element:T}` | array of T values |
| `{kind:"set",element:T}` | `{"#set":[...]}` |
| `{kind:"tuple",elements:[...]}` | `{"#tup":[...]}` of exact arity |
| `{kind:"record",fields:[{wireName,type}]}` | closed object with exactly those names |
| `{kind:"map",key:{kind:"str"},value:T}` | `{"#map":[["key",value],...]}` |
| `{kind:"variant",cases:[{tag,payload}]}` | `{tag:"case",value:payload}` |

Big integers use canonical decimal `0|-?[1-9][0-9]*`; no leading zeros,
negative zero, plus sign, whitespace, decimal point, or bare JSON number.
Sets reject semantically duplicate members (including nested sets/maps with
different order). Map keys are unique strings. Sequence and tuple order matter;
set and map order do not. Closed-record key order does not matter. Record field
names remain ordinary names, even `#bigint` or `__proto__`: decoding is directed
by the declared type, never by guessing from a key.

Reject `opaqueItf`, non-string map keys, unknown type kinds, duplicate record
names/variant tags, and types or values exceeding limits before SUT invocation.
The profile does not claim every Mirrors target type is supported. Semantic
compatibility changes need a new profile/version plus shared regression vectors.

## Acceptance and extension

Run identical positive/negative frame, manifest, request, response, value, and
lifecycle fixtures against the Python validator and both workers. Exercise exact
integers, nested collections, reset, cancellation, poisoned state, malformed
input, excess output, crash/EOF, and at-most-once disposal. Supervisor isolation
tests separately attempt forbidden resource access in the actual backend.

The schemas describe structural constraints; duplicate JSON keys, semantic set
uniqueness, depth/budget accounting, and lifecycle/correlation require the
reference validators and conformance corpus. New optional fields cannot be
introduced silently because v1 rejects unknown fields.
