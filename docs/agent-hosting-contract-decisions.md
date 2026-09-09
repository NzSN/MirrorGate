# Managed hosting contract decisions — AH1.1 draft

Status: historical AH1.1 decision draft, retained from 2026-09-09. AH1.2 and the
implementation are complete; the [control v2 contract](agent-hosting-control-v2.md),
versioned schemas/fixtures, and [final validation](managed-workflow-validation.md)
are authoritative for current APIs and support. Proposed names, remaining work,
and future-tense statements below record the earlier decision stage, not current gaps.

Read alongside [hosting design](agent-hosting-design.md),
[task ledger](agent-hosting-tasks.md), [control v1](orchestration-control-v1.md),
and [MirrorECMA ownership](https://github.com/NzSN/MirrorECMA/blob/main/docs/implementation-boundary-design.md).
The coordinator calls Gate directly; MirrorECMA receives a generic implementation
factory/binding. Mirrors and worker port v1 remain unchanged.

## 1. Version and policy compatibility

Choose control **v2**, with its own `protocol/control-v2/contract.json`, schema,
fixtures, and version-specific decoder. Keep `protocol/control-v1/` and its
closed records unchanged. Support v1 and v2 connections independently.

Keep the existing v1 `hello` bootstrap envelope and response record shapes.
A hosting caller offers only `[2]` and requires `hosting.fresh-agent-v1` plus its
runtime and backend capabilities. A new controller may select 2; the hello
response still uses the bootstrap v1 envelope, and all subsequent control frames
use the selected version. A v1-only controller rejects before session allocation.
A legacy caller offering only `[1]` gets precisely v1 behavior. No automatic
fallback from unavailable hosting to tools-only or unrestricted execution.
New hosting capability entries use the existing bootstrap capability record;
put hosting-specific bounds in v2 run admission/results, not new v1 hello fields.
V1 selection must omit v2-only capabilities and never advertise hosting as usable.

Choose catalog `mirrorgate.control-policy/v2` with required top-level fields
`schema`, `policies`, and `agentProfiles`. Each `policies` entry contains the
existing closed policy fields plus `agentProfileIds`. Profiles are separately
keyed installed configurations; requests cannot supply executable paths,
credential paths, environment maps, mounts, or tool definitions. A v2 server may
load a v1 catalog for existing operations, with no hosting capability. A legacy
loader rejects a v2 catalog. V1 sessions served from a v2 catalog see only the
base policy projection; profiles confer no additional v1 operations.

Affected existing modules: [control codec](../supervisor/mirrorgate/control_protocol.py),
[policy loader](../supervisor/mirrorgate/control_policy.py),
[server](../supervisor/mirrorgate/control_server.py), and
[controller](../supervisor/mirrorgate/orchestration.py). AH1.2 defines the bootstrap
version-selection fixtures before AH2 changes dispatch. A version string in a
design document is not a supported capability.

## 2. Run identity and independent operation slots

Propose these new v2 trusted control operations:

| Operation | Closed argument fields | Purpose |
| --- | --- | --- |
| `agent.start` | `sessionId`, `profileId`, `publicTask`, optional `limits` | Admit one fresh run and return `runId` |
| `agent.status` | `sessionId`, optional `runId` | Return the session's unique run or explicit absence; supplied IDs must match ownership |
| `agent.cancel` | `sessionId`, `runId`, `reason` | Revoke admission and join that run's cancellation/cleanup |

The session permits at most one **accepted** hosted run over its lifetime.
Synchronous admission rejection does not consume the slot; failure after
acceptance does. Runs are separate from ordinary `operationId` records. Assign
128-bit random `runId` handles bound to connection + principal + session.
Retain the run record for the session lifetime rather than ordinary-operation
record eviction. Queue the acceptance reply before any run event.

Maintain a hosted-run slot and a separate single ordinary authoring-command
slot. Broker tool execution uses the latter. Reject trusted external
`authoring.exec` while any managed run owns authoring, including startup and
submission; do not serialize unrelated writes invisibly. Reject `session.prepare`
until successful submission and host cleanup. Starting hosting while a command
is active is rejected without cancelling that command. Submission/cancellation
can revoke and stop a tool without waiting for the ordinary slot.

`agent.status(sessionId)` permits observation when the `agent.start` response is
uncertain on an otherwise healthy owner connection. It never retries start.
The supplied adapter serializes starts per task/session and preserves its pending
record across an MCP call timeout; another start is rejected while unresolved.
The underlying SDK continues correlating the original response. Damaged control
streams require owner teardown; a new connection cannot recover the run.

Affected existing controller seams are `SessionState`, `_new_operation`,
`_op_authoring_exec`, `_op_session_prepare`, `_spawn`, and `after_response`.
Proposed additions are `authoring_broker.py` and explicit hosting state in the
controller. No separate lifecycle implementation belongs in the SDK or tool.

## 3. Submission commits an owned source lease

Use a distinct v2 session phase `submitted`, with an immutable submission record
and session-owned `FrozenLease`. Submission is an implementer broker operation,
not natural-language completion and not an outside hosting tool.

The authoritative sequence is:

1. Under the session lock, reject new tools and enter `submitting` run phase.
2. Stop/settle the active tool and all managed writers; failure to prove
   quiescence prevents commitment. Independent trusted external writers must
   already have been excluded by the caller.
3. Freeze source into a provisional lease using the existing snapshot checks.
4. Under the session lock, verify cancellation/closure has not won, install the
   lease, and atomically record `submissionId`, `sourceHash`, and `sourceRevision=1`.
   This installation is the commit point. Release any uncommitted provisional
   lease if cancellation wins.
5. Finish hosting cleanup, preserving the session lease for preparation.

The session's sole `session.prepare` builds from this exact committed lease.
It must not reread the live input tree, unseal authoring, or freeze another source.
Preparation remains one-shot; build failure does not reopen authoring. Legacy
non-hosted preparation retains its existing source-freeze/build behavior.
`Prepared.sourceHash` must equal the submission record. Submission ID is distinct
from artifact ID, source hash, manifest hash, and model semantic digest.

This requires a focused change to [preparation.py](../supervisor/mirrorgate/preparation.py):
`BackendSession`, `ControlBackend._stop_authoring`, `prepare`, and session cleanup.
Today `prepare` rejects `sealed`, while `_stop_authoring` sets it. Calling those
unchanged after submit cannot implement the new contract.
[artifacts.py](../supervisor/mirrorgate/artifacts.py) remains the snapshot/lease
owner; the broker must not invent another snapshot algorithm.

The [R1–R3 ownership clarification](managed-workflow-design.md) requires the
trusted host/evaluation composition below to be supplied and supported by
MirrorGate. "Separate integration" means separate from MirrorECMA's core;
its lifecycle, aggregate receipts and private/public result projection remain
Gate responsibilities. Applications supply approved inputs and suite callbacks.

## 4. One owner through tool calls and evaluation

Choose **in-process embedding** for the first standard hosting adapter. Its
trusted host owns one public Node Gate SDK connection and a task/run registry.
The same host can embed the separately packaged evaluation integration, receiving
an in-memory session reference through a trusted callback or registry lookup.
The stdio MCP front end only exposes safe task/run references and projections.
It does not send raw session handles, worker endpoints, or connection objects
to the coordinating agent.

An application registers Gate's supplied tool definitions and trusted evaluation
callbacks. This is configuration/embedding, not an application-written launcher.
The CLI form loads only operator-configured trusted modules; the agent cannot
supply module paths. A tool-only process retains the submission until explicit
trusted disposal or the existing session deadline. A separately started test
process cannot adopt that live session by copying a run reference. Cross-process
ownership transfer and reconnect are outside this first contract.

The integration keeps the owner connection alive across source preparation,
MirrorECMA negotiation, worker admission, replay, and cleanup. It constructs the
Gate attestation inside the generic factory, only after required model matching.
Failed matching causes zero authorization/acquisition/worker launches. MirrorECMA
never sees Gate policy, author prompts, session handles, or lifecycle options.

MCP EOF/adapter shutdown ends this host's ownership: reject new work, cancel
active integrations and runs, await bounded session cleanup, then close the SDK.
A callback must not continue using an orphaned connection. Attached-mode cleanup
cannot kill the shared daemon or another connection's resources. The existing
Mirrors server is independent and remains running.

Affected homes: proposed `integrations/agent-host/`, existing
[integration](../integrations/mirrorecma/README.md),
[Node control SDK](../sdk/node/control.mjs), and its declarations. C++ exposes
native run lifecycle against the same control contract; it need not host the
Node MCP front end. Optional evaluation-service access remains a separate
integration protocol, not a Gate control or MirrorECMA model operation.

## 5. Admission, audit identity, and public input

Before accepting a run, validate the session phase, selected policy/profile,
isolation capabilities, all input/limit bounds, and a matching runtime audit.
Reserve ownership before allocating temporary credentials or launching any
process. An accepted launch that later fails follows normal cleanup.

Choose an audit identity covering executable content digest, runtime version,
Gate runtime-adapter revision, exact capability-relevant configuration template,
broker/tool definitions, fixed launch flags, environment allowlist, dependency
identity, implicit instruction/context loading behavior, backend/profile identity,
and credential-provider configuration revision. Keep an audit receipt with probe
suite revision and result. Verify all identity components again at admission;
changed bytes/configuration invalidate the receipt even if version text matches.
Pin admitted executable/configuration inputs through launch, rather than trust a
mutable path after hashing. Unknown identity or failed probe means unavailable.

Use a maximum audit age of 24 hours, tighten-able by operator policy, plus
immediate invalidation on any identity change. Run freshness checks before each
launch. Secret rotation through the same approved credential provider does not
require hashing secret bytes; provider/capability changes do invalidate the audit.
No credential contents or private evaluator data appear in the receipt or logs.
Admission verifies the selected credential reference is resolvable without
publishing it. Actual dispatcher probes must cover every denied access family,
including implicit instructions, memory, resource discovery, hooks, and delegation.

Propose `publicTask = {instructions, files}` with files as closed
`{path, text}` records. Paths are canonical relative file paths, unique, and
cannot replace generated public-port or reserved broker files. The initial
profile supports text files only; no arbitrary host input paths or URL fetching.
Caller-approved instructions and files are staged as immutable context before
agent startup. All limits apply to decoded UTF-8 bytes as well as framed input.
The outside tool accepts an approved `taskRef`; trusted SDK callers may construct
these public inputs directly. Gate cannot infer secrecy from arbitrary prose.

Suggested initial ceilings: instruction bytes 65,536; files 128; combined file
text bytes 262,144; relative path bytes 1,024; hosted wall time 300,000 ms and no
later than the session deadline; transcript/diagnostic bytes 1,048,576 per stream;
retained progress 256 records and 262,144 bytes total; single progress record
16,384 bytes. Keep the existing 1 MiB control-frame bound, JSON depth/node bounds,
and independent tool output caps. Operator limits can only tighten. Refuse an
oversize task before allocation; terminate a run on output-limit breach while
retaining bounded primary/cleanup results. Polling progress uses a bounded cursor
window with explicit truncation; authoritative status never depends on it.

Affected planned modules: `agent_runtime.py`, `authoring_broker.py`, v2 policy
codec, and actual-dispatch fixtures. The existing experiment configuration and
audit scripts are migration inputs, not sufficient audit evidence.

## 6. Outcomes, cancellation, and cleanup

Use run phases `starting`, `running`, `submitting`, `cleaning`, and `finished`.
Record a primary outcome separately from cleanup: `submitted`, `failed`,
`cancelled`, or `timedOut`; an optional immutable submission record; and cleanup
`notStarted`, `pending`, `succeeded`, or `failed`. A crash after commitment keeps
`submitted` and records runtime diagnostics separately. Cleanup failure never
erases the primary failure or committed submission identity. Admission to build
requires submitted source plus confirmed host cleanup.

| Ordering | Authoritative result and resource effect |
| --- | --- |
| Run cancellation/deadline wins before source commit | No submission; revoke tools, clean host and session, release provisional snapshots |
| Snapshot failure | Failed run; no submission; close session and clean partial resources |
| Submission commits before run cancellation | Preserve submitted outcome and source lease; cancellation joins hosting teardown |
| Agent crashes after commit | Preserve submitted outcome; stop remaining host resources; prepare only if cleanup succeeds |
| Agent exits before explicit submission | Failed run without submission; no automatic source promotion |
| Session cancel/close or owner EOF after commit | Preserve submission identity in terminal accounting; release its physical lease with all session resources |
| Hosting cleanup fails after commit | Submitted identity remains; failed cleanup blocks preparation; session proceeds to failure cleanup |
| Graceful Gate owner loss | Bounded teardown of owned resources; no reconnect/adoption |
| Abrupt Gate process death | Cleanup unconfirmed; clients cannot report success from transport loss |

Submission commitment versus cancel/close is serialized by the same session
lock. A session deadline closes the session even if commit won earlier; a run
cancellation alone after commitment does not discard the submission. Terminal
run observation does not promise the physical source still exists after session
closure. Duplicate submit joins an in-flight submission or returns its recorded
commit while the broker remains open; it never takes another snapshot. After
broker revocation, the outside owner queries status rather than retrying submit.

Run cleanup covers agent/controller descendants, broker sockets, tool processes,
handles, temporary config/credentials, and diagnostic staging. Session cleanup
also covers source/artifact/manifest/shim leases and worker/build resources.
Retained bounded run metadata is deliberately excluded from physical-resource
counts. Use existing 1-second graceful stop and 5-second total teardown-attempt
ceilings; report remaining resource categories if completion is unconfirmed.
Cancellation acknowledgement is not proof of quiescence. Session preparation,
model conformance, and cleanup remain independently reported facts.

## 7. Focused acceptance vectors for AH1.2 and implementation

AH1.2 must encode these as positive/negative shared fixtures and state/race
vectors; this prose list is not machine-readable acceptance evidence.

- V1 client/new server preserves old frames; v2-only hosting client/old server
  allocates nothing; v1 unknown hosting operation still fails closed; v2 catalog
  rejected by old loader; required unavailable runtime allocates no author.
- An accepted run executes its own tool without slot deadlock; a second run and
  concurrent external authoring are rejected; cancellation is never queued
  behind an authoring command.
- Force cancellation before snapshot, during provisional freeze, and after
  commit. Assert exact submission presence, lease ownership, cleanup, and one
  terminal outcome. Modify the live source after commit: preparation retains
  the committed hash and content. Reject repeated preparation.
- Lose the MCP start reply while control remains healthy: inspect the existing
  run without issuing start again. Use another same-UID connection to inspect,
  cancel, prepare, or acquire: all reject without changing the owner's resources.
- Start/status calls return without closing ownership; an embedded integration
  prepares and replays through that same connection. Adapter EOF during replay
  cancels and awaits cleanup. Reconnecting with copied handles remains invalid.
- Required model mismatch and negotiation failure yield no authorization,
  acquisition, or worker launch. The same generic harness works with a local
  implementation and Gate proxy while MirrorECMA imports without Gate installed.
- Mutate an executable without changing its version, alter a tool definition,
  change implicit context behavior, expire a receipt, and exceed each input or
  output bound. Refuse/terminate as specified with no unrestricted fallback.
- Source commit followed by agent crash and cleanup failure retains source
  identity, never claims cleanup success, and prevents build admission. Correct
  cleanup after submission leaves the source lease available for later build.
- Host/build/worker private-canary probes, fresh real-runtime dispatcher audit,
  correct/faulty real replay, and installed Node/C++ consumers remain required
  implementation acceptance. Deterministic race fixtures cannot replace them.

## 8. Historical AH1 handoff and validation of this draft

These are concrete proposed decisions; no parent or user approval of a frozen
contract is implied. AH1.2 still owns complete closed record/error/event schemas,
canonical audit-receipt encoding and hashing, bounded progress cursor semantics,
all policy profile fields, SDK signatures, exact tool names, shared byte fixtures,
and contract-review approval. Those are deliverables, not permission to invent
incompatible per-language choices during runtime work.

No unavoidable architectural question blocks this draft. Runtime support pins
must be selected from actual dispatcher evidence during AH3/AH9; naming a Codex
version here would prematurely claim an audit.

Validation for AH1.1 is source-grounded contract review and document/path checks.
No runtime code or frozen v1 file is changed, and no runtime tests or supported
hosting behavior are claimed.
