# MirrorGate implementation plan

Status: initial profile, managed hosting, external MBT workflow and optional local
HTTP service implemented and exercised locally, 2026-09-09. See the
[hosting task ledger](agent-hosting-tasks.md) and
[validation report](managed-workflow-validation.md) for passed destination and
coordinated gates, including actual outside-Codex MCP acceptance (AH11.2). Hosted
release and separately maintained private-corpus evaluation remain distinct work.

Read the [architecture](architecture.md), [isolation requirements](blind-validation.md),
and [worker protocol](worker-protocol.md) together before implementing a seam.

## M0 — Freeze the first supported profile

- [x] Choose supervisor implementation language and first supported OS/backend.
- [x] Choose Node plus one native worker language for the initial matrix.
- [x] Define the public artifact/type contract and its versioned dependency on Mirrors.
- [x] Specify concrete framing/schema, correlation, numerical resource limits,
  cancellation, and error/disposal rules.
- [x] State the backend threat assumptions and denied/allowed capabilities.

Done: two independent runtime implementers can produce compatible workers from
the written contract, and the isolation claims have executable acceptance cases.

## M1 — Protocol and conformance foundation

- [x] Add versioned schemas or equivalent authoritative protocol definitions.
- [x] Add public value vectors and lifecycle/malformed-message fixtures.
- [x] Implement a trusted transport/proxy with bounds and strict correlation.
- [x] Verify a test worker cannot inject extra operations or gain capabilities
  through malformed messages or submission-controlled launch metadata.

Done: the evaluator exercises the full proposed lifecycle against deterministic
test workers and rejects every defined invalid case.

## M2 — Supervisor and first sandbox backend

- [x] Launch approved runtime profiles with explicit mounts, environment,
  network policy, and resource limits.
- [x] Provide separate build execution with no private evaluator material.
- [x] Own cancellation, forced termination, exit classification, and cleanup.
- [x] Execute access-denial and resource-exhaustion tests in the actual backend.

Done: submitted code is confined according to the chosen profile, and each
claimed restriction has passing evidence. Unsupported platforms remain explicit.

## M3 — Two language shims

- [x] Implement Node loading, native conversion, invocation, and disposal.
- [x] Implement the chosen native-language shim using the same protocol.
- [x] Run identical conformance vectors and compare observable outcomes.
- [x] Keep application adapters separate from shim/runtime infrastructure.

Done: both workers drive real implementations through the same public port
contract, including failure and cancellation cases.

## M4 — Trusted evaluator integration

- [x] Add MirrorECMA integration through generated async port proxies.
- [x] Keep specifications, configuration, raw Mirror messages, and detailed
  results in the trusted evaluator.
- [x] Use a public Counter example and a stronger queue example for integration.
- [ ] Evaluate a frozen submitted artifact against separately held private cases.
- [x] Verify the worker receives only approved port inputs, including at initialization.

Done: Mirrors and the trusted client validate both language workers, correctly
reject faulty implementations, and pass the defined oracle-access denial tests.

## M5 — Release and compatibility

- [ ] Pin toolchains, dependencies, runtime images, and the selected backend.
- [x] Record a protocol/SDK/runtime compatibility matrix and upgrade policy.
- [ ] Run conformance/isolation gates in CI for every supported worker profile.
- [x] Document operational requirements, diagnostics, and verified limitations.

Done: a clean checkout reproduces the supported matrix and the release states
exactly which profiles and isolation guarantees were exercised.

## M6 — Managed agent hosting (destination and actual framework verified)

The [agent-hosting design](agent-hosting-design.md) is implemented through
[control v2](agent-hosting-control-v2.md), the runtime/broker and native SDKs.
The [task ledger](agent-hosting-tasks.md) records named implementer ownership,
local evidence and the remaining checks. Historical experiment helpers supplied
migration inputs; applications now use Gate's public modules.

- [x] Freeze control v2, closed operator profiles, runtime requirements, limits,
  ownership and submission/cancellation ordering; retain frozen v1 compatibility.
- [x] Implement the Codex 0.153.4 adapter, restricted broker/tools, fresh context,
  credential custody, runtime dispatcher audit and per-run descendant cleanup.
- [x] Own fresh runs through source commitment and bounded cleanup; prepare
  exactly once from the same frozen lease after confirmed host cleanup.
- [x] Expose shared lifecycle through Node and C++ v2 clients with owned/attached
  control and no client-owned implementer launcher.
- [x] Extract Gate-aware evaluation into `mirrorgate-mirrorecma`; implement the
  coordinated MirrorECMA 2 core cutover without a managed-author core option.
- [x] Supply `mirrorgate/hosting-tool` and its stdio MCP CLI, approved task/run
  references, registration/configuration and installed dispatch tests.
- [x] Supply the R3 local workflow and trusted/public receipts (AH8.6), plus an
  installed Counter application requiring no per-run lifecycle/packing scripts
  (AH8.7). Correct/faulty and same-owner callback paths pass locally.
- [x] Exercise actual SDK-driven Codex authoring and an actual implementer through
  the installed MCP protocol harness; validate the same submitted source twice
  against the independently running mTLS Mirrors server.
- [x] Complete real outside-Codex framework registration and the outer/inner-agent
  workflow after the standard progress-metadata compatibility fix (AH11.2).
- [x] Complete destination and coordinated Gate/MirrorECMA/Mirrors gates; record
  exact identities and exits in the authoritative validation report.

Completion requires the full declared hosting acceptance, compatible native
clients and final destination gates. Resume, follow-up messaging, delegation,
automatic retries and production publication remain outside this first profile.

## M7 — Reusable harness and optional local evaluation service

- [x] Extract a reusable trusted suite with source-test and CLI entry points,
  deferred local/proxy factories and unchanged generic MirrorECMA MBT semantics.
- [x] Freeze the separate [evaluation-service v1 contract](evaluation-service-contract-v1.md):
  caller authentication, approved references, epoch/start-key deduplication,
  bounded retention, deadlines, cancellation and public result projection.
- [x] Implement the optional loopback HTTP service and supplied proxy through the
  existing R3 workflow. Installed correct/faulty Counter results agree with the
  same source suite using real Gate workers and Mirrors; cleanup is confirmed.
- [x] Test malformed/cross-caller requests, uncertain replies, floods, stalled
  responses, getter mutation, local polling deadlines and failed/unconfirmed
  cleanup. Keep model/control/worker/service handles and private data separate.
- [x] Include destination service/package and installed workflow/MCP checks in
  coordinator validation evidence.

Source tests and base hosting remain usable without the service. This profile
exposes only authenticated loopback HTTP; remote HTTP/TLS, durable restart and
remote Gate control are not implemented. No MirrorECMA service API is introduced.

## Work assignment boundaries

After M0, separate ownership can cover the supervisor/backend, protocol and
trusted proxy, each language shim, and evaluator integration. Shared schemas
and lifecycle rules need one owner; dependent work starts from that interface.
Concrete ownership and current hosting/migration/service acceptance are recorded
in [agent-hosting-tasks.md](agent-hosting-tasks.md); the initial worker profile
remains recorded in [tasks.md](tasks.md).

Runtime code and documented local commands are implemented. Hosted CI execution,
release publication, controlled runtime image packaging, and separately maintained
private evaluation cases remain future deployment/application work. The current
evaluator smoke uses public development models in evaluator-only temporary files;
it does not claim that those models were unseen by their implementers.
