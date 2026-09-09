# Managed agent hosting control v2

Status: AH1.2 wire contract, AH2.1 codec and AH5.2 controller integration,
2026-09-09. Actual agent-runtime audit and complete isolated consumer acceptance
remain separate gates; deterministic controller tests do not replace them.
The [machine-readable contract](../protocol/control-v2/contract.json),
[closed JSON Schema](../protocol/control-v2/schema.json), and
[shared vectors](../conformance/control-v2/vectors.jsonl) accompany this document.
The [managed workflow](managed-workflow-design.md) defines product ownership.

## Compatibility and bootstrap

The first request is the unchanged v1 `hello` envelope, with `controlVersions`
and `requiredCapabilities`. A hosting client offers `[2]` and requires
`hosting.fresh-agent-v1` plus its selected runtime/backend capabilities. The
controller selects the highest supported offered version; no common version
returns `VERSION_UNSUPPORTED` before session allocation. The successful hello
response also uses `v: 1`, with the unchanged `controlVersion`, `instanceId`,
`capabilities`, and `limits` fields. Selecting 2 changes all subsequent control
request, response, and event envelopes to `v: 2`. V2 advertises
`requestAckTimeoutMs: 10000` so a joined five-second `agent.cancel` teardown fits
within the request budget. V1 retains its existing 5000 ms value and exact record
shape.

A v1 selection exposes no `hosting.*` capability entries, even unavailable ones.
V1 requests and schemas remain closed and unchanged. A v1-only controller rejects
hosting-only clients. Missing runtime/audit/backend capability must fail before
launch; there is no downgrade to an unrestricted or tools-only implementation.
Capability entries keep the v1 shape and v1 limit keys. Hosting bounds belong to
admitted run records, not bootstrap fields. The v2 codec can validate the bootstrap
and delegates byte-for-byte legacy semantics to the independent v1 codec.

All non-hosting v2 operation arguments/results keep their v1 shapes and semantics,
with the additional session phase `submitted`. Worker descriptors still use
`releaseMode: "control-v1"`; attachment envelopes and worker RPC remain v1.
Mirrors messages and model-interface identities do not change.

## Closed hosting operations

| Operation | Required arguments | Optional arguments | Success result |
| --- | --- | --- | --- |
| `agent.start` | `sessionId`, `profileId`, `publicTask` | `limits` | `{runId}` |
| `agent.status` | `sessionId` | `runId` | `{run: HostedRun \| null}` |
| `agent.cancel` | `sessionId`, `runId`, `reason` | none | `{run: HostedRun}` |

Cancel reasons use the existing v1 enumeration. Cancel joins bounded hosting
cleanup and returns a `finished` run, including failed cleanup if necessary.
Acknowledging cancellation alone cannot be returned as successful cleanup.
`agent.status` returns null only if the session has no accepted run and no run ID
was supplied. An explicit unknown or foreign ID returns `HANDLE_INVALID`.
A healthy owner can inspect an uncertain start using `agent.status(sessionId)`;
it must not retry start. A damaged connection must close its owned resources.

Run IDs are fresh 128-bit lowercase hex handles, bound to the connection,
principal and session. No same-UID bypass, adoption or reconnect is supported.
Runs are retained for the session lifetime and are distinct from evictable
ordinary `operationId` records. At most one hosted run may be accepted in a
session lifetime; synchronous admission failure does not consume that slot.
The start reply is queued before the first run event.

Before acceptance the controller validates ownership, source-authoring session
phase, profile policy, current runtime audit, resolvable credential reference,
backend capability, task and limit bounds, session deadline, and free slots.
Only then may it reserve the run and allocate host resources. Failures after
acceptance consume the run slot and follow normal bounded cleanup.

There is one hosted-run slot and one independent ordinary command slot. The
broker uses the ordinary command slot without deadlocking behind its own run.
External `authoring.exec` is rejected throughout managed ownership, including
startup/submission, and a start during an ordinary command is rejected without
cancelling that command. Revocation and cancellation never wait for a free
ordinary slot. Preparation remains one-shot and requires a committed submission
plus confirmed host cleanup.

## Approved public input and limits

`publicTask` is exactly `{instructions, files}`. Every file is exactly
`{path, text}`. Instructions must be nonempty; file text may be empty. Paths are
canonical relative slash-separated file paths: no empty, `.` or `..` component,
leading/trailing slash, backslash, NUL, duplicates, or file/directory prefix
collisions. The first component `.mirrorgate` is reserved. Operator-installed
public-port and broker files cannot be replaced by public inputs; admission checks
these installed identities in addition to the lexical codec.

Public inputs are immutable context, staged separately from writable submission
source. Requests never contain host filesystem references, fetching URLs,
executables, flags, credential locations, tool definitions or environment maps.
The trusted caller approves disclosure; Gate cannot infer secrecy from prose.

| Bound | Maximum |
| --- | ---: |
| Instructions, decoded UTF-8 bytes | 65,536 |
| Public files | 128 |
| Combined file text, decoded UTF-8 bytes | 262,144 |
| One path, decoded UTF-8 bytes | 1,024 |
| `wallMs` | 300,000 |
| `stdoutBytes` per hosted stdout stream | 1,048,576 |
| `stderrBytes` per hosted stderr stream | 1,048,576 |
| `progressRecords` | 256 |
| `progressBytes` | 262,144 |
| `progressRecordBytes` | 16,384 |

