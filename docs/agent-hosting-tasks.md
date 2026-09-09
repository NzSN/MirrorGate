# Managed agent hosting — implementation tasks

Status: consolidated task plan and prerequisite drafts, 2026-09-09. The controlling
[agent-hosting design](agent-hosting-design.md) is accepted; managed hosting is
not implemented. Baseline: MirrorGate `34ed854`. This ledger does not mark
experiment helpers or design review as delivered runtime functionality.

## Assignment and execution scope

All AH implementation tasks below are assigned to `specification_implementer`.
The coordinator owns dependency ordering, integration, independent review,
final verification, and this ledger. An assignment is not evidence of execution.

For this planning turn, the named agent role was requested but the session's
launcher returned `unknown agent_type 'specification_implementer'`. A `worker`
task named `specification_implementer` therefore performed the planning review
using the local role's instructions. Its completed assignment covered task
decomposition, ownership, prerequisite gaps, and edits to this ledger. It had
no runtime-edit, commit, push, publication, or further-delegation assignment.

The latest dispatch successfully instantiated the named `specification_implementer`
role for `hosting_contract_decisions` (AH1.1) and `mbt_migration_plan` (AH8.1).
Their reviewed documentation drafts are linked below. The earlier worker fallback
is historical, not the role used for this dispatch. Neither assignment authorized
runtime implementation, repository commits, or modifications to Mirrors.

Implementation tasks remain queued behind their dependencies. Their ownership
and acceptance criteria are defined here for subsequent dispatch. Each dispatch
must name the task IDs and owned paths; do not infer permission to implement
other tasks from their appearance in this ledger. Agents are not alone in the
checkout and must preserve other contributors' edits. Shared-file ownership
must be handed off explicitly before another assignment edits it.

## Tasks and dependencies

Every row has the same implementation assignee: `specification_implementer`.
The owner column identifies the task's exclusive responsibility during dispatch.
New filenames are proposed locations; AH1 must settle the versioned contract
layout before consumers implement it.

| ID | Task / owner | Depends on | Owned paths | Status |
| --- | --- | --- | --- | --- |
| AH1 | Freeze the hosting control and policy specification | Planning review | New hosting control/policy docs under `docs/`; proposed contract and schema directories under `protocol/`; proposed shared fixtures under `conformance/`; scoped compatibility documentation | AH1.1 draft reviewed; AH1.2 contract/fixtures queued |
| AH2 | Strict codecs, operator profiles, and capability admission | AH1 | `supervisor/mirrorgate/control_protocol.py`, `control_policy.py`, version-specific codec/policy modules, focused protocol/policy tests and fixtures | Assigned; queued |
| AH3 | Supported Codex runtime and credential lifecycle | AH1, AH2 | New `supervisor/mirrorgate/agent_runtime.py` and runtime support files; focused runtime/configuration/capability tests | Assigned; queued |
| AH4 | Session-bound authoring broker and agent tools | AH1, AH2 | New `supervisor/mirrorgate/authoring_broker.py` and MCP transport files; focused broker/dispatcher tests | Assigned; queued |
| AH5 | Gate-owned hosting lifecycle, submission, and cleanup | AH2, AH3, AH4 | `orchestration.py`, `control_server.py`, `preparation.py`, scoped `cli.py`/`sandbox.py`/`artifacts.py` changes under `supervisor/mirrorgate/`; hosting lifecycle/race tests | Assigned; queued |
| AH6 | Native Node hosting interface and package consumption | AH1, AH5 | `sdk/node/control.mjs`, `control.d.mts`, related public package exports, Node hosting/consumer tests | Assigned; queued |
| AH7 | Native C++ hosting interface | AH1, AH5 | `sdk/cpp/`, `tests/cpp/`, scoped `scripts/test-control-cpp.sh` changes | Assigned; queued |
| AH8 | External MBT integration and MirrorECMA decoupling migration | Runtime integration: AH5, AH6, AH11 | `integrations/mirrorecma/` public integration and tests; explicit handoff for MirrorECMA `src/sandbox.ts`, `src/sandbox-model.ts`, root exports/package metadata, affected consumer tests and Counter experiment migration | AH8.1 plan reviewed; runtime packages queued |
| AH9 | Shared acceptance, adversarial integration, and gate wiring | AH5, AH6, AH7, AH8, AH11 | Hosting acceptance fixtures/tests, `scripts/test.sh`, scoped package/declaration gates; coordination with AH1 fixture owner | Assigned; queued |
| AH10 | Destination verification and support documentation | AH9, AH11 | Hosting task/evidence docs, `docs/compatibility.md`, `sdk/compatibility.json`, usage/design/index status, root README | Assigned; queued; coordinator verifies independently |
| AH11 | Standard hosting-tool adapter for an outside coordinating agent | AH1, AH5, AH6 | Proposed `integrations/agent-host/` Gate-owned module, tool schemas, registration/configuration examples, packaging and dispatch tests; explicit handoff for shared package metadata | Assigned; queued |
| AH12 | Optional evaluation-service contract, proxy, and shared-suite acceptance | AH8 | `docs/evaluation-service-design.md`; proposed `integrations/mirrorecma/service/` and service/client fixtures/tests; explicit handoff for integration package metadata | Assigned; queued; separate optional delivery |

