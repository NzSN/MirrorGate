# MirrorGate v1 tasks and assignments

Status: initial implementation completed and locally verified. This task breakdown implements the existing
[milestone plan](implementation-plan.md) and [architecture](architecture.md).

## M0 decisions

- Shared supervisor: Python 3.12 with the standard library.
- First isolation backend: Linux with Bubblewrap 0.9.0; no privileged daemon,
  host security-setting changes, or unsandboxed fallback.
- First language workers: Node 24.15.0 and Rust 1.96.0, using the same public
  port manifest and JSONL protocol.
- Wire/value/lifecycle contract: [protocol v1](protocol-v1.md). It reuses the
  portable model-interface semantics while excluding private source/projection
  metadata from the worker manifest.
- Scope of resource guarantees: enforce the selected backend's explicit limits.
  Distinguish per-process limits from aggregate cgroup accounting; reject a
  requested guarantee that this backend cannot enforce.

The actual host namespace probe and required-backend access-denial tests passed.
The [Linux profile](sandbox/linux-bubblewrap.md) records the exact enforced limits and
the limits that it rejects.

## Owned work packages

| Task | Owner | File ownership | Acceptance |
| --- | --- | --- | --- |
| G1: Freeze protocol, manifests, and values | `gate_protocol` | `protocol/`, `conformance/vectors.jsonl`, Python protocol module, protocol tests/docs | Strict bounded parsing, type validation, and shared positive/negative vectors |
| G2: Supervisor and author/build/run profiles | `gate_supervisor` | Python supervisor/policy/artifact/CLI modules, supervisor/isolation tests, backend guide | Real namespace confinement, immutable submission handoff, limits, termination, and cleanup |
| G3: Node shim and trusted proxy | `gate_node` | `runtimes/node/`, `sdk/node/`, Node tests and guide | Delayed adapter construction, strict lifecycle, native conversion, cancellation, and trusted correlated RPC |
| G4: Rust shim and SDK | `gate_rust` | `runtimes/rust/`, Rust tests and guide | Same vectors/lifecycle; exact integer semantics; real correct/faulty native adapter |
| G5: Cross-language and evaluator integration | Coordinator | Common Counter manifest, conformance driver, `integrations/`, build/test scripts | Both workers exercise the same operations and run through private evaluator port proxies |
| G6: Documentation, reproducibility, final review | Coordinator | README/AGENTS, root tooling/CI, master plans and final integration fixes | Documented commands work; recorded limits match actual backend evidence |

Workers preserve one another's edits. Shared protocol decisions are owned by
G1 and communicated before dependent runtime changes. The supervisor supplies
the sandbox channel; the Node proxy consumes it without depending on MirrorECMA
internals. Root build/configuration and shared manifests have one owner.

## Execution order

- [x] G1: Publish protocol schema and shared vectors; agree Python/Node/Rust APIs.
- [x] G2: Implement and verify each requested sandbox profile and freeze handoff.
- [x] G3: Implement Node SDK, worker, and real Counter adapters.
- [x] G4: Implement Rust SDK, worker, and real Counter adapters.
- [x] G5a: Run the same valid/invalid/cancellation sequences against both workers.
- [x] G5b: Integrate generated MirrorECMA async port proxies with frozen workers.
- [x] G5c: Verify private-file/credential/process/network denial, faulty SUT
  rejection, and cleanup in the actual backend.
- [x] G6: Run the clean build/test matrix and record platform/hosted limitations.

Work is prepared in an isolated copy of the initial repository because the
destination is outside the session's default writable roots. Verified source
changes are applied back to `/home/nzsn/Repos/MirrorGate` with a baseline
check. This implementation does not automatically commit or push changes.


## Local execution evidence

- `RUSTUP_TOOLCHAIN=stable bash scripts/test.sh` passed with actual rustc/cargo
  1.96.0: 40 Python tests (including 15 required actual isolation cases and the
  authoring gateway), 165 Node tests, two evaluator value/export tests, four
  Rust unit tests, ten native lifecycle tests, and the 107-vector shared corpus.
- Both runtimes passed the same six lifecycle cases inside real Bubblewrap,
  plus exact large integers, reset, and the faulty Counter through the trusted
  proxy. This is separate from process-only codec unit tests.
- The optional MirrorECMA smoke passed both correct/faulty Node and Rust Counter
  workers and the Node filesystem queue. Models/traces remained evaluator-only;
  worker bundles contained only public shim code, manifests, and adapter/SUT.
- Required isolation checks exercised all three profiles, secret environment,
  private files, host process views, inherited descriptors, network/nested-userns
  denial, read/write mounts, frozen sources, malformed configuration, resource
  limits, output/backpressure, cancellation/EOF, and descendant cleanup.
- Cross-review found and fixed inherited directory file descriptors in submitted code and
  runtime/output mount overlap. SDK review fixed launch failure cleanup,
  mutable manifests, pending-dispose cancellation, and awaited termination.
- Exact language tool versions, Cargo.lock, pinned source contracts, and immutable
  CI action revisions are recorded. Workflow actionlint and shell syntax passed.

Current limitations: Linux/WSL was exercised; Windows/macOS, other workers,
aggregate cgroup quotas, crash-recovery snapshot garbage collection, hosted CI,
and release publication were not implemented or executed. The operator must
approve public runtime trees and avoid independent writable aliases; the host
must route all agent resource tools through the managed boundary. Native
pre-main code is confined by launch-time isolation, not controlled by the SDK
factory handshake.

The initial implementation supplies the mechanism for private evaluation;
private held-out corpora and disclosure policy remain evaluator-owned. Public
Counter/queue development cases are not represented as unseen evaluation data.
