# Local evaluation workflow contract

AH8.6/AH8.7 API contract, 2026-09-09. This document fixes the optional integration's
local composition seam. Gate's existing supervisor and public SDK remain the only
owners of authoritative hosting, submission, preparation and worker transitions.

`evaluateImplementation(plan, options)` accepts trusted configuration:

- `taskRef`, `policyId`, `runtime`, approved `submission`, optional `agent` and
  tightened Gate `limits`; `gate` selects an owned endpoint or attached socket.
- `model`: reviewed generated model metadata/public-port binder.
- `suite`: `{id, revision, modelRevision, context, run}`. The approved suite function
  takes `(context, AsyncAdapterFactory)` and returns an ordinary compiled replay
  report. Context holds the existing Mirrors transport/configuration/trace paths.
- `disclosure`: fixed booleans for optional counts, artifact/source hashes, and
  failure-stage disclosure. Default results contain only a generated run reference,
  overall outcome and independent cleanup status.

Options carry cancellation, generic replay deadlines, bounded hosting/evaluation
waits and a trusted diagnostic sink. Context signal is combined with the workflow
signal. The application chooses and freezes its approved suite/configuration;
this integration neither interprets the model nor authenticates a suite identity
merely because the caller labels it with a revision.

Source with `agent` requires authoring enabled and control v2 hosting capability.
Source without `agent` must disable authoring and is prepared as approved existing
source. Approved prebuilt artifacts use the same deferred evaluation path.
Agent completion must be explicit submission with confirmed host cleanup; the
prepared source hash must match the committed submission hash. Natural-language
completion or a failed/timed-out author is never treated as submission.

The workflow opens one dedicated owner connection and retains it through all
stages. It prepares through `session.prepare`, supplies the existing deferred
provider to the suite, and always joins provider/session/client cleanup. Required
model negotiation precedes factory admission. No alternative launcher, credential
copy, broker, snapshot algorithm, worker state machine or model comparator lives
in this package. The caller does not implement those lifecycle steps.

`evaluateHostedSubmission(context, plan, options)` supports the standard Gate
hosting tool's trusted `onSubmitted` hook. Context contains the original dedicated
`client`, `session`, terminal `run`, `taskRef` and cancellation signal. It requires
the same owner identity, rechecks the terminal submission through that session,
and uses that exact session. Ambiguous owner/task pairs are rejected before
consuming either connection. After cleanup, its optional
trusted `completeCleanup` hook receives the confirmed/failed cleanup receipt,
allowing the hosting tool to avoid repeating session closure. No serialized handle
or reconnect is accepted. `createHostedEvaluationHandler(plans, options)` selects
an approved plan by exact task reference and supplies this hook directly.

Both entry points return `{receipt, publicResult}`. Trusted receipts keep suite,
model/interface, hosted submission, source/artifact correlations, model outcome,
primary rejection and cleanup evidence as separate fields. A model pass with
failed/unconfirmed cleanup is not an overall pass. Cleanup errors never replace
the primary model rejection, including non-Error JavaScript rejection values.
Failure before factory invocation still releases the prepared source and owner.
Late factory/runner continuations cannot acquire a worker after closure.

`publicResult` is a bounded field allowlist, never a serialization of the trusted
receipt. It excludes private model reports, expected states, traces, host paths,
credentials, control handles, full author output and arbitrary exception messages.
The service layer may publish this result; it retains the trusted receipt locally.

The installed Counter example uses the same generic suite as MirrorECMA's source
tests/CLI. Fixture installation may copy the suite and rewrite only import
specifiers to installed public packages and local compiler output. Normal runs
consume that installed application module/configuration and never compile client
libraries, pack repositories or copy per-run host scripts.

## Application suites and persistence

`evaluateSuite(suite, options)` runs a public MirrorECMA `SuiteDefinition` through
the same retained owner and requires a suite-capable MirrorECMA installation.
Older supported clients retain their low-level APIs. Options carry `mirror`, the approved `environment`
(`taskRef`, `policyId`, `runtime`, `gate`, optional tightened `limits` and
`disclosure`), `submission`, and an optional approved `agent`. Generated
`suite.model` metadata and its public-port binder supply the legacy model adapter
internally. `timeouts` uses MirrorECMA's registration/action/receive/cleanup
budgets. `cleanupMs` is passed independently to provider and owner cleanup; these
wait budgets never change operator resource limits.

An existing hosting-tool callback passes `hosted` with the original in-process
owner instead of `submission`/`agent`. No reconnect, session adoption or second
owner is permitted. Cleanup remains required when model negotiation prevents the
factory from starting a worker.
Managed authoring started by `evaluateSuite` requires the negotiated
`hosting.public-environment-v1` capability. For an already owned hosting-tool
handoff, its original owner selects this capability when opening the connection;
the handoff cannot renegotiate an existing connection.

The result uses `mirrorgate.suite-evaluation/v1`, with `outcome`, the unchanged v1
`receipt` and `publicResult`, the normalized trusted `suiteResult` when execution
entered the suite, and separate `persistence` evidence. A complete compiled report
with `acceptance.status === "unmet"` is a failed evaluation; its conformance and
legacy model status still record the matching replay. Local cooperative cleanup
and Gate physical cleanup retain their separate scopes.

Optional `receipt: {path, maxBytes?, signal?}` writes a combined
`mirrorgate.suite-receipt/v1` envelope after physical cleanup. Persistence failure
sets the new overall `outcome` to `failed` while preserving all original model,
acceptance and physical cleanup evidence. The existing public allowlist is
unchanged; normalized failures, action names, coordinates and arbitrary rejection
text never become author-visible through this API.

`writeTrustedReceipt(value, options)` is also available independently. On the
supported Linux profile it requires an absolute file path inside an existing
evaluator-owned parent that is not writable by other users. Every parent path
component is opened without following symbolic links and publication is anchored
to that directory inode. A private mode-0600 temporary file is completely written
and synchronized, then an exclusive hard link publishes it atomically. Both
temporary and published files have mode 0600; existing files and symlinks are
never overwritten. Cleanup removes temporary files on interruption or failure.
Cancellation before publication leaves no record; a completed publication is
committed even if a later cancellation arrives. This is complete-record
publication, not a durable-supervisor-restart guarantee.

Serialization reads bounded own data properties without invoking accessors,
`toJSON`, or object coercion. Cycles, inaccessible properties, unsupported
primitives and truncation receive explicit markers; a final byte limit rejects
oversized records. Receipts are trusted private evidence, never a disclosure
format. Synchronous hostile proxy traps cannot be forcibly preempted in the
evaluator process; do not execute untrusted application code there.