AH3 and AH4 may be dispatched independently after the same AH1/AH2 contract
is fixed. AH6 and AH7 may proceed independently against the integrated AH5
controller. AH11 follows AH6 and supplies the primary coordinator-to-Gate tool.
AH8 depends on that hosted flow and extracts evaluation composition outside
MirrorECMA. Gate-native automation can still call its SDK directly. AH9/AH10
verify core decoupling and integrated hosting separately before full completion.
Task numbers are stable identifiers, not execution order. A single delegate can
execute them sequentially; no extra agents are implied by the dependency graph.
AH8 crosses into MirrorECMA and requires
its repository guidance and an explicit path handoff. Mirrors model semantics
and worker port RPC are outside these implementation assignments.

AH12 follows AH8's reusable harness and is a separate optional service delivery.
It does not block source-code tests, base hosting, or AH9/AH10's base acceptance.
Its own completion requires service-specific acceptance; do not mark all assigned
work complete while AH12 remains pending, or infer service support from AH10.

## Dispatchable work packages

The following packages refine AH1–AH12 without replacing those stable IDs.
All are assigned to `specification_implementer`. AH1.1 and AH8.1 are completed
planning drafts; all code, schema/fixture, runtime validation, and service work
below remains queued. A parent task is not complete merely because its planning
draft exists. Mirrors source, protocol, and compiler are unchanged by this plan.