Requested hosting limits are an optional closed subset of the six named limits;
all are positive safe integers. The installed profile can only tighten them.
The accepted run includes all six effective limits. Actual run wall time is also
bounded by the session deadline. Control framing retains v1's 1 MiB payload,
128 depth and 16,384 JSON-node limits; duplicate keys, invalid Unicode, fractional
or unsafe numbers, CRLF and BOMs are rejected before allocation. Output overflow
terminates the run and retains bounded outcome and cleanup evidence.

## Run status, progress, and events

`HostedRun` is exactly:

```text
{
  runId,
  phase: starting | running | submitting | cleaning | finished,
  cleanup: {status: notStarted | pending | succeeded | failed, remainingResources},
  limits: {wallMs, stdoutBytes, stderrBytes, progressRecords, progressBytes, progressRecordBytes},
  progress: {firstSeq, nextSeq, truncated, records: [{seq, message}]},
  outcome?: submitted | failed | cancelled | timedOut,
  submission?: {submissionId, sourceHash, sourceRevision: 1},
  error?: {code, stage, message, operationId?}
}
```

Starting/running/submitting have no outcome and cleanup `notStarted`. Cleaning
has an outcome and cleanup `pending`. Finished has an outcome and cleanup
`succeeded` or `failed`. Exactly the submitted outcome has a submission record.
Failed/cancelled/timedOut outcomes require a primary error; submitted forbids one.
Postcommit runtime diagnostics are retained separately in trusted local evidence
and cannot replace the committed primary outcome. Successful cleanup has no
remaining resources; a failed cleanup may include bounded public resource IDs.

Progress is a bounded rolling window, not authoritative state. Sequences begin
at 1, are contiguous, and `nextSeq = firstSeq + records.length`. `truncated` is
true exactly when `firstSeq > 1`. An initially empty window is `(1,1,false,[])`.
Pollers compare their last sequence against `firstSeq` to detect omitted records;
there is no unbounded history or cursor-owned retention. Each record's canonical
compact UTF-8 JSON bytes, excluding LF, count toward both byte limits. Progress
contains fixed controller status messages, never model/controller transcripts, credentials,
private filesystem paths or raw evaluator diagnostics.

`agent.updated` and `agent.finished` use the ordinary event envelope and exactly
`{run: HostedRun}` as data. Updated events cannot carry a finished phase; finished
events must. Events retain per-session ordering and do not create a second run
state machine. Slow consumers are subject to existing connection output bounds.
The authoritative status remains available independently of progress truncation.

## Submission, preparation and cleanup

Submission is an implementer-broker operation, not an outside control request.
The controller revokes tools, settles active commands and writers, then asks the
existing snapshot backend for a provisional source lease. Under the session lock,
it checks cancellation/closure, installs the lease and submission record, and
commits the source identity exactly once. Losing provisional leases are released.
Duplicate submission joins that commitment; it must never snapshot twice.

The session becomes `submitted`. `session.prepare` consumes that exact owned
lease after hosting cleanup succeeds. It cannot reread the live source tree,
reopen authoring, freeze a replacement source or retry a failed build. Prepared
`sourceHash` equals the submission hash; `submissionId`, `artifactId`, source hash,
manifest hash and model semantic digest remain separate identities.

Cancellation before commitment yields no submission and cleans the failed run
and session. Run cancellation after commitment preserves submission and joins
hosting cleanup. Session close/cancel/deadline or owner EOF releases physical
leases but retains committed identity in terminal accounting. Agent exit without
explicit submit is failure. Agent exit after commitment preserves submitted.
Cleanup failure after commitment preserves identity and blocks preparation.
The host uses existing 1-second graceful stop and 5-second teardown attempt
ceilings; unconfirmed resources are never reported as successfully cleaned.

Host cleanup covers agent descendants, broker, tools, temporary configuration,
credentials and diagnostic staging. Session cleanup additionally covers source,
artifact, manifest and shim leases and build/worker resources. Bounded retained
run metadata does not count as a physical resource.

## Errors and acceptance

V2 retains v1 errors and adds `AGENT_START_FAILED`, `AGENT_EXITED`, and
`AUDIT_UNAVAILABLE`, plus the `hosting` stage. Invalid fields and paths use
`ARGUMENT_INVALID`; size violations use `LIMIT_EXCEEDED`; unauthorized profiles
use `POLICY_DENIED`; absent/foreign handles use `HANDLE_INVALID`; occupied slots,
repeated starts/prepares and premature build use `STATE_INVALID`. Runtime/audit
admission cannot claim availability based on version text alone.

JSON Schema describes every closed record and all operation argument shapes.
The codec additionally enforces decoded byte budgets, canonical paths, aggregate
limits, exact error/result and request correlation, source/outcome coherence,
progress arithmetic and framing. Runtime ownership, races, audits and isolation
must be exercised by controller/backend acceptance, not inferred from schema.
The [lifecycle vectors](../conformance/control-v2/lifecycle.json) specify those
independent gates; codec passing does not mark them implemented.

Run `python3 conformance/control-v2/run` for codec vectors and
`python3 conformance/control-v2/run --schema` for additional Draft 2020-12 schema
validation using the separately installed `jsonschema` package. The repository's
ordinary Python test discovery includes the codec regressions. Frozen v1 vectors
remain a separate gate.
