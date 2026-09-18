# Rust evaluator and control SDK plan

Status: RGE-01–07 implemented and accepted locally on 2026-09-18. See the
[implementation status](rust-evaluator-sdk-status.md) and
[retained evidence](rust-evaluator-sdk-evidence.json) for exact gates, source
identities and limitations. This is not a generated Rust target, production
publication or hosted-CI claim. Existing `runtimes/rust` remains the worker side.
Planning baseline: MirrorGate `75076b0`, MirrorRust `68e36e4`.


## Objective and boundaries

A trusted Rust evaluator should use the same Gate controller, admission policy,
frozen artifacts, worker protocols and cleanup ownership as the native C++
integration. It must not require MirrorECMA or a Node evaluator at runtime.
Node may still be selected as the submitted worker runtime.

- `sdk/rust/`: control and managed-worker client, no Mirrors replay semantics.
- `integrations/mirrorrust/`: optional model-facing composition and acceptance.
- `MirrorRust/src/`: generic model negotiation and binding prerequisites, no
  mandatory Gate dependency.
- Python controller: sole owner of authoritative lifecycle and isolation.
- `runtimes/rust/`: existing untrusted-side runtime, kept separate from evaluator.

Initial scope is control-v1 and worker-v1, owned stdio and attached filesystem
Unix sockets on the existing Linux/Bubblewrap backend. Managed authoring/control-v2
is a separately specified extension. No new controller transport, generated Rust
compiler target, Windows isolation backend or production publication is implied.

## Assigned planning roles

| Agent | Role | Planning ownership | Required result |
| --- | --- | --- | --- |
| `rust_gate_sdk_plan` | Rust control-SDK architect | Control transport, codecs, sessions, capabilities and managed-worker client | Public Rust API/module design and implementation tasks with fixture acceptance |
| `rust_gate_bridge_plan` | Rust evaluator integration architect | MirrorRust prerequisites and optional Gate integration | Safe post-match factory boundary, binding strategy, error/receipt handling and integration tasks |
| `rust_gate_acceptance_plan` | QA and release-planning owner | Shared matrices, isolation, packaging and documentation | Executable acceptance plan, evidence requirements and release gates |
| Parent | Integration owner | Cross-task dependency ordering and review | Reconciled plan; no conflicting file ownership or unsupported support claims |

Each agent received the existing C++ SDK/integration as the reference, the
Mirrors MI/SO obligations, repository ownership boundaries, and instructions to
produce a read-only design. No implementation or test execution is delegated in
this planning pass.

## Implementation sequence

1. **RGE-01 — Fix the public seam and acceptance profile.** Decide supported
   control/worker versions, crate names, transport ownership, error/result types,
   source of reviewed binding metadata, and compatible peer identities. Keep all
   model negotiation and expected state outside worker traffic.
2. **RGE-02 — Implement Gate Rust SDK core.** Add strict bounded framing and JSON,
   request/event correlation, capability negotiation, owned/attached transport,
   connection-bound sessions/operations and bounded close receipts.
3. **RGE-03 — Implement managed-worker access.** Use opaque session-bound,
   one-use descriptors; validate hello/manifest/native values and expose public
   create/invoke/observe operations. Follow controller release instructions and
   retain authoritative cleanup receipts.
4. **RGE-04 — Add MirrorRust model-admission prerequisites.** Implement the
   minimum reviewed compiled-verification/registry contract needed to require a
   successful model match before application binding or worker acquisition.
   Preserve legacy entry points. Do not invent a supported Rust generated target.
5. **RGE-05 — Compose the optional Rust evaluator.** Prepare a Gate session,
   negotiate the model, authorize/acquire inside the post-match factory, execute
   replay through public-port operations, and combine primary results with cleanup
   receipts. Distinguish a manually bound Counter acceptance fixture from a
   general generated application API.
6. **RGE-06 — Extend shared acceptance.** Exercise Rust/C++ facade parity across
   Node/Rust workers and owned/attached controllers, including actual isolation
   and failure cleanup. No support claim before these gates pass.
7. **RGE-07 — Package and document.** Add build/test wiring, standalone consumer
   acceptance, compatibility records, API examples and evidence. Keep publication
   disabled until a separate release decision.

RGE-02 and RGE-04 can proceed independently after RGE-01. RGE-03 depends on the
SDK ownership model. RGE-05 depends on RGE-03 and RGE-04. QA can prepare fixtures
and negative cases in parallel, but RGE-06 requires an actual composed evaluator.

## Implementation ownership after design review