| Package | Prerequisite / ownership handoff | Deliverable and acceptance |
| --- | --- | --- |
| AH1.1 | Latest designs and current control audit; documentation only | [Hosting contract decision draft](agent-hosting-contract-decisions.md): compatibility, owner connection, run/tool slots, source lease, admission, race and cleanup choices; reviewed draft, not frozen wire support |
| AH1.2 | Reviewed AH1.1 | Freeze versioned hosting/control and policy records, numeric limits, errors, capabilities, schemas, and shared positive/negative vectors under `protocol/` and `conformance/`; preserve existing v1 fixtures and Mirrors/worker protocols |
| AH2.1 | AH1.2 | Strict versioned request/result/event codecs and dispatch admission in controller protocol modules; malformed/unknown fields, unsupported versions, and bounds reject before author allocation |
| AH2.2 | AH1.2; coordinate with AH2.1 | Closed operator agent profiles, credentials/runtime identities, capability reporting and limits in policy modules/fixtures; requests cannot expand executable, filesystem, environment, or model access |
| AH3.1 | AH2.1–AH2.2 | Supported Codex configuration/process adapter with fresh context, explicit inherited environment/handles, bounded output and credentials cleanup; partial-start, timeout, and no-submit exit coverage |
| AH3.2 | AH3.1 | Actual runtime dispatcher audit with identity/freshness rules; approved Gate calls succeed while alternative tools, private context and resource discovery fail as specified |
| AH4.1 | AH1.2 and AH2 | One-session authoring broker and MCP transport with fixed public contract/exec/submit tools; validate caller ownership, frames, correlation and arguments |
| AH4.2 | AH4.1 | Bounded correlated output, active-tool exclusion, submit/late-request behavior, EOF and descriptor cleanup; malformed/flooding/foreign-session tests |
| AH5.1 | AH1.2 and AH2; owns preparation/artifact changes | Implement submitted-source state and reusable owned frozen lease; revoke authoring and quiesce writers before commit, then prepare exactly once from that lease |
| AH5.2 | AH3, AH4, AH5.1; owns controller/host lifecycle | Integrate separate author-run and tool slots, terminal/race ordering, selective host cleanup, session cancellation and failure receipts; no unnegotiated evaluation-worker launch |
| AH6.1 | AH1.2 and AH5 | Node public hosting/control interface and declarations, owned/attached client behavior and packed-package consumption; no client-side lifecycle duplicate |
| AH7.1 | AH1.2 and AH5 | Equivalent C++ public interface, shared vector consumption and real-controller owned/attached tests; no Node orchestrator required |
| AH11.1 | AH6.1 | Shipped coordinating-agent hosting adapter implementing the frozen tool contract through public Gate SDK; approved task/run references and disclosure checks |
| AH11.2 | AH11.1 | Actual outside-agent dispatch and installed-package registration evidence, including lost replies, foreign references, cancellation and owner-connection handoff |
| AH8.1 | Existing generic factory/source/package audit; documentation only | [MirrorECMA migration work plan](../../MirrorECMA/docs/mbt-integration-tasks.md): extraction/exports, generic seam, reusable suite and regression boundaries; reviewed planning only |
| AH8.2 | AH8.1; stable external integration contract | Extract Gate-aware composition and define tested package/export compatibility; exact ownership and ordering in the companion plan, no managed-author option in MirrorECMA |
| AH8.3 | AH8.1; generic factory/binding available | One reusable approved suite with source-test/CLI wrappers and local/proxy provider cases; no dependence on hosting or service delivery for local source tests |
| AH8.4 | AH5, AH6, AH11, AH8.2–AH8.3 | Coordinator-to-Gate fresh-author experiment and external evaluation integration against an existing Mirrors server; source/artifact identity and required-match-before-worker-launch |
| AH8.5 | AH8.2–AH8.4 | Core dependency/export/consumer audit, unchanged generic MBT behavior, local/proxy result equivalence and compatibility/deprecation evidence |
| AH9.1 | AH2–AH8 and AH11 | Integrated adversarial/public-interface acceptance, real author/build/worker isolation, preserved existing gates, native-client parity and bounded cleanup |
| AH10.1 | AH9.1 | Coordinator-independent destination review, exact gate exits/versions, compatible package/usage docs and explicit remaining service scope; no publication inferred |
| AH12.1 | AH8 suite/integration contract; planning can precede code | Freeze separate evaluation-service transport/schema, authorized suite/artifact references, caller/run identity, duplicate-start/query, bounds, retention/disconnect and cleanup rules |
| AH12.2 | AH12.1 and AH8 reusable suite | Optional trusted service resolving approved immutable suites/implementations and invoking the same harness; preserve Gate owner connection and private result projection |
| AH12.3 | AH12.2 | Proxy client plus configuration/registration examples; start/get/cancel, malformed/cross-caller references, uncertain replies and disconnect behavior |
| AH12.4 | AH12.2–AH12.3 | Fixed-input source-test/CLI/service equivalence, correct/faulty local and real Gate-backed runs, private-suite integrity and cleanup; record service-specific support separately |

Host implementation order is AH1.2 -> AH2 -> AH3/AH4/AH5.1 -> AH5.2 ->
AH6/AH7 -> AH11 -> AH8.4/AH8.5 -> AH9/AH10. The reviewed AH8 plan and
generic suite work need not wait for hosting; optional AH12 service delivery
must not become a dependency of local source tests or MirrorECMA's core.

Shared codec/policy/controller/package files have one owner at a time. A delegate
may read dependencies but must obtain an explicit ownership handoff before
editing another package's files. It must use public interfaces, preserve dirty
work and scratch files, and report source edits versus destination integration.
No task includes committing, pushing, credential acquisition, hosted deployment,
or unrelated Mirrors changes. Missing runtime/model access is a reported gate
limitation, not permission to weaken or claim the gate.

## AH1 — Contract decisions before implementation

