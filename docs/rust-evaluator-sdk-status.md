# Rust evaluator and SDK implementation status

Implementation record for the [approved plan](rust-evaluator-sdk-plan.md).
Accepted locally on 2026-09-18. The final Rust evaluator matrix passed 20/20
rows, and its normalized outcomes/cleanup match the C++ and TypeScript reference
cases. No package release, hosted CI or deployment is claimed. Durable rows,
source hashes and reproducibility manifests are in the
[implementation evidence](rust-evaluator-sdk-evidence.json).

## Delivered source boundaries

| Component | Location | Scope |
| --- | --- | --- |
| Native Gate SDK | [sdk/rust](../sdk/rust/README.md) | Linux control-v1, worker-v1, owned stdio/attached Unix, strict codecs, opaque owner-bound handles, cancellation and checked cleanup |
| Model admission | [MirrorRust](../../MirrorRust/README.md) | Compiled verify negotiation, exact adapter registry, deferred factory, fallible replay and disposal; no mandatory Gate dependency |
| Optional evaluator | [integrations/mirrorrust](../integrations/mirrorrust/README.md) | Preparation and required model match before worker acquisition, public-port binding, primary-error precedence and cleanup receipts |
| Acceptance | [run-rust](../conformance/control-v1/run-rust) | Required real controller/worker matrix, Node independence, privacy probe and dependency provenance |

The Counter adapter is handwritten acceptance code with identity
`mirrorrust-counter-fixture-v1`, using the reviewed compiler-produced Counter
contract/digest. It is not the planned general `mirrorrust-v1` emitter. The generic
evaluator composition seam accepts a caller-supplied worker binding and trace
configuration. The current facade starts its model peer over local stdio; native
Gate control is local stdio or filesystem Unix, not remote Gate control.

## Review and validation scope

The SDK tests use the production validators for the existing 72 control and 107
worker vectors. Additional tests cover strict numbers/depth, ordinary JSON keys
under serde feature unification, semantic nested-set uniqueness, owner isolation,
wrong correlation, cancelled/deadline/EOF calls, partial acquisition, malformed
worker replies, bounded writes, descriptor recovery, and checked close receipts.

MirrorRust negotiation tests reject malformed status-specific fields before
fallback, correlate structured failures to the requested digest, reject malformed
canonical map-key literals, and preserve additive outer JSON values. Required
model failures must execute zero factories/SUT callbacks; successful creation
must dispose once even after a callback failure or panic.

The required live Rust matrix is 20 rows: owned/attached controller × Node/Rust
worker × correct/faulty/wrong-digest/generate-correct/generate-faulty. Extra probes
check a Rust worker with a failing Node sentinel and an implementation that
changes its observation if it detects a private canary. Existing source/build
isolation tests separately check actual private file/environment/inherited-FD
denial and frozen handoff. These are bounded tests, not a proof of whole-program
privacy or heap leak-freedom.

## Validation prerequisites

Use Rust 1.96, Python 3.12, Bubblewrap 0.9 with working non-root namespaces,
Node 24.15 for Node-worker cases, and the pinned Mirrors/Apalache toolchain.
The resumed local run uses checksum-verified Node 24.15 and Apalache 0.61 from
ignored `.work/toolchains/`; neither replaces the operator's global installation.

Unix sockets and real isolation require normal host OS permissions. A restrictive
outer command sandbox may deny those operations; run the required tests in the
authorized host environment rather than weakening assertions or counting skips
as passes. Local test evidence, hosted CI, package publication and deployment
remain separate claims. No Windows/macOS isolation or control-v2 Rust hosting
support is claimed.


## Recorded acceptance

| Gate | Result |
| --- | --- |
| Rust SDK | 32/32 tests in default and all-features modes; includes 72 control and 107 worker vectors; both Clippy profiles and formatting passed |
| MirrorRust | Full 65-test run including real TCP/mTLS passed; later test-only unauthorized case passed in the 12-case MI suite, covering 66 distinct tests overall; protocol suite 32/32 |
| Rust integration | 2/2 focused tests; 20/20 actual controller/worker rows, with confirmed cleanup and controller-close receipts |
| Negative admission | Four wrong-digest rows: zero factories, worker acquisitions, worker-start events and adapter dispatches |
| Independence/privacy | Node sentinel untouched for Rust worker; worker-visible canary and public-evidence checks passed; no raw-frame-capture claim |
| Reference parity | C++ 20 rows and TypeScript 22 rows (including source-author/cancellation); 20 common cases have equivalent normalized outcomes and cleanup |
| Existing Gate regression | Python 252, Node 226 plus four integration tests, C++ native/real-control cases, Rust worker 15, and real Bubblewrap conformance/lifecycles passed |
| Packaging | Extracted SDK crate built and ran a separate consumer without checkout-file access |
| CI wiring | Shell/YAML/JSON/static links checked; optional matching-SHA Rust evaluator dispatch added, not hosted-run |

The monolithic Gate regression preceded only the last narrow Rust SDK validator
fixes. Those final sources were covered independently by both 32-test feature
configurations, Clippy, the final package consumer and current-binary live matrix;
unchanged Python/Node/C++ behavior was not needlessly rerun. Earlier test startup
failures were isolated and corrected with bounded Node/C++ concurrency and a
specific test-only executable-busy retry. Required tests were not weakened or
silently skipped.

Run the SDK gate with `bash scripts/test-control-rust.sh`. For live acceptance,
set explicit `MIRRORRUST_ROOT`, `MIRRORS_ROOT`, `APALACHE_MC`, and
`MIRRORGATE_NODE_RUNTIME_ROOT`, then run `bash conformance/control-v1/run-rust`.
These scripts require prepared locked dependencies and the stated OS permissions.
Raw local logs are retained under `.work/rust-evaluator/`; durable evidence above
records their hashes and the commands/identities needed to interpret the results.

The reference matrix completed its 42 rows before a tool-version probe timed out
in the manifest postlude. QA completed that manifest separately using retained
row evidence; the initial shell invocation is not reported as a zero-exit run.
