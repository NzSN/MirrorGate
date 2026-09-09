# Local evaluation service protocol v1

Status: AH12 contract, 2026-09-09. This optional MirrorGate integration wraps the
[same R3 evaluation workflow](managed-workflow-design.md). It does not implement
model semantics, worker admission or resource cleanup. The service's tests must
separately distinguish real transport, shared-suite semantics and Gate isolation.

## Transport, authentication and ownership

The first profile is HTTP on **127.0.0.1 or ::1 only**, bound explicitly to an
operator-selected local port (zero may select an ephemeral port). No remote HTTP,
TLS, DNS-based host selection, reverse proxy trust or multi-host support is claimed.
All operations use `POST /v1/evaluations`, `Content-Type: application/json`, with
`Authorization: Bearer <64 lowercase hex digits>`. Configured tokens identify a
caller and its installed suite/implementation bindings. Tokens never enter replies,
progress, logs or callback arguments. Unknown tokens receive the same rejection.
The supplied proxy validates literal loopback URLs and never follows redirects.

The service retains Gate ownership inside its registered R3 callback. Network
clients cannot acquire/adopt Gate sessions. Request disconnect or cancellation of
an HTTP request does not cancel accepted evaluations; callers reconnect to this
same service epoch and inspect by run ID or start key. An explicit `cancel` or
run deadline aborts the callback signal; the callback's R3 implementation owns
resource cancellation and independent bounded cleanup.

Service restart loses this in-memory registry. A fresh random `serviceEpoch`
prevents old start keys from silently launching replacement evaluations. The
proxy never refreshes an epoch or retries a start automatically after transport
failure. Creating a new evaluation after restart is an explicit caller decision.

## Closed envelopes and operations

A request is exactly `{v: 1, requestId, op, args}`. `requestId`, `serviceEpoch`,
`startKey`, and `runId` are 128-bit lowercase hex handles. Suite and implementation
references are public identifiers (`[A-Za-z][A-Za-z0-9_.-]{0,127}`). Arguments:

| Operation | Required fields | Optional fields | Result |
| --- | --- | --- | --- |
| `hello` | none | none | `serviceEpoch`, `limits` |
| `start` | `serviceEpoch`, `startKey`, `suiteRef`, `implementationRef` | none | `{run}` |
| `get` | `serviceEpoch` and exactly one of `runId`/`startKey` | none | `{run}` |
| `cancel` | `serviceEpoch`, `runId` | none | `{run}` |

Every response is exactly `{v: 1, requestId, ok: true, result}` or
`{v: 1, requestId, ok: false, error: {code, message}}`. Protocol errors whose
request ID cannot be established use `requestId: null`. Public messages are fixed
service text, never exception strings. Authentication failure uses HTTP 401;
invalid input 400; wrong/unknown caller-bound handles or bindings 404; stale epoch
or conflicting start key 409; capacity/rate limits 429; unavailable service 503.

Bindings are installed functions keyed by `(suiteRef, implementationRef)` for each
caller. Requests cannot supply evaluator code, filenames, module paths, URLs,
credentials, model data or administrative Gate handles. The registered callback
receives only an abort signal and calls `evaluateImplementation(approvedPlan,
{signal})`; it returns that workflow's `EvaluationOutcome`. Source tests invoke
the same approved suite locally without deploying a service.

## Start correlation, admission and retention

`startKey` is generated before sending a start and retained by the caller. Reusing
it within the same caller/epoch with the same references returns the existing run;
changing either reference returns `START_CONFLICT`. Acceptance and insertion into
the caller registry happen before callback invocation. A lost reply is recovered
with `get(serviceEpoch,startKey)` or the identical start, never a fresh key.

Runs and start keys are caller-bound even when callers share a UID. Unknown and
foreign references have the same rejection. Terminal runs retain their public
record for `retentionMs`, subject to `retainedRuns`; eviction preserves a tombstone
for the original caller/start key until service shutdown. A repeated expired key
returns `RUN_EXPIRED`, never a new execution. The lifetime-start ceiling bounds
these tombstones and causes new starts to fail closed until an explicit restart.

Before accepting a run validate all request bounds, epoch, authorized binding,
rate and capacity. New starts do not displace active runs. A callback still pending
after its cleanup grace continues consuming active capacity, even if its public
record is marked unconfirmed. Neither cancellation acknowledgement nor a closed
HTTP socket proves callback cleanup.

## Run record and results

A public run is exactly `{runId, startKey, suiteRef, implementationRef, phase,
progress, result?, failure?}`. Phases are `queued`, `running`, `cancelling`,
`finished`, and `unconfirmed`. Progress is the closed bounded window
`{firstSeq,nextSeq,truncated,records:[{seq,message}]}`; sequences begin at one,
are contiguous, and `nextSeq = firstSeq + records.length`. Dropping old records
sets truncation. Only fixed service lifecycle messages are included.

A settled successful callback produces `finished` with exactly the workflow's
bounded `publicResult`, including its separately reported cleanup. The service
never exports the trusted receipt, raw report, expected state, trace coordinates
or diagnostics. A rejected callback produces `unconfirmed` with failure code
`WORKFLOW_FAILED`; one that does not settle by cancellation/deadline plus grace
uses `WORKFLOW_UNSETTLED`. These failures explicitly report cleanup `unconfirmed`
and do not fabricate an R3/model result. Public unconfirmed metadata is sticky;
late callback settlement releases capacity but does not rewrite its result.

`cancel` aborts once and immediately returns the current run (usually cancelling).
Callers poll `get` for settlement; the returned phase itself distinguishes an
acknowledgement from confirmed evaluation/cleanup. The evaluation deadline also
aborts once. Service shutdown rejects new work, aborts active callbacks, waits
one bounded grace and reports whether any callbacks remain unconfirmed. It never
kills a shared Gate daemon or the independent Mirrors server directly.

## Initial maximum limits

Operators may only tighten these positive integer ceilings:

| Key | Maximum |
| --- | ---: |
| `requestBytes` | 16,384 |
| `responseBytes` | 65,536 |
| `httpInFlight` | 32 |
| `activeRuns` | 16 |
| `activeRunsPerCaller` | 4 |
| `lifetimeStarts` | 4,096 |
| `retainedRuns` | 128 |
| `retentionMs` | 300,000 |
| `evaluationMs` | 300,000 |
| `cleanupGraceMs` | 5,000 |
| `progressRecords` | 32 |
| `progressRecordBytes` | 1,024 |
| `progressBytes` | 16,384 |
| `requestsPerMinute` | 600 |

The request budget must be at least 256 bytes and the response budget at least
2,048 bytes; the response budget must also exceed the progress budget by at least
2,048 bytes for the closed envelope and public result.

Byte limits count UTF-8; progress limits count compact encoded record bytes.
JSON depth is at most 16 and total JSON nodes at most 2,048. Duplicate keys,
invalid Unicode, non-finite/unsafe/fractional numbers and unknown fields reject.
Header/body timeouts are five seconds. Connections and concurrent requests are
bounded independently of evaluation capacity. Retained public records and
projection bytes are checked before exposure. Oversized/invalid callback output
becomes unconfirmed workflow failure, never a raw diagnostic response.

Machine-readable records are in
[`service/contract.json`](../integrations/mirrorecma/service/contract.json) and
[`service/schema.json`](../integrations/mirrorecma/service/schema.json). Wire
validation, caller authorization, retention and transport have independent tests;
none substitutes for actual R3 negotiated worker and cleanup acceptance.