Produce implementation-ready control and operator-policy contracts, with closed
records, required/optional fields, strict framing, limits, errors, and fixtures.
Do not silently add fields or operations to frozen control v1. Specify bootstrap,
version selection, policy-catalog evolution, and legacy rejection before any SDK
or dispatcher adopts the extension. Existing v1 records and fixtures retain their
closed-field behavior; an unsupported hosting capability allocates no author.

Resolve these questions once in the shared specification:

- How a hosting run is accepted, identified, observed, cancelled, and queried
  after an uncertain reply; ownership remains connection plus principal plus
  session. Resume, reconnect, follow-up prompts, delegation, and retries remain
  outside the initial profile.
- How the agent profile is selected and admitted, including executable/runtime
  identity, supported Codex configuration, capability audit, model access,
  credential references, public inputs, and run/output/event limits. Define the
  executable/configuration identity covered by an audit, its freshness rules,
  and which changes invalidate it; a matching version string alone is not proof.
- How a long-running author coexists with its own tool commands. Existing
  ordinary-operation exclusion must not deadlock agent execution. Specify a
  separate hosted-run slot and single active-tool slot, and the rejection or
  serialization rule for trusted external `authoring.exec` during hosting.
  Admission of another agent run or an uncontrolled external writer is forbidden.
- Where submission commits, how managed writers become quiescent, when source
  identity becomes authoritative, and how `session.prepare` consumes that exact
  source without freezing a different tree or running preparation twice. Define
  a submitted-source state with an owned frozen lease: revoke admission before
  quiescence, commit only after a successful snapshot, and reuse that lease for
  the one later preparation. Specify cancellation behavior before and after
  commit, including retained identity when cleanup releases the physical lease.
- Which result wins for submit/cancel/deadline/disconnect races and what is
  retained if the agent crashes after committed submission. Prose completion
  or exit before submission must never imply a submitted result.
- Which resources and temporary credentials belong to a run versus the session,
  what cleanup completion proves, and how primary failures and cleanup failures
  remain separately inspectable. Successful host cleanup must preserve the
  session's committed source lease for build/evaluation; closing an agent run
  must not indiscriminately close its evaluation session.
- Which events/results are author-visible versus trusted-only, with explicit
  bounds and disclosure rules for output, prompts, final prose, and diagnostics.
- How the coordinator/Gate-native caller supplies a bounded approved public brief
  and files directly to Gate, rejects generated-port collisions, and keeps private
  model/binding data out of authoring. No MirrorECMA managed-author variant is
  permitted. Specify the external integration's generic implementation factory,
  matched-admission composition, and same-owner Gate lifecycle while MirrorECMA
  uses its independent existing Mirrors transport and generic MBT interface.
- What the standard outside-agent hosting tool accepts and discloses. Define
  exact schemas and names for the semantic start/inspect/cancel operations,
  preapproved task/context bindings, caller-scoped safe run references
  that hide administrative session/control handles, and bounded progress and
  terminal results. The outside agent cannot expand task disclosure, profiles,
  credentials, mounts, or tool policy through free-form launch arguments.
- How AH11 routes launch, query, and cancellation through the public native SDK
  after an uncertain tool reply without replaying a mutating operation. Specify
  the adapter/evaluator lifetime and shared owning control-connection boundary:
  attaching another same-UID connection must not adopt existing session handles.
  Settle stdio embedding or handoff while that one owner connection survives
  successive tool calls and remains available to the evaluator.
  Preserve the session and committed source through evaluator preparation and
  evaluation, and define adapter exit/EOF cleanup without inventing reconnect.
- How adapter startup checks hosting capabilities before allocation, and what
  installed-package and actual outside-agent tool-dispatch evidence establishes
  support. Stdio MCP backed by the public Node SDK is the intended first adapter
  transport, subject to this contract; no such CLI or tool API exists today.

Exit evidence: one authoritative specification and machine-readable contract
with positive/negative examples, a state/race table, numeric bounds, a migration
decision for v1, and no unresolved field or ordering choices needed by AH2–AH7
or AH11. Keep the outside coordinating agent's hosting tool distinct from the
inside implementer's AH4 public-contract/execution/submission tools.
The coordinator reviews it before runtime implementation begins.

## AH2–AH5 — Implement the trusted hosting path