| Work package | Assigned specialist | Exclusive implementation ownership |
| --- | --- | --- |
| RGE-01 | Parent, with SDK and bridge architects | Approved design and cross-repository public seam |
| RGE-02 / RGE-03 | `rust_gate_sdk_plan` | New `sdk/rust/` crate, SDK unit/fixture tests; no controller or evaluator policy rewrites |
| RGE-04 / RGE-05 | `rust_gate_bridge_plan` | Generic MirrorRust model-admission modules/tests and new `integrations/mirrorrust/`; no Gate SDK internals |
| RGE-06 / RGE-07 | `rust_gate_acceptance_plan` | Shared acceptance drivers, build/test wiring, packaging tests and compatibility/docs after implementation gates |
| Final review | Parent | Cross-module review, required gates, evidence and support claims |

The user authorized implementation after committing this plan. The three GPT
roles implemented the listed scopes; after the environment reset, the
`rust_sdk_finish`, `rust_bridge_finish` and `rust_acceptance_finish` agents
continued those assignments. The parent reviewed and integrated the results.
Shared root manifests/scripts are owned by the acceptance task to prevent
competing edits. API changes across ownership boundaries must be coordinated
before dependent implementation starts.

## Consolidated agent findings and work-package details

All three `general-purpose-gpt` agents acknowledged the correct task and returned
source-grounded planning results. They made no code changes and ran no tests.
The parent retains the RGE-01–07 identifiers above; the following subdivisions
reconcile their recommendations without creating competing task numbering.

### RGE-01: decisions to lock before implementation

Use an independent synchronous `mirrorgate-sdk` crate (`mirrorgate_sdk`) at
version `0.1.0`, edition 2024, Rust 1.96, and `publish = false`. Select exact
reviewed dependency versions and a crate-local lockfile. Reuse current serde/
serde_json/num-bigint baselines where appropriate; do not enable an unrestricted
JSON parser without enforcing the protocol's depth/node/byte limits first.

Use one non-cloneable strong connection owner; session and operation handles
carry opaque IDs and weak owner references. Authorization and worker reservations
are non-cloneable, consumed by acquisition/attachment. Do not expose attachment
tokens through constructors, getters or Debug. Explicit close returns a typed
receipt; Drop is only bounded best-effort cleanup, not evidence of success.
A blocking exchange must still support deadlines/cancellation without requiring
an unbounded wait behind the connection mutex.

**Accepted Counter acceptance decision:** allow a reviewed handwritten binding
using compiler-produced Counter contract/digest and fixture-only identity
`mirrorrust-counter-fixture-v1`. Existing control records admit an opaque
profile identifier and preparation checks the exact configured value; preserve
that policy and verify model-side negotiation in the integration gate. Never
describe it as the planned `mirrorrust-v1` generated
target. A general compiler-generated Rust application workflow remains a later
Mirrors compiler milestone.

### RGE-02 / RGE-03: SDK implementation subdivisions

- **02a — Codec:** `src/{strict_json,frame,error,receipt}.rs` and
  `src/control/{types,validate}.rs`; strict duplicate-aware fields, safe numbers,
  framing/resource limits, request/result/event correlation and capabilities.
  Consume the applicable shared control vectors with Node/C++-equivalent verdicts.
- **02b — Transport/control:** `src/transport.rs` and
  `src/control/{mod,client}.rs`; explicit argv, owned stdio, secure attached Unix
  socket checks, owner-bound sessions/operations and bounded close/reap receipts.
  No retry of a mutation whose outcome is uncertain.
- **03 — Worker:** `src/worker/{mod,manifest,value,client}.rs`; exact manifest bytes,
  type-directed portable values, one-use attachment, hello/create before returning
  a usable worker, and controller-directed release. Test semantic set/map
  uniqueness rather than assuming a host container's equality matches the wire.

The SDK exposes native launch/connect/session/prepare/authorize/acquire/status/
cancel/close operations and managed-worker invoke/observe/finish. There is no raw
request escape hatch or independent copy of the controller's lifecycle machine.

### RGE-04 / RGE-05: MirrorRust prerequisites and bridge

- **04a — MI codec:** `MirrorRust/src/model_interface.rs`, additive protocol/error
  definitions and tests. Strict nested negotiation decoding must preserve duplicate
  detection; legacy `serde_json::Value` parsing alone is insufficient. Preserve
  existing registration bytes and Gate-free dependencies.
