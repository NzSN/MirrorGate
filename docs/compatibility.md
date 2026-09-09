# Compatibility and upgrade policy

Status: initial locally verified profile; no published release or hosted CI run
is claimed by this document.

[Managed agent hosting](agent-hosting-design.md) is planned, with Codex as the
first intended runtime integration. There is no supported Gate agent-hosting
profile, launch operation, or agent-runtime version matrix yet. The external
MirrorECMA Counter experiment is migration evidence, not Gate compatibility
certification. Hosting needs an explicit versioned control extension and actual
runtime capability/lifecycle acceptance before being advertised as supported.
The revised target also extracts the existing Gate-aware MirrorECMA facade
into an external integration; no runtime decoupling or export removal is yet
implemented. MirrorECMA will not gain the superseded managed-author option.
The standard outside-agent hosting-tool adapter is likewise planned. Its first
intended transport is stdio MCP over a public native SDK; tool schemas, package
entry points, and tested framework/transport compatibility are not yet frozen.

The optional [evaluation service](evaluation-service-design.md) is a separate
planned profile. Its transport, version, public operations and run references
are not part of frozen Gate control/worker contracts, and have no acceptance
evidence yet. Source-test harness reuse does not imply service support.

| Layer | Initial identity / requirement | Verification scope |
| --- | --- | --- |
| Worker protocol | `v: 1` JSONL | Shared strict-frame/value corpus and lifecycle tests |
| Control protocol | Independent `v: 1` JSONL, experimental | Shared strict-frame corpus, owner-bound operations, public CLI and native client gates |
| Public manifest | `mirrorgate.port/v1` | Sanitized IDs/types plus evaluator-provided interface digest |
| Supervisor backend | `linux-bubblewrap-v1`, Bubblewrap 0.9 or newer, Python 3.12 | Actual Linux/WSL namespace and resource tests |
| Node worker | `node-v1`, Node 24.15.0 | Native codec, lifecycle, cancellation, actual Counter and queue |
| Rust worker | `rust-v1`, Rust 1.96.0 to build | Locked native dependencies, codec/lifecycle, actual Counter |
| SDK packages | Initial `0.1.0` development sources | Local imports/crate path; publication disabled |
| Native control clients | Node SDK and C++17 SDK | The same Python controller and Node/Rust worker profiles; C++ owned close reports checked child-reap status |
| Mirrors semantics | Pinned [source contract](../protocol/source-contract.json) | Portable public type/value definitions, not a runtime dependency |
| Evaluator integration | Matching MirrorECMA async/report APIs and Mirrors checker | Explicit checkout paths/revisions; Counter in both workers |

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