**AH2:** Implement closed decoding and operator catalogs from AH1. Reject unknown
or malformed fields, unsafe paths, unapproved executables/mounts/credentials,
looser limits, unsupported versions, and unsupported capabilities before agent
allocation. Capability advertising must reflect the actually admitted runtime
and backend, not merely installed SDK code. Preserve v1 behavior and fixtures.

**AH3:** Generalize the experiment's configuration and runner into a supported
Codex integration. Create fresh private runtime state; allowlist inherited
environment/handles; prevent project, memory, plugin, connector, hook, and
conversation context leakage. Bind model credentials to trusted runtime needs
without mounting them into author tools. Implement deadlines, process-tree
termination, bounded diagnostics, and temporary credential cleanup on partial
construction as well as normal exit. Validate the real dispatcher's capabilities
using the supported runtime version; configuration flags alone do not pass.
Record the executable/configuration audit identity and enforce AH1's freshness
and invalidation rules before admission. Exercise resource discovery, implicit
context loading, hooks, delegation, and alternate host-access dispatch as well
as permitted Gate calls. Bound retained stdout, stderr, final prose, and runtime
event logs, including disk use; timeout and output flooding must not create
unbounded files. Verify credential removal and process/descriptor cleanup on
partial construction, runtime failure, and normal completion.

**AH4:** Generalize public-contract, execution, and submission operations without
Counter-specific names, semantics, paths, or fixed Node/Python assumptions.
Bind the transport to one admitted authoring session and approved tool catalog.
Validate frames, correlation, tool arguments, connection ownership, output bounds,
and late requests. The author never receives administrative handles or a way to
replace policy. Test malformed traffic, foreign sessions, output flooding, and
resource discovery through the actual transport.

**AH5:** Integrate the host into Gate's authoritative session lifecycle using
AH1's preparation contract. Revoke tools at submission/cancellation, settle active
commands, quiesce owned writers, and retain the committed source identity and
owned frozen lease. Preparation must reuse that lease once, even if the live
authoring tree changes afterward. Track the hosted run separately from the one
active ordinary tool command so the host can run its own tools; enforce AH1's
external-authoring rule and reject another hosted run in the same session. Own
agent/broker/tool cleanup on timeout, crash, EOF, no-submit exit, and partial
startup. On successful submission, clean only hosting resources and preserve
the source lease for later build/evaluation. On session cancellation/closure,
release session resources according to the authoritative race outcome. Keep
attached-daemon and other-client resources alive. Provide exactly
one authoritative terminal outcome; distinguish run, submission, build, replay,
and cleanup. Do not launch an execution worker before existing model admission.

Exit evidence for each task: focused behavioral tests, rejected negative cases,
the relevant real-runtime/backend checks, and a diff limited to its ownership.
AH5 additionally requires public-controller lifecycle and deterministic race
tests, including ordinary-operation exclusion and submit/prepare coordination.
Include submit during an active command, late tools, external authoring during
hosting, cancel before/after source commit, cleanup failure after submission,
and preparation from the retained lease after host cleanup. Assert both terminal
identity and remaining physical resources; agent exit alone proves neither.

## AH6–AH8 — Native callers and experiment migration

**AH6:** Expose the hosting operation, bounded progress, cancellation, and terminal
result in the Node SDK and declarations. Consume the shared contract; leave
transitions, process launch, and forced cleanup in Gate. Verify owned and attached
connections, unsupported-server rejection, lost replies, and packed-package
imports/type checking.

**AH7:** Implement the equivalent native C++ interface and strict decoding from
the same contract. Run against the real controller without a Node orchestrator.
Verify owned and attached paths, bounded transport, cancellation, terminal
correlation, and preserved unrelated-session ownership. Node and Rust execution
workers do not count as two native hosting clients.

**AH8:** Keep MirrorECMA's semantic API limited to MBT against caller-supplied
implementations. Extract Gate-specific composition from its experimental sandbox
facade into a separately packaged integration under `integrations/mirrorecma/`,
using public interfaces from both libraries. Inventory `src/sandbox.ts`,
`src/sandbox-model.ts`, root exports, optional peer/package declarations, examples,
and consumer tests; freeze a compatibility/deprecation strategy before changing
existing exports. Preserve runtime behavior until its replacement and migration
checks pass. Do not add the superseded managed-agent author option.

