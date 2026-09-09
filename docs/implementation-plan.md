# MirrorGate implementation plan

Status: initial local profile implemented. See [assigned tasks and evidence](tasks.md).
Hosted release and private-corpus evaluation remain distinct follow-up work.

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

## M6 — Managed agent hosting (planned)

The accepted [agent-hosting design](agent-hosting-design.md) makes the trusted
agent host an optional MirrorGate module. Every item below is unimplemented;
the external Counter experiment helpers are migration inputs only.

- [ ] Specify the versioned control extension, operator agent profiles, supported
  runtime requirements, limits, ownership, and submission/cancellation ordering.
- [ ] Promote generic launcher, broker, context/tool configuration, and cleanup
  into Gate; implement the first supported Codex runtime integration.
- [ ] Own fresh agent runs through submission, source sealing, and bounded
  cleanup, preserving existing preparation and worker admission ordering.
- [ ] Expose the same lifecycle through native clients without client-owned
  launchers or a manually started separate agent-host daemon.
- [ ] Migrate the MirrorECMA experiment to that interface, retaining task/public
  context approval and private evaluation in its trusted caller.
- [ ] Verify actual tool denial, context isolation, credential custody, foreign
  handles, sealing races, failure cleanup, and fresh private evaluation through
  the public interface with two native clients.

Done: the hosting acceptance matrix passes on the declared agent/runtime/backend
versions, existing gates remain green, and compatibility records the evidence.
Resume, follow-up messaging, delegation, and automatic retries remain future work.

## Work assignment boundaries

After M0, separate ownership can cover the supervisor/backend, protocol and
trusted proxy, each language shim, and evaluator integration. Shared schemas
and lifecycle rules need one owner; dependent work starts from that interface.
Concrete subagent ownership and first-profile selections are recorded in
[tasks.md](tasks.md).

Runtime code and documented local commands are implemented. Hosted CI execution,
release publication, controlled runtime image packaging, and separately maintained
private evaluation cases remain future deployment/application work. The current
evaluator smoke uses public development models in evaluator-only temporary files;
it does not claim that those models were unseen by their implementers.
