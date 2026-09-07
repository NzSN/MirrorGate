# Shared Orchestration Control v1 — Landing Design

Status: **proposed implementation contract; not implemented or released**.
Baseline: MirrorGate `a377341`, MirrorECMA `89fbd14`, and Mirrors `acc3d9d`.
This design implements the shared-process obligations in
[client guide §13](https://github.com/NzSN/Mirrors/blob/main/Docs/client-implementation-guide.md#13-shared-sandbox-orchestration-design-profile).
The companion
[MirrorECMA landing design](https://github.com/NzSN/MirrorECMA/blob/main/docs/shared-orchestration-design.md)
defines the first native facade. Types and judgments follow the
[shared semantic notation](https://github.com/NzSN/Mirrors/blob/main/Docs/semantic-notation.md).

## 1. Decisions and scope

1. A MirrorGate process owns the evaluation-session state machine. Native
   clients send control requests; they do not reproduce preparation, admission,
   resource ownership, or forced-teardown policy.
2. The first control profile is **local Linux**: owned stdio or an explicitly
   configured, attached filesystem Unix socket. Remote control, reconnecting
   to an old session, and cross-host artifact transfer are unsupported.
3. One evaluation session has one frozen artifact, one required model
   registration, and at most one execution worker. Multiple traces reset that
   worker through declared initializers. A new evaluation gets a new session.
4. Both prebuilt submissions and source/build preparation are supported.
   Optional authoring commands use the same session before preparation seals it.
5. Initial execution admission accepts compiled `verify/require` negotiation.
   Dynamic-descriptor evaluation is a subsequent advertised profile.
6. The existing
   [worker protocol v1](https://github.com/NzSN/MirrorGate/blob/main/docs/protocol-v1.md)
   and Mirrors JSONL protocol remain unchanged. Control has its own version,
   framing limits, request correlation, and authorization.
7. A native C++ facade is the second acceptance implementation. Node and Rust
   **workers** alone do not establish two client facades.

The shared control implementation belongs in MirrorGate. A Node SDK and C++
SDK interpret the same control contract and fixtures. Neither SDK contains a
second copy of the session transition function.

## 2. Three separate channels

| Channel | Participants | Content | Bound excluding LF |
| --- | --- | --- | --- |
| Control v1 | Trusted facade and MirrorGate | Policy references, preparation, admission attestations, handles, lifecycle | 1,048,576 bytes |
| Mirrors model protocol | Trusted replay driver and Mirrors | Private model registration, model steps, reports, verdicts | Existing 65,535 bytes |
| Worker port v1 | Trusted native port proxy and sandboxed worker, through a Gate broker | Declared inputs, observations, public lifecycle operations | Existing 65,535 bytes |

The larger control bound accommodates a complete existing public manifest,
whose independent limit is 262,144 bytes. It does not enlarge either of the
other protocols. Worker bytes never enter the control dispatcher. Gate does
not receive raw Mirrors messages or decide model conformance.

The worker broker supplies a session-owned transport. It validates bounded
framing and the lifecycle information needed to enforce closing, but does not
project model inputs, compute expected observations, or translate native values.

## 3. Startup, principal, and ownership

An owned connection starts a locally installed, operator-approved command
equivalent to `mirrorgate control --stdio --policy-file <trusted-file>`. A
development launcher may select the existing Python module explicitly. No
runtime download or executable selected by a descriptor is allowed. Control
uses stdin/stdout; bounded diagnostics use stderr.

An attached connection uses a filesystem socket in a supervisor-created
directory with mode `0700`; the socket has mode `0600`. The facade verifies
the directory/socket type, ownership, and absence of symlink components.
The Python server verifies the connecting UID with Linux `SO_PEERCRED`.
The first profile admits the configured host UID. This assumes other programs
of that host UID outside the sandbox are trusted; submitted code has neither
the directory mount nor inherited control descriptors. Abstract Unix sockets
are not used. Remote transports need a separately specified authentication
contract before admission.

Each control connection gets an internal connection identity. Every session,
operation, and worker handle is bound to **connection + principal + session**.
The same UID on another connection cannot adopt a handle. Handle failures use
one `HANDLE_INVALID` code for unknown and foreign handles. A rejected foreign
handle request changes no resource belonging to its real owner.

The facade owns its sessions and connections. It terminates the control process
only if it started that process. Closing an attached connection cannot stop
the daemon or another connection's sessions. There is no public `shutdown`
operation in control v1.

## 4. Frames, correlation, and limits

Control frames are strict UTF-8 JSON objects followed by LF. Reject invalid
UTF-8, BOM, raw CR, empty lines, unterminated final frames, duplicate keys,
unknown fields, non-integral/unsafe JSON numbers, and invalid Unicode scalars.
Apply limits before dispatch: 1 MiB per frame, JSON depth 128, and 16,384
nodes. Manifest validation additionally retains all worker-v1 manifest/type
limits. Control and worker decoders use distinct limit sets even if they share
a bounded JSON parser implementation.

Control encoders emit Unicode scalars directly as UTF-8 except for JSON's
required quote, backslash, and control-character escaping; they do not add
optional ASCII/HTML escaping. Decoders may accept other valid JSON escape
spellings within the same bounds. This keeps the outer encoding of a valid
manifest document to at most twice its original byte count, plus the envelope.

Request IDs are increasing positive safe integers, scoped to a connection.
Reuse, decrease, an unsolicited response, or an uncorrelatable malformed frame
closes that connection and begins cleanup of its sessions. The facade never
retries a mutating request whose result is uncertain. It cancels/closes and
starts a fresh evaluation. Explicit close/release operations are idempotent.

The wire envelope is defined by these labeled products. `Args(op)` and
`Reply(op)` are the operation-specific records in §6:

```text
Request(op) ≜ Prod[v:Singleton[1], kind:Singleton["request"],
  id:RequestId, op:OperationName, args:Args(op)]
Success(op) ≜ Prod[v:Singleton[1], kind:Singleton["response"],
  id:RequestId, ok:Singleton[true], result:Reply(op)]
Failure ≜ Prod[v:Singleton[1], kind:Singleton["response"],
  id:RequestId, ok:Singleton[false], error:ControlError]
Event ≜ Prod[v:Singleton[1], kind:Singleton["event"],
  seq:EventId, sessionId:SessionId, event:EventName, data:EventData]
```

These labels map directly to JSON fields. Requests omit inapplicable fields;
v1 rejects explicit null except where a result is specified as null. Each
response must match a pending request and its operation-specific result type.
Events have contiguous connection-local sequence numbers starting at 1 and
known session ownership. The facade rejects gaps, unknown event types, and
impossible correlations. Status queries cover a late application waiter, not
recovery from a damaged control stream.

Malformed framing, duplicate JSON keys, an invalid envelope, an unknown
operation, or an invalid request ID closes the connection without dispatch.
A valid envelope with invalid operation arguments consumes its ID and returns
`ARGUMENT_INVALID`; rejected arguments, handles, and phase checks leave the
session state unchanged. A failure of an already accepted operation instead
starts that session's failure/cleanup transition.

The first request is `hello`, ID 1. Its `controlVersions` is a nonempty unique
list of at most 8 versions; its `requiredCapabilities` contains at most 64
unique names. Bootstrap uses the v1 envelope. The server chooses the highest
common supported control version; the first implementation supports only 1.
A missing version or required capability is a terminal handshake error before
any session is opened. This is not a fallback to the administrative CLI.

Long operations acknowledge with `Accepted(operationId)`. The accepted response
is queued before any event for that operation. `operation.finished` has exactly
one success or failure outcome. `operation.status` returns the same stored
terminal outcome if a caller missed its event. This is observation of an
existing operation, not a retry of its mutation.

Initial default policy bounds, which the operator may tighten:

| Resource | Limit |
| --- | --- |
| Active control connections / sessions per connection | 16 / 4 |
| Active sessions / in-flight control requests per connection | 64 process-wide / 16 |
| Ordinary active authoring/build operation per session | 1 |
| Execution workers per evaluation session | 1 |
| Pending encoded control output per connection | 4 MiB |
| Completed operation records | 128 per session, then oldest completed record evicted |
| Control hello / request acknowledgement / worker attachment | 5 seconds each |
| Default complete evaluation-session deadline | 600 seconds, monotonic |
| Graceful stop / total teardown attempt | 1 second / 5 seconds |

An evicted operation ID returns `OPERATION_UNKNOWN`; it is not retried as a
mutation. Slow-reader/output overflow closes only the offending connection.
Cancellation and cleanup are not blocked behind an authoring/build subprocess.
Existing backend process, output, filesystem, and snapshot bounds continue to
apply independently. A policy may demand lower values, never an unsupported
aggregate guarantee.

The capability IDs for this landing are `control.local-stdio-v1`,
`control.local-unix-v1`, `submission.prebuilt-v1`,
`submission.source-build-v1`, `authoring.tools-v1`,
`execution.compiled-verify-v1`, `worker.managed-unix-v1`, `worker.node-v1`,
`worker.rust-v1`, `backend.linux-bubblewrap-v1`, and
`cleanup.bounded-attempt-v1`. Each report entry contains `id`, `available`,
`enforcedScope`, `limits`, and an optional unavailable `reason` code. Unknown
required capability IDs are unavailable. The facade requests the subset needed
by its selected submission, worker, and connection mode.

`enforcedScope` is one of `connection`, `session`, `command`, `process`,
`host-uid`, `host`, or `none`; unavailable guarantees use `none` and a reason.
Limits use the named dimensions below or the framing/count bounds above.
Backend capability discovery may use a fixed trusted probe. It never runs
submission code, and later physical admission can still fail without fallback.

## 5. Trusted policy and immutable identities

The operator supplies a policy catalog before serving. A `PolicyId` selects
approved input roots, build plans, tool commands, runtime trees, worker
launchers, and limits. A request may select an allowed
catalog entry and tighten its bounds. It cannot add mounts, environment
secrets, executable search paths, network permissions, or management access.

The evaluator host separately owns the policy for releasing its private
model results. Gate owns the format and bounds of its public preparation
outputs; it cannot enforce disclosure of model data that it never receives.

```text
InputRef ≜ Prod[rootId:ApprovedRootId, relativePath:RelativePath]
Submission ≜ Sum[
  prebuilt:Prod[input:InputRef],
  source:Prod[input:InputRef, buildPlanId:BuildPlanId, authoring:Bool]]
```

Root IDs are resolved under the principal's catalog permissions. Relative
paths reject traversal and symlinks; the supervisor pins directory identities.
The agent-facing tool wrapper fixes the session and exposes only approved
authoring requests. Session construction and `InputRef` selection remain with
the trusted evaluator.

The optional tightened-limit record has only these positive integral fields:
`sessionWallMs`, `executionWallMs`, `commandCpuSeconds`, `addressSpaceBytes`,
`uidProcesses`, `openFiles`, `fileBytes`, `stdoutBytes`, `stderrBytes`,
`snapshotFiles`, `snapshotBytes`, `tmpBytes`, and `scratchBytes`. Durations on
control use integral milliseconds or the explicitly named CPU seconds; the
backend performs any conversion to its native time representation. Omitted
fields use the frozen policy defaults. Unknown or looser fields are rejected.

Catalog IDs use `[A-Za-z][A-Za-z0-9_.-]{0,127}`. Input paths and `cwd` are
canonical relative paths of at most 1,024 UTF-8 bytes, with `.` allowed for the
approved root. Reject NUL and parent traversal. Tool arguments contain no NUL,
have at most 256 entries, and total at most 65,535 UTF-8 bytes. The executable
and permitted argument treatment come from `toolId`, not a host shell chosen
through an extra control field.

`modelRevisionId` is an optional opaque ASCII audit identifier of at most
128 bytes, not a source/configuration document. The encoded `session.open`
envelope excluding `manifestJson` is additionally bounded to 65,535 bytes.

Keep these identities separate in stored records and results:

| Identity | Meaning |
| --- | --- |
| Control version / worker version | Independent message contracts |
| `semanticDigest` | Exact public model-interface identity, 64 lowercase hex |
| `manifestHash` | Hash of the exact frozen public manifest bytes, including their representation |
| `sourceHash`, `artifactHash` | Supervisor snapshot identities |
| Runtime / backend policy IDs | Selected execution and enforcement profiles |
| `modelRevisionId` | Optional opaque audit reference supplied by the evaluator; never sent to a worker or public result |

`manifestHash` is not `semanticDigest`. A worker's digest echo proves neither
artifact authenticity nor honest observations.

## 6. Operations

All fields listed as optional are omitted when absent. Handles are opaque
128-bit random values encoded as 32 lowercase hex characters. They convey no
authority without the owner checks in §3.

| Operation | Arguments | Reply and effect |
| --- | --- | --- |
| `hello` | `controlVersions`, `requiredCapabilities` | Selected version, instance ID, capability/limit report; no session allocation |
| `session.open` | `policyId`, `submission`, `runtime`, `manifestJson`, optional tightened `limits` and `modelRevisionId` | `sessionId`; validate and freeze the manifest and session policy, but launch no submitted code |
| `authoring.exec` | `sessionId`, `toolId`, `arguments`, `cwd` | Accepted operation; run the approved command in the authoring profile |
| `session.prepare` | `sessionId` | Accepted operation; stop writers, freeze source, build if required, freeze final artifact; result is `Prepared` |
| `session.authorize` | `sessionId`, `preparedRevision`, `challenge`, `attestation` | `authorizationId`; permit later acquisition only after all correlation/admission checks |
| `worker.acquire` | `sessionId`, `authorizationId` | `workerId`, private endpoint, one-use attachment token and expiry; reserve resources without launching submitted code |
| `worker.release` | `sessionId`, `workerId`, `reason` | Accepted shared cleanup operation; repeat calls join it |
| `session.cancel` | `sessionId`, `reason` | Accepted session cleanup operation, priority over ordinary work |
| `session.close` | `sessionId`, optional bounded `outcomeSummary` | Accepted session cleanup operation; joins an existing close |
| `session.status` | `sessionId` | Phase, owned-resource counts, cleanup status; never a hidden mutation |
| `operation.status` | `sessionId`, `operationId` | Pending or stored terminal result, or `OPERATION_UNKNOWN` |

`Prepared` contains `preparedRevision = 1`, artifact ID/hash, optional source
hash, manifest hash, runtime and policy IDs, and a fresh one-use authorization
challenge. Artifact IDs do not expose host snapshot paths. Preparation may be
requested once; a failed build cannot be retried inside that sealed session.

`manifestJson` is a string containing the exact public manifest JSON document,
at most 262,144 UTF-8 bytes after decoding the outer control string. Gate
strictly parses and validates that inner document with worker-manifest limits,
then freezes those exact bytes. This avoids inventing a second cross-language
manifest canonicalizer. The identity is:

```text
manifestHash ≜ lowerHex(SHA256(
  UTF8("mirrorgate.public-manifest/v1") || 0x00 || UTF8(manifestJson)))
```

Different whitespace may change this byte identity without changing the
separate semantic digest. Facades may consume the same approved manifest
fixture when exact byte identity is required. Ordinary JSON string escaping
of a maximum-size manifest fits within the 1 MiB control-frame bound.

Release/cancel reasons are `normal`, `user-cancel`, `deadline`,
`client-failure`, or `worker-failure`. `outcomeSummary`, when supplied by the
trusted driver, contains only `status` (`passed`, `mismatch`, `failed`,
`cancelled`, or `timedOut`) and an optional stable `failureFamily`; it carries
no model diagnostics. It is a recorded assertion by that driver, not a Gate
conformance decision.

The `attestation` fields are `registrationId`, `request = verify`,
`policy = require`, `status = matched`, `descriptorSchema`, `semanticDigest`,
and the client's exact `adapterId`, `targetProfile`, and
`stateComputerContractVersion`. The trusted replay driver creates it only after
strict §9 validation. Gate checks the owner, prepared revision, challenge,
expected semantic digest, immutable plan, and current backend admission.

This is a **trusted-driver attestation**, not an independently signed Mirrors
receipt. Gate does not parse a copied raw model reply or independently run
model negotiation. A compromised trusted evaluator could lie about that
attestation; defending against it would require a separate trust design.
Compliant-facade tests must establish zero attestations and launches after
every failed required negotiation.

Events are `operation.finished`, `authoring.output`, `build.output`,
`worker.started`, `worker.ready`, `worker.exited`, `worker.closing`, and
`session.closed`. Output events contain a stream tag, monotonically increasing
chunk number, and canonical base64 of at most 16 KiB of raw bytes. Outputs
retain backend byte caps; they never act as control requests or verdicts.
Worker-ready requires successful physical `hello/create` exchange; it does
not claim that the implementation's observations conform to the model.

## 7. Session transitions and negotiation authority

```text
q ::= open | authoring | preparing | prepared | authorized
    | reserved | starting | running | closing | closed | cleanupFailed

open/authoring ⟶prepare preparing ⟶success prepared
prepared ⟶validated-attestation-and-admission authorized
authorized ⟶acquire reserved ⟶valid-attachment starting
starting ⟶worker-hello/create-success running
nonterminal ⟶accepted-operation-failure/cancel/close closing
closing ⟶confirmed-cleanup closed
closing ⟶deadline-or-cleanup-failure cleanupFailed
```

`authoring.exec` is permitted only before preparation seals the session.
Transition validation and resource registration are serialized in Gate, before
subprocess work. Invalid phase requests have no submitted-code effect. A
session in `closing`, `closed`, or `cleanupFailed` admits no new work.

Let `σ` identify the evaluation session, `ι` its exact interface, and `a` its
frozen artifact. The launch obligation is:

```text
H ⊢ k : Matched(σ,ι)    H ⊢ d : Admission(σ,ι,a)
H(σ).phase = reserved   attachment belongs to σ and is fresh
────────────────────────────────────────────────────────────
⟨H; launch(σ,k,d)⟩ ↦ ⟨H′; starting(worker)⟩
```

Only accepted `session.authorize` introduces the recorded `Matched` authority;
only supervisor admission introduces `Admission`. The physical launch checks
both again. Source/build work may run earlier only in its own restricted
profile. Native loader and pre-main code run only after this launch rule.

## 8. Preparation and managed worker transport

`session.prepare` performs one shared workflow. It first rejects further
authoring requests, terminates or awaits all owned writers, and freezes the
source. Build hooks execute in the build profile over that read-only snapshot.
Gate then stops build writers and freezes the output as the execution artifact.
A prebuilt input takes only the final freeze/admission path. Dependency
preparation uses approved public runtime material and never private model data.

The host must also stop writers outside Gate before submitting an imported
input. Existing change-during-copy checks are retained; they do not constitute
an atomic snapshot of a concurrently modified external tree.

Reuse `freeze_tree`, `TrustedConfig`, and backend launch enforcement. Extend
the backend with an internal, owner-checked frozen-artifact lease so stage
handoff does not remount a live authoring tree or trust a caller-constructed
`FrozenArtifact`. The controller retains these leases until cleanup.

Node uses a Gate-approved read-only shim tree and a separate frozen public
manifest. The submitted adapter entry remains inside the artifact; it cannot
replace the trusted Node shim. Rust's submitted executable is wholly confined
from startup; only its SDK-managed factory has the additional `hello/create`
ordering guarantee. The launcher obtains entry points from the reviewed plan,
never from a Mirrors descriptor.

Each reserved worker has a private filesystem socket and a 256-bit random
one-use attachment token. The native SDK consumes a bounded, at-most-4-KiB
transport attachment exchange before exposing the port stream. That exchange
is never forwarded to the worker and does not change worker v1. Ownership,
expiry, session state, and admission are checked before launch. An invalid
attachment cannot consume or close another session's worker.

After attachment, Gate relays the existing worker frames with bounded queues.
The native proxy performs `hello`, validates identity/runtime, performs
`create`, and only then returns a usable generated port. Gate observes the
physical handshake for lifecycle reporting. Failure or timeout during any
part of acquisition cleans up registered partial resources.

## 9. Cleanup, cancellation, and result ownership

MirrorGate alone sends process signals, enforces forced-stop deadlines,
confirms descendant exit, closes owned descriptors, and releases snapshots.
The Node `WorkerClient` needs a **managed mode**: its protocol checks remain,
but transport termination delegates to `worker.release`/`session.cancel`.
It must not spawn the supervisor or run a competing process-kill timer.

Logical release is atomic. The first release records `closing` and a cleanup
operation ID. Later releases join that operation. Gate registers resources
before acknowledging acquisition, so a lost response or partial factory
failure still has an owner and a cleanup path.

The broker rejects new `hello/create/invoke/observe` requests once closing
starts. It permits a valid cooperative `cancel`, or one `dispose` when no
application call is pending or possibly still running. It never invents
worker request IDs or injects a second client's messages. A cancellation
acknowledgement does not establish quiescence: after cancellation of a pending
call, use forced termination rather than racing `dispose` against that call.

The facade requests Gate cancellation immediately when aborted; it may also
send a legal worker-v1 cancel through its native proxy. Waiting for that
acknowledgement never delays Gate's deadline. Neither SDK dispatches another
port action, observation, or `report_state` based on a late completion. An
already running uncooperative action may continue until termination is confirmed.

The trusted replay driver owns the model outcome. Once it records a body
failure, cleanup errors are secondary. Gate records resource causes and the
driver's bounded outcome summary; it does not reinterpret a model verdict.
Race fixtures fix the order in which terminal causes are observed and check
that both facades retain the same first primary cause.

Only confirmed cleanup yields `closed`. A deadline or failed removal yields
`cleanupFailed` with known remaining resources; it never reports success.
That list may be empty when physical resources are gone but cooperative
application disposal failed; the cleanup failure is still retained.
Control EOF cleans up exactly that connection's sessions, including during
preparation. An unexpected Gate process death returns a bounded
`CONTROL_DISCONNECTED` failure with cleanup unconfirmed. Parent-death/kernel
enforcement is tested separately; automatic crash-recovery snapshot collection
is unavailable in v1 and must not be claimed.

## 10. Errors, disclosure, and capability reporting

`ControlError` contains `code`, `stage`, `message`, and optional safe
`operationId`. Messages are capped at 1,024 UTF-8 bytes. Stable families are:
`VERSION_UNSUPPORTED`, `CAPABILITY_UNAVAILABLE`, `ARGUMENT_INVALID`, `POLICY_DENIED`,
`HANDLE_INVALID`, `STATE_INVALID`, `LIMIT_EXCEEDED`, `PREPARATION_FAILED`,
`BUILD_FAILED`, `NEGOTIATION_ATTESTATION_INVALID`, `BACKEND_ADMISSION_FAILED`,
`ATTACHMENT_FAILED`, `WORKER_PROTOCOL_FAILED`, `WORKER_EXITED`, `CANCELLED`,
`DEADLINE_EXCEEDED`, and `CLEANUP_FAILED`. An unknown/evicted operation uses
`OPERATION_UNKNOWN`. Transport loss and malformed control frames have distinct
SDK errors. None is a Mirrors mismatch.

`stage` is one of `bootstrap`, `policy`, `authoring`, `prepare`, `build`,
`authorize`, `attach`, `worker`, or `cleanup`. Attachment tokens and
authorization challenges are redacted from diagnostic logs; raw control
frames are not an agent-facing diagnostic stream.

Capabilities report availability, enforced scope, limits, and a stable reason
when unavailable. In particular, report virtual-address limits as per-process,
process-count limits as host-UID-scoped, and aggregate cgroup quotas as
unavailable. No raw-process fallback is permitted when admission fails.

Private specs, credentials, expected states, and raw replay context stay with
the evaluator. Detailed diagnostics remain in a trusted sink. An agent-facing
wrapper returns only the outcome allowed by its fixed disclosure policy;
the agent cannot select a more detailed policy. Public-manifest review and
mediation of every access-capable agent tool remain host obligations.

## 11. Implementation ownership and gates

All paths below are planned additions or scoped changes, not existing shipped
entry points:

| Module | Responsibility |
| --- | --- |
| `protocol/control-v1/` | Schemas, operation catalog, structural limits |
| `conformance/control-v1/` | Shared transcripts, lifecycle/error/ownership vectors |
| `supervisor/mirrorgate/control_protocol.py` | Strict control codec and correlation |
| `supervisor/mirrorgate/orchestration.py` | Single session transition implementation and operation registry |
| `supervisor/mirrorgate/worker_broker.py` | Private endpoints, bounded relay, closing enforcement |
| Existing `sandbox.py`, `artifacts.py`, `policy.py` | Backend admission, frozen leases, deadline/cleanup primitives |
| Existing `cli.py` | Separate `control` entry; preserve administrative `run` |
| `sdk/node/control.mjs`, `sdk/node/managed-worker.mjs` | Public control transport and managed worker lifecycle |
| `sdk/cpp/` | Native control and worker transport interpretation for the second facade |

Publish Node SDK subpaths `mirrorgate/control` and `mirrorgate/worker` only
after package/declaration/fixture gates pass. The currently private package
does not constitute an installable release. The shared process is distributed
separately from language SDKs, with a tested compatibility manifest.

Acceptance requires malformed-frame/limit tests, all phase rejections, stale
and cross-owner handles, lost replies, client EOF during every stage, writer
quiescence, immutable handoff, native pre-main admission gating, cancellation
with a noncooperative callback, descendants that create new sessions, cleanup
failure precedence, slow-reader overflow, and private canaries across every
exposed profile/tool. All requested backend guarantees must be exercised in
the actual backend, not replaced by a subprocess mock.

Run shared control fixtures through Node and C++ SDKs, then run correct and
faulty Counter evaluations through MirrorECMA and MirrorCPP using the same
Gate process implementation. Record facade language, worker runtime, control
version, backend, compiler/binding versions, and exact repository revisions
separately. A profile stays experimental until these gates and the existing
worker/backend gates pass.
