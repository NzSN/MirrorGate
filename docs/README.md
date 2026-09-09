# MirrorGate design index

Recorded on 2026-09-06 from the architecture discussion establishing MirrorGate.
These documents describe the reference architecture and initial implementation.
The Linux/Bubblewrap supervisor, Node/Rust workers, protocol, conformance suite,
and optional evaluator integration are implemented and locally tested. Guarantees
are limited to the configured backend and documented agent-host integration.

The 2026-09-09 implementation places managed hosting, native v2 access, the
standard outside-agent tool and the external MBT workflow in Gate. The optional
loopback HTTP service uses that same workflow. Destination and coordinated gates
passed; the [validation report](managed-workflow-validation.md) records exact
evidence. Both the actual-implementer MCP protocol harness and real outside-Codex
framework registration/dispatch passed. No release or hosted-CI claim is implied.

## Implementation and acceptance status

| Layer | Status / authoritative reference |
| --- | --- |
| Control v1, native SDKs, restricted tool/build/worker execution | Existing experimental profile remains compatible; [compatibility](compatibility.md) records boundaries |
| Control v2 and managed implementer | Implemented; [v2 contract](agent-hosting-control-v2.md), actual Codex audit and fresh author through the installed MCP protocol harness |
| Coordinator-facing hosting tool | Installed MCP protocol harness and real outer/inner Codex framework workflow passed (AH11.2) |
| MirrorECMA core decoupling and shared harness | External Gate package and MirrorECMA 2 cutover verified in destination/core/live/interop gates |
| Optional evaluation-service proxy | [Loopback HTTP v1](evaluation-service-contract-v1.md), caller authentication and same-suite real Gate/Mirrors checks; no remote/TLS profile |

The coordinator talks directly to Gate. MirrorECMA's target responsibility stays
MBT against a supplied implementation; Gate owns its trusted integration and
supported local evaluation composition. Separate packaging does not transfer
that responsibility to applications. Source-test/CLI suite reuse does not require the optional service.
Mirrors' existing model protocol and compiler remain unchanged.

## Documents

| Document | Read when working on |
| --- | --- |
| [Architecture](architecture.md) | Repository responsibilities, trusted evaluation, shared infrastructure, and language shims |
| [Managed workflow](managed-workflow-design.md) | Gate-owned R1 agent hosting, R2 sandbox/artifacts, and R3 trusted local MBT integration; caller inputs and task mapping |
| [Agent hosting design](agent-hosting-design.md) | Direct coordinator-to-Gate authoring, hosted implementer, external MBT integration, and restricted lifecycle |
| [Agent hosting tasks](agent-hosting-tasks.md) | Implementation assignments, dependencies, contract prerequisites, owned paths, and acceptance evidence |
| [Hosting contract decisions](agent-hosting-contract-decisions.md) | Historical AH1.1 decisions underlying the implemented v2 contract |
| [Agent hosting control v2](agent-hosting-control-v2.md) | Frozen hosting records, bootstrap compatibility, run/source/cleanup lifecycle and shared fixtures |
| [Evaluation-service design](evaluation-service-design.md) | Reusable source-test harness, service versus implementation proxies, run ownership and local evidence |
| [Evaluation service v1](evaluation-service-contract-v1.md) | Authenticated loopback HTTP, closed records, deduplication, retention, cancellation and public results |
| [Orchestration control v1](https://github.com/NzSN/MirrorGate/blob/main/docs/orchestration-control-v1.md) | Shared session workflow, control framing, owner-bound handles, managed worker transport, and cleanup completion for client-guide section 13 |
| [Control policy v1](control-policy-v1.md) | Closed operator catalog for approved roots, build/tool commands, runtime launchers, attestation identities, and limit ceilings |
| [Control usage](https://github.com/NzSN/MirrorGate/blob/main/docs/orchestration-control-usage.md) | Operator policy, owned/attached startup, preparation, authorization, native SDKs, and cleanup |
| [Control policy catalog](https://github.com/NzSN/MirrorGate/blob/main/docs/control-policy-v1.md) | Approved roots, tools, build/runtime plans, immutable leases, and resource ceilings |
| [Control implementation tasks](https://github.com/NzSN/MirrorGate/blob/main/docs/orchestration-control-v1-tasks.md) | Assigned implementation ownership, review cases, acceptance evidence, and follow-on model facades |
| [Sandbox design walkthrough](https://github.com/NzSN/MirrorGate/blob/main/docs/sandbox-design.md) | How a tool request becomes an isolated command, source ownership, and agent-host obligations |
| [Blind validation and isolation](blind-validation.md) | Information access during authoring, building, execution, and result disclosure |
| [Worker protocol](worker-protocol.md) | The public port RPC, value semantics, lifecycle, and compatibility |
| [Implementation plan](implementation-plan.md) | Milestones, dependencies, acceptance tests, and open decisions |
| [Assigned tasks and evidence](tasks.md) | Ownership, implemented work, and verification results |
| [Protocol v1](protocol-v1.md) | Frozen wire/value/lifecycle contract and numerical limits |
| [Linux/Bubblewrap](linux-bubblewrap.md) | Actual isolation mechanism, profiles, limits, and operational caveats |
| [Node worker](node-worker.md) | Node adapter and trusted proxy SDK |
| [Rust worker](rust-worker.md) | Reusable native SDK and Counter binary |
| [MirrorECMA integration](../integrations/mirrorecma/README.md) | Public port proxies with evaluator-only model data |
| [Compatibility](compatibility.md) | Supported identities, version changes, and release/hosted limits |

The central decisions are:

- Keep private specifications and evaluation configuration with the trusted
  evaluator; give implementers a sufficient public interface contract.
- Place worker RPC at the generated implementation port. Keep raw model
  messages and expected states inside the trusted environment.
- Share supervisor policy mechanisms, protocol semantics, and conformance
  fixtures across languages. Use small language-specific runtime shims.
- Keep MirrorGate independent of MirrorECMA internals. MirrorECMA is the first
  supported local evaluator integration, not a required implementation language.
- Treat isolation and observation fidelity as separate requirements.
- Own reusable agent hosting in MirrorGate, with runtime configuration behind
  shared control; retain task/public-context approval and private evaluation
  with the trusted caller. The controller and external integration implement this
  ownership split.
- Supply the standard outside-agent hosting-tool adapter from MirrorGate;
  applications configure and register it in their agent framework.

The first profile selects Python3.12, Linux/Bubblewrap, Node24.15.0, Rust1.96.0,
and the concrete v1 protocol. Additional backends/languages, aggregate cgroup
quotas, production runtime packaging, and release publication remain future work.
