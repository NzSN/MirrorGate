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