- **04b — Registry/replay:** immutable exact four-part adapter key, a match witness
  constructible only by the negotiated runner, deferred fresh binding factories,
  effective-config recheck, and a fallible replay seam. Existing StateComputer is
  infallible; worker errors must not become panics or fake model mismatches.
  Add negotiated register and register-traces entry points sharing the existing
  replay loop where safe. Test zero pre-match calls and once-only disposal.
- **05a — Facade:** `integrations/mirrorrust/src/`; prepare before model negotiation,
  then authorize/acquire/attach only inside the validated-match factory. Translate
  public generated/fixture port operations, never raw expected states, to workers.
- **05b — Counter driver:** reviewed fixture metadata, public operation projection,
  explicit fixture-only identity and correct/faulty/wrong-digest modes. This is an
  orchestration acceptance fixture, not generic generated Rust support.

Error precedence is primary evaluation failure, then binding/worker release,
then session cleanup, then control-close/reap failure. Cleanup failures are always
retained in evidence and become the returned failure when evaluation succeeded.
Partial factory failure owns its acquired local handles; the outer facade still
closes its Gate session and the owned control connection/process.

### RGE-06 / RGE-07: concrete acceptance and packaging

QA owns proposed `scripts/test-control-rust.sh`,
`conformance/control-v1/run-rust`, root build/test wiring and evidence validation.
Add 20 evaluator rows: owned/attached × Node/Rust worker × correct/faulty/
wrong-digest/generate-correct/generate-faulty. Compare native facade outcomes
through the same controller; existing C++/Node evaluators are references, not
Rust runtime dependencies. Add a Rust-worker row with a fail-if-invoked Node
sentinel to demonstrate independence from Node.

Require adversarial attachment/manifest/native-value cases, forged/stale/foreign
handles, concurrent sessions, cancellation/timeout/EOF at each acquisition stage,
no post-poison dispatch, and confirmed cleanup. Wrong digest must report zero
factory calls, worker acquisitions and worker-started events. Private canaries
must be absent from captured worker frames, mounts/environment and public reports.

Proposed SDK and integration gates are locked/offline Cargo test plus formatting;
run the required real backend matrix and then the existing repository gate. A
standalone temporary consumer must use the packaged SDK without checkout-layout
assumptions. Keep integration path dependencies explicit until distributable peer
versions exist. Add Rust to `sdk/compatibility.json` only after acceptance; retain
`productionPublication: false`. Real-backend prerequisites are non-root Linux,
working Bubblewrap namespaces, Python, Rust, Mirrors and Apalache; Node is required
only for Node-worker rows. Remote Windows Mirrors is a separate endpoint test,
not a Windows Gate backend claim.

Retain the existing evidence schema; place additional Rust-specific diagnostics
in a compatible sidecar rather than changing frozen wire/evidence records
implicitly. Record exact source/dirty-tree identities, SDK package hash, worker
artifact identities, model endpoint/binary, tools/backend/kernel, result, cleanup,
canary count and skipped/unavailable checks. Local, hosted CI, published-package
and deployment claims remain separate.

## Acceptance obligations

The Rust facade must demonstrate correct SUT acceptance and a real faulty-SUT
Mirrors mismatch. Missing/incorrect model identity must cause zero binding-factory
calls and zero worker acquisitions. Test malformed/duplicate/oversized frames,
wrong correlation IDs, incompatible capabilities, forged or stale handles,
concurrent-session isolation, cancellation, timeout, EOF and partial acquisition.

Require private-canary absence from worker traffic, public mounts and reports.
Test author/build/worker access denial using the real supported backend; a missing
backend is unavailable/failure, never a passing isolation result. Preserve primary
failures when cleanup fails, and distinguish confirmed release/reaping from an
unconfirmed attempt. An attached client must not terminate the shared controller.

Evidence must record evaluator language, worker runtime, control/worker versions,
backend, exact source/tool identities, outcome, cleanup receipts and skipped or
unavailable checks. Server async jobs, async application operations and Gate
worker lifetime remain separate contracts.

## Source contracts and reference implementation

- [Control v1](orchestration-control-v1.md) and [worker v1](protocol-v1.md)
  define the shared wire boundaries; language SDKs do not invent new operations.
- [C++ SDK](../sdk/cpp/README.md) is the reference for native owned/attached
  transport and checked close receipts.
- [C++ evaluator integration](../integrations/mirrorcpp/README.md) demonstrates
  the required model-match-before-worker-acquisition sequence.
- [Mirrors client guide](../../Mirrors/Docs/client-implementation-guide.md)
  supplies MI and SO obligations; [compatibility](compatibility.md) distinguishes
  current support from experimental profiles and future work.