Reuse generic negotiated async factories/bindings to provide a proxy implementation
to MirrorECMA. If a generic capability is missing, report it and specify a small
implementation-neutral extension with local and external consumer tests; do not
put Gate policies, artifact leases, prompts, or worker/control codecs into core.
The integration owns Gate setup/admission, the control connection, public-port
projection, and physical-cleanup composition. Required-match failures must create
no evaluation worker; cleanup also covers failures before factory invocation.

Extract one reusable application suite module with a deferred implementation
factory and source-test/CLI entry points. The optional service must call that
same suite rather than duplicating its model semantics. Suite revision and
private evaluator files remain independently approved from submitted source;
public development tests can coexist in the source tree without granting access
to private suites. See the [harness design](../../MirrorECMA/docs/mbt-harness-design.md).

Migrate the Counter workflow so the user-started coordinator calls Gate directly
through AH11 (or native Gate automation). The resulting implementation is tested
by ordinary MirrorECMA MBT against an existing Mirrors server. Preserve private
evaluation/disclosure ownership, archived historical evidence, source/artifact
identity, and real restricted build/worker execution. Retain a Gate-free core
test/consumer gate and compare local versus proxy implementations through the
same MBT entry point. Runtime migration is queued; documentation alone does not
establish dependency removal or changed exports.

Exit evidence: equivalent native client behavior, public package/declaration
consumption, and a migrated experiment receipt that records source/artifact
identities, versions, public tool traffic, private evaluation outcome, and cleanup
without exposing credentials or private oracle contents.

## AH11 — Standard outside-agent hosting-tool adapter

MirrorGate distributes the adapter that lets an outside coordinating agent
request an approved hosted implementer run. Applications configure and register
this supplied adapter in their agent framework; those frameworks' registration
APIs remain outside MirrorGate's ownership. AH4 separately supplies the tools
used by the implementer inside restricted authoring. Neither adapter creates a
second launcher, broker lifecycle, or session transition implementation.
Hosting tools are exposed only to the outside coordinating agent; they do not
enable delegation by the restricted implementer.

Implement AH1's tool contract in a Gate-owned module, proposed at
`integrations/agent-host/`, using the public native SDK. The intended first
transport is stdio MCP backed by the Node SDK; it is planned rather than an
existing command or supported API. Package the entry point, schemas, explicit
trusted configuration, and registration examples so consumers need no custom
launch wrapper. Configuration fixes approved task/context bindings and agent
profiles; requests carry approved task references and caller-scoped opaque run
references. Start, inspect, and cancel describe the intended operations; AH1
freezes their exact tool names and schemas before implementation.

Enforce capability checks before any agent allocation, validate tool arguments,
bound outputs, and project only approved progress/results. Keep administrative
handles, credential references, host paths, and private evaluation diagnostics
out of the tool surface. Query or cancel an existing run after an uncertain
reply; never retry an uncertain launch or submission mutation. Implement AH1's
shared owner-connection contract so successful tool completion does not close
the session needed by the evaluator, and a separate connection cannot adopt it.

Exit evidence: an installed-package consumer configures/registers the supplied
adapter and an actual outside-agent dispatcher invokes it to launch a fresh
restricted implementer. Exercise approved progress, query, cancellation and
terminal delivery; malformed or forged run references; unapproved task/profile
selection; capability absence; lost replies; duplicate launch attempts; adapter
EOF; and bounded/redacted results. Demonstrate that source preparation and
private evaluation use the same owning session after the tool run completes.
Direct native SDK calls and an implementer-side MCP audit alone do not satisfy
this packaging and outside-agent dispatch acceptance.

## AH12 — Optional evaluation-service and proxy

Specify and implement the [evaluation-service design](evaluation-service-design.md)
as a wrapper around AH8's reusable suite in the external integration. Keep
MirrorECMA's public API implementation-neutral. A source test or CLI calls the
suite directly; a service client requests the same evaluation by approved suite
and implementation references. The service proxy is not the SUT operation proxy
or Gate's hosting tool.

