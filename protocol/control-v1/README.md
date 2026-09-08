# Control protocol v1 records

`contract.json` is the machine-readable source of exact operation, result,
attachment, and event spellings shared by the supervisor and native SDKs.
`schema.json` validates control request/response/event envelopes. Unknown fields
are rejected by the reference codec even where JSON Schema cannot express an
operation-dependent result.

Operation outcomes use one of these closed records:

* pending: `{"operationId":n,"status":"pending"}`
* success: `{"operationId":n,"status":"succeeded","result":...}`
* failure: `{"operationId":n,"status":"failed","error":...}`

The same success/failure record is the data of `operation.finished`. The broker
attachment prefix is a separate, at-most-4-KiB JSONL exchange and is never sent
to the worker. Worker release is Gate-owned and is identified by the literal
`releaseMode: "control-v1"` in `worker.acquire`. Its `attachmentTimeoutMs` is a
remaining duration enforced against Gate's monotonic clock. A release is
accepted as `{"operationId":n,"cleanupMode":...}`. `dispose-then-terminate`
arms closing and permits the native request-ID owner to send at most one legal
cooperative worker-v1 `dispose`; `terminate-only` permits none. Gate owns the
concurrent worker force-stop timer in both modes. The native worker proxy never
signals worker processes or repeats disposal. An owned control launcher may
reap only the controller process it started, after allowing its bounded cleanup;
an attached client may only close its connection.

Every field named by `nestedRecords` is closed. Capability limits and resource
counts are safe nonnegative JSON integers; hello limits and requested tightened
limits are strictly positive. Capability `reason` is an operator-defined stable public ID
with the catalog-ID syntax and is required exactly when `available` is false.
Unavailable capabilities have `enforcedScope: "none"`; available capabilities
have a concrete enforced scope. `CommandResult` byte
fields count raw stdout/stderr bytes emitted by the backend, before base64
encoding and subject to backend caps. `attachmentTimeoutMs` is a positive safe
integer. Endpoint paths are canonical absolute filesystem Unix-socket paths,
at most 107 UTF-8 bytes, with no NUL, empty, `.` or `..` component.
Attestation `registrationId`, `adapterId`, `targetProfile`, and contract/schema
identifiers are nonempty Unicode-scalar strings of at most 128 UTF-8 bytes;
they are opaque and may contain UUID punctuation or `/`.

Capability reports may additionally use `limit.address-space-v1` with
per-process scope, `limit.uid-processes-v1` with host-UID scope, and
`quota.aggregate-v1` as unavailable. Clients validate capability ID grammar and
report fields rather than rejecting future unknown IDs; an unknown required ID
is unavailable during handshake.

Hello has at most 64 distinct capability reports and must cover every required
capability as available. Reported resource ceilings use the maximum approved
catalog ceiling; a selected session may have tighter limits. Address-space and
UID-process limits have separate report entries so their enforced scopes are
unambiguous.

The shared fixtures carry a `request` alongside each response and an
`operation` alongside terminal outcomes where needed. These fields are test
context, never wire-envelope fields. Every SDK validates all fixture kinds.
Responses correlate with the request ID, operation-status replies with the
queried operation ID, and nested error operation IDs with their outcome.
`operation.finished` permits only a success or failure. Its result is checked
against the original accepted operation's `Prepared`, `CommandResult`, or
`CleanupResult` record; it is not an arbitrary JSON object.

`remainingResources` has at most 64 unique catalog-style labels. A terminal
`closed` phase pairs with `succeeded` cleanup and an empty remaining list;
`cleanupFailed` pairs with `failed`. A failed cleanup may have an empty list
when all physical resources have been removed. `preparedRevision` is exactly
the integer 1. Prepared artifact/manifest/source hashes are lowercase SHA-256
hex strings, separate from opaque artifact and authorization handles.

For `authoring.output` and `build.output`, `chunk` starts at 1 and is contiguous
for each `(sessionId, operationId, stream)` tuple. Stdout and stderr therefore
have independent counters, and each accepted operation starts fresh counters.
`worker.exited.reason` uses the same stable reason set as cleanup requests.
Backend `wall_timeout` becomes `deadline`, `client-disconnected` becomes
`client-failure`, and other unplanned attachment/protocol/process exits become
`worker-failure`. A recorded session cleanup reason takes precedence, including
`normal` after successful cooperative disposal.
