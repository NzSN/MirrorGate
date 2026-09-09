# Compatibility and upgrade policy

Status: destination-integrated development profiles with passed local gates,
2026-09-09. See [final validation](managed-workflow-validation.md) for exact
commands and versions, including passed real outside-Codex MCP acceptance. No
published release, hosted CI success or remote service deployment is claimed.

[Managed hosting control v2](agent-hosting-control-v2.md) adds fresh-agent
start/status/cancel while retaining the v1 bootstrap envelope and frozen v1
records. Node and C++ clients select v2 explicitly. V1 callers receive no hosting
capabilities. Worker attachment/RPC remain v1. Operator policy v2 installs closed
agent profiles; availability requires the permitted backend, exact runtime/config
identity, current dispatcher audit and resolvable credential reference.

The initial Codex adapter targets CLI **0.153.4**. Actual runtime auditing and
fresh SDK-driven authoring passed. The installed
[stdio MCP hosting tool](../integrations/agent-host/README.md) also launched an
actual implementer through a protocol harness; its submitted source passed two
evaluations against the existing mTLS Mirrors server, which remained running.
Real outside-Codex framework registration exposed a standard progress-metadata
compatibility issue. After the fix, the actual coordinator registered the installed
adapter, launched a real implementer and completed submission/MBT/cleanup; AH11.2
passed independently of the earlier SDK and protocol-harness evidence.

The Gate-owned `mirrorgate-mirrorecma` package supplies the R3 local workflow,
prepared provider, trusted/public receipts and compatibility `/legacy` API.
It accepts public MirrorECMA 1/2 peers; the coordinated MirrorECMA 2 development
cutover removes Gate-specific core exports/dependencies while retaining generic
MBT. Installed correct/faulty Counter and shared source/service suite checks
passed together with destination and coordinated cross-repository gates. Exact
results are recorded in the validation report.

The optional [evaluation service v1](evaluation-service-contract-v1.md) uses
literal loopback HTTP with configured caller tokens, approved suite/implementation
references, bounded retention and epoch-bound start deduplication. Its service
proxy is distinct from worker RPC and has its own schemas. Remote HTTP/TLS,
durable restart/adoption and production deployment are not implemented.

The [R1–R3 workflow](managed-workflow-design.md) remains Gate-owned throughout
hosting, snapshots, evaluation and cleanup. Applications supply domain-specific
plans and suites; they do not reproduce experiment lifecycle scripts. Local
acceptance sources and remaining checks are tracked in the
[hosting ledger](agent-hosting-tasks.md).

| Layer | Initial identity / requirement | Verification scope |
| --- | --- | --- |
| Worker protocol | `v: 1` JSONL | Shared strict-frame/value corpus and lifecycle tests |
| Control protocol | Independent v1/v2 JSONL, experimental; v1-shaped bootstrap | Shared strict-frame corpus, owner-bound operations, hosted-run lifecycle and native client gates |
| Public manifest | `mirrorgate.port/v1` | Sanitized IDs/types plus evaluator-provided interface digest |
| Supervisor backend | `linux-bubblewrap-v1`, Bubblewrap 0.9 or newer, Python 3.12 | Actual Linux/WSL namespace and resource tests |
| Node worker | `node-v1`, Node 24.15.0 | Native codec, lifecycle, cancellation, actual Counter and queue |
| Rust worker | `rust-v1`, Rust 1.96.0 to build | Locked native dependencies, codec/lifecycle, actual Counter |
| SDK packages | Initial `0.1.0` development sources | Local imports/crate path; publication disabled |
| Native control clients | Node SDK and C++17 SDK, explicit v2 hosting | Same Python controller; owned/attached lifecycle and committed-source tests; C++ close checks child reaping |
| Managed agent runtime | Codex CLI 0.153.4, current profile audit | Actual SDK/MCP-harness author, dispatcher denial probes and per-run descendant cleanup |
| Outside-agent hosting tool | `mirrorgate/hosting-tool`, stdio MCP 2024-11-05 | Actual implementer through installed protocol harness and real outside-Codex framework passed |
| Mirrors semantics | Pinned [source contract](../protocol/source-contract.json) | Portable public type/value definitions, not a runtime dependency |
| Evaluator integration | `mirrorgate-mirrorecma` 0.1.0, public MirrorECMA 1/2 APIs | Packed declarations, prepared/hosted local workflow, correct/faulty Counter and separate cleanup receipts |
| Optional evaluation service | `mirrorgate.evaluation-service-contract/v1`, loopback HTTP | Authenticated proxy, caller isolation, bounded cancellation/retention and same-suite local/Gate-backed replay |

C++ and Lean workers, non-Linux backends, cgroup aggregate quotas, crash-recovery
garbage collection, and packaged production runtime images remain future work.
The operator owns and approves the backend's public `/usr`/runtime trees. Their
contents are not made reproducible merely by pinning the SDK/compiler versions.
Deployment records must identify those trees and the actual host/kernel policy.
The [SDK compatibility manifest](https://github.com/NzSN/MirrorGate/blob/main/sdk/compatibility.json)
records the control/worker versions and build prerequisites. Language SDKs and
the shared Python process are distributed separately. Package-consumer tests
establish local installability. The experimental local MirrorECMA/MirrorCPP
shared matrix is recorded in the linked acceptance ledger; hosted CI,
publication, and released support remain pending.

Protocol version, public interface digest, frozen artifact hash, runtime profile,
SDK package version, and private evaluation specification revision have different
meanings. None may silently substitute for another. A worker handshake echoes
the expected interface identity; it does not attest the honesty of worker code.

Version 1 rejects unknown fields and operations. Changes to its wire shape,
lifecycle/cancellation ordering, or portable value semantics require a versioned
compatibility decision and shared regression vectors. A new runtime must pass
the same applicable conformance corpus and real backend/evaluator cases before
being marked supported. SDK implementation bug fixes must preserve the frozen
contract and existing public fixture outcomes.

CI pins action commits and language versions, installs locked Rust dependencies,
and runs `scripts/test.sh` with required isolation. Optional evaluator CI accepts
explicit full commit SHAs for both companion repositories; it never silently
checks out their moving default branches. A disabled optional job is not evidence
of evaluator integration. Release publication and successful hosted workflow
runs must be recorded separately when they happen.