Freeze a separate versioned contract before service implementation: transport,
closed schemas, admission/authentication, caller-scoped run references, resolved
suite/artifact identities, output bounds, correlation, start deduplication/query,
cancellation, disconnect policy, retention, and terminal cleanup semantics.
The illustrative start/get/cancel names are not existing wire operations. Do not
extend control v1 or accept arbitrary harness code, host paths, or raw Gate
handles. Keep the trusted owner connection or use an explicitly supported
immutable artifact import; never adopt another client's live session by ID.

Exit evidence: the same approved suite produces equivalent semantic outcomes
through a local test/CLI and real service proxy for fixed inputs. Verify correct
and faulty local/Gate-backed implementations, denied caller/reference/suite
selection, malicious submitted suite replacement, private-data projection,
malformed/oversized traffic, duplicate/lost start replies, timeout/disconnect,
cancel races, and accurate cleanup. Retain required-match zero-worker-launch
and real sandbox gates. Publish service compatibility only after these checks;
base generic MBT and source tests remain independent of this optional service.

## AH9–AH10 — Acceptance and delivery

AH9 must cover every row of the design's acceptance matrix through public
interfaces. Earlier unit tests supplement these cases; they do not replace them.

| Design acceptance | Implementation / acceptance owner |
| --- | --- |
| Fresh author | AH3, AH4, AH8, AH9, AH11: coordinator requests Gate directly |
| Capability denial | AH2, AH3, AH4, AH9, AH11 |
| Backend enforcement | AH4, AH5, AH9 |
| Admission failure | AH2, AH3, AH5, AH9, AH11 |
| Ownership | AH4, AH5, AH6, AH7, AH9, AH11 |
| Sealing races | AH1, AH5, AH9 |
| Failure cleanup | AH3, AH5, AH6, AH7, AH9, AH11 |
| Disclosure | AH1, AH3, AH4, AH8, AH9, AH11 |
| Client independence | AH6, AH7, AH9 |
| End-to-end evaluation | AH8, AH9, AH11: external integration supplies the implementation to ordinary MBT |
| MBT decoupling | AH8, AH9: core consumer/dependency checks and equivalent local/proxy replay |
| Standard hosting tool | AH1, AH6, AH9, AH11 |

Use synthetic private canaries for authoring/build/worker and context/credential
probes; never put actual credentials or private model content into public test
artifacts. Include a faulty submission that fails real comparison. Deterministic
fake-agent fixtures may exercise races without model-service access, but cannot
replace the supported runtime's dispatcher audit and actual fresh-author run.
AH9 first verifies generic MirrorECMA imports, declarations, replay, cancellation,
and reports with Gate absent. Then drive the packaged AH11 adapter from the
outside coordinator, producing a fresh author, restricted build, frozen artifact,
and real worker. The external integration supplies that proxy through the same
MBT interface used for a local implementation, using an existing Mirrors server.
Assert no authoring/Gate options or dependencies in the target core and verify
consumer migration. Include build-hook/adapter-initialization private-canary
probes, required-match zero-worker-launch paths, owner-preserving handoff, and
cleanup without leaking control handles or private context to either agent.

AH10 requires the destination checkout to contain the integrated changes and
pass its required gates. Run pinned toolchains and the real isolation backend:

```bash
cargo fetch --manifest-path runtimes/rust/Cargo.toml --locked
bash scripts/build.sh
bash scripts/test.sh
git diff --check
```

Also run new hosting gates, AH11 installed-adapter/actual-dispatch checks,
Node package/declaration and C++ consumer checks,
and the relevant MirrorECMA facade/experiment tests. Record exact commands,
exit codes, revisions, runtime/backend identities, and evidence paths. Run
cross-client checks per `../Mirrors/tools/interop/INTEROP.md` when the changed
facades require them. Unavailable Bubblewrap, missing model authentication,
skipped runtime checks, or unconfirmed cleanup cannot be recorded as passes.
Do not seek or copy unrelated credentials to make a gate run.

The coordinator independently reviews negative paths and final destination
status. Update compatibility only for demonstrated profiles; keep release,
hosted CI, resume, and other unimplemented behavior explicitly separate. No
commit, push, or publication is implied by this task assignment.

## Latest delegation results

| Assignment | Requested and instantiated role | Result | Remaining work |
| --- | --- | --- | --- |
| AH1.1 / `hosting_contract_decisions` | `specification_implementer` | Reviewed contract decision draft integrated into `docs/agent-hosting-contract-decisions.md` | AH1.2 schema/fixture freeze and all runtime implementation |
| AH8.1 / `mbt_migration_plan` | `specification_implementer` | Reviewed companion plan integrated into MirrorECMA `docs/mbt-integration-tasks.md` | AH8.2–AH8.5 extraction, harness, integration and consumer gates |

The drafts make implementation assignments concrete; they are not successful
runtime tests, contract freeze, facade extraction, or agent/service support.

## Planning and execution record

- 2026-09-09: AH1–AH10 developed from the accepted design and assigned to
  `specification_implementer`; implementation remains queued.
- 2026-09-09: Accepted Gate ownership of the standard outside-agent hosting-tool
  adapter. Added AH11 assigned to `specification_implementer`, prerequisite
  contract decisions, migration dependencies, and packaging/dispatch acceptance.
  Planning update review is complete; AH1–AH11 implementation remains queued.
- 2026-09-09: Superseded the unimplemented MirrorECMA managed-author proposal.
  The coordinator now talks directly to Gate; AH8 extracts Gate-aware evaluation
  composition outside MirrorECMA, preserving generic MBT semantics and defining
  consumer migration. AH11 is the primary agent-facing hosting route. Restricted
  build/worker enforcement remains required. Runtime migration is not started.
- 2026-09-09: Added reusable source-test/CLI suite scope to AH8 and assigned AH12
  for optional proxy-accessible evaluation. Distinguished service and implementation
  proxies, approved suite integrity, run ownership, and service-specific acceptance.
  Service delivery remains queued and does not block the base source-test path.
- 2026-09-09: Consolidated AH1–AH12 into dispatchable work packages. Named
  `specification_implementer` agents completed AH1.1 and AH8.1 planning drafts;
  the coordinator reviewed and integrated them. Runtime/schema/service packages
  remain queued. The earlier fallback-only assignment is historical.
- Planning review: complete using the worker fallback described above; the
  ledger incorporates the following source-grounded prerequisites. This is
  planning evidence, not completion of AH1 or any runtime task.
- Runtime implementation, runtime tests, and feature acceptance: not started.

### Planning review evidence

- Decoupling review confirmed that MirrorECMA's public async adapter registry
  already defers factory invocation until a validated model match. AH8 can keep
  Gate authorize/acquire/connect in the external factory and supply the generic
  binding without extending MBT semantics. Retain authority privacy and late
  factory/disposal behavior. Current sandbox source, root exports, peer metadata,
  and integration packaging still require actual migration and consumer tests.

- [`ControlBackend.prepare`](../supervisor/mirrorgate/preparation.py) currently
  rejects an already sealed session and combines source freezing with build and
  artifact freezing. `_stop_authoring` sets the sealed flag. AH1/AH5 must define
  and implement reuse of a committed source lease; simply sealing in `submit`
  and invoking the current preparation path cannot work.
- [`_op_session_prepare` and `_new_operation`](../supervisor/mirrorgate/orchestration.py)
  enforce one active ordinary operation. AH1/AH5 must keep the hosted-run slot
  separate, otherwise a pending host operation excludes its own authoring tools.
- The experiment's
  [`run_author.py`](../../MirrorECMA/experiments/blind-counter/author-host/run_author.py)
  inherits `os.environ`, writes unbounded transcript/diagnostic files, and removes
  the authentication copy without establishing full host/broker/descendant
  cleanup. These are migration gaps for AH3/AH5, not supported hosting behavior.
- The experiment's
  [`audit_tools.py`](../../MirrorECMA/experiments/blind-counter/author-host/audit_tools.py)
  exercises shell, image, and patch rejection and a permitted public-contract
  call. It permits resource-discovery tools in the advertised inventory without
  exercising their denial. AH3/AH9 require the broader actual-dispatch and
  context-isolation evidence specified above.
- Adapter planning review separates AH11 outside-agent launch/query/cancel
  mediation from AH4 implementer-side authoring tools. Shared ownership remains
  connection-bound as specified in
  [control v1 ownership](orchestration-control-v1.md#3-startup-principal-and-ownership);
  AH1 must define the adapter/evaluator shared-connection lifetime before AH11
  implementation. The planned stdio MCP adapter has no runtime or package
  acceptance evidence yet.
