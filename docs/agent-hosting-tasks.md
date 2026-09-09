# Managed agent hosting — implementation tasks

Status: destination-integrated and locally validated, 2026-09-09. The work began
from MirrorGate `7dc16e7` with the existing design edits preserved. Destination,
core/live, installed-package and cross-client gates passed. A real outside Codex
coordinator registered the installed MCP adapter and drove a real fresh Codex
implementer through submission, MBT and confirmed cleanup.
[Final validation](managed-workflow-validation.md) records authoritative commands,
versions and results. Local completion does not imply publication or hosted CI.

The [managed workflow](managed-workflow-design.md) places R1 agent hosting,
R2 sandbox/artifacts and R3 trusted MBT integration inside Gate. The external
`mirrorgate-mirrorecma` package now supplies the local workflow and receipts;
MirrorECMA 2 removes its Gate-specific core surface. The optional local HTTP
service invokes that same workflow. Mirrors semantics/protocols are unchanged.

## Assignment and execution scope

The implementation was delegated to named `specification_implementer` agents:

| Assignment | Implemented responsibility |
| --- | --- |
| `control_contract` | AH1.2/AH2.1 v2 contract/codecs, AH5.2 controller integration and AH12 service/proxy |
| `host_backend` | AH2.2 profiles/admission, AH3 runtime/audit, AH4 broker and AH5.1 committed source leases |
| `mbt_suite` | AH8.3 generic suite, AH6 Node SDK and AH11 hosting-tool implementation |
| `cpp_hosting` | AH7 native C++ hosting, AH8.5 core cutover and independent adversarial review |
| `mbt_integration` | AH8.2/AH8.6/AH8.7 external workflow, receipts, migration and installed Counter consumer |
| Coordinator | Integration, independent negative-path review, final destination checks and evidence |

Earlier planning used a fallback worker when the named role was unavailable;
later AH1.1/AH8.1 and runtime dispatches used the named role successfully. That
history is not a current launcher limitation. Runtime edits were authorized by
the user; commits, push and publication are outside this implementation dispatch.

Code is integrated in the destination repositories with verified content parity.
Gate's final full gate, MirrorECMA core/live checks, integration tests, Mirrors
gates and the central interop matrix passed. The installed MCP protocol harness
and actual outside-Codex framework both drove real implementers successfully.
Synthetic-host fixtures remain separate reproducible race/fault tests. Delegates
preserved existing edits and handed shared files over explicitly; the coordinator
independently reviewed negative paths and records final evidence.

## Tasks and dependencies

Every row has the same implementation assignee: `specification_implementer`.
The owner column identifies the task's exclusive responsibility during dispatch.
The owned paths now contain the implementation. Detailed acceptance requirements
below remain the reference for verification and future changes.

| ID | Task / owner | Depends on | Owned paths | Status |
| --- | --- | --- | --- | --- |
| AH1 | Freeze the hosting control and policy specification | Planning review | Hosting control/policy docs under `docs/`; `protocol/control-v2/`; shared fixtures under `conformance/control-v2/`; scoped compatibility documentation | Frozen control/policy v2 contracts, schemas and shared vectors implemented |
| AH2 | Strict codecs, operator profiles, and capability admission | AH1 | `supervisor/mirrorgate/control_protocol.py`, `control_policy.py`, version-specific codec/policy modules, focused protocol/policy tests and fixtures | Strict v1/v2 codecs, closed profiles and fresh runtime admission implemented |
| AH3 | Supported Codex runtime and credential lifecycle | AH1, AH2 | New `supervisor/mirrorgate/agent_runtime.py` and runtime support files; focused runtime/configuration/capability tests | Codex 0.153.4 runtime/audit and descendant cleanup exercised locally |
| AH4 | Session-bound authoring broker and agent tools | AH1, AH2 | New `supervisor/mirrorgate/authoring_broker.py` and MCP transport files; focused broker/dispatcher tests | Session broker and restricted MCP tools implemented and tested |
| AH5 | Gate-owned hosting lifecycle, submission, and cleanup | AH2, AH3, AH4 | `orchestration.py`, `control_server.py`, `preparation.py`, scoped `cli.py`/`sandbox.py`/`artifacts.py` changes under `supervisor/mirrorgate/`; hosting lifecycle/race tests | Run/source/cleanup lifecycle implemented; local race and real backend gates pass |
| AH6 | Native Node hosting interface and package consumption | AH1, AH5 | `sdk/node/control.mjs`, `control.d.mts`, related public package exports, Node hosting/consumer tests | Node v2 SDK, declarations and installed consumers tested locally |
| AH7 | Native C++ hosting interface | AH1, AH5 | `sdk/cpp/`, `tests/cpp/`, scoped `scripts/test-control-cpp.sh` changes | C++ v2 client/shared vectors and real-controller owned/attached tests pass locally |
| AH8 | Gate-owned local MBT workflow and MirrorECMA decoupling migration | Runtime integration: AH5, AH6, AH11 | `integrations/mirrorecma/` public integration and tests; explicit handoff for MirrorECMA `src/sandbox.ts`, `src/sandbox-model.ts`, root exports/package metadata, affected consumer tests and Counter experiment migration | External workflow, core cutover and installed Counter/service consumer implemented locally |
| AH9 | Shared acceptance, adversarial integration, and gate wiring | AH5, AH6, AH7, AH8, AH11 | Hosting acceptance fixtures/tests, `scripts/test.sh`, scoped package/declaration gates; coordination with AH1 fixture owner | Destination/native/isolation/core/live/interop and actual-framework acceptance passed |
| AH10 | Destination verification and support documentation | AH9, AH11 | Hosting task/evidence docs, `docs/compatibility.md`, `sdk/compatibility.json`, usage/design/index status, root README | Destination verification complete; authoritative validation report records evidence |
| AH11 | Standard hosting-tool adapter for an outside coordinating agent | AH1, AH5, AH6 | `integrations/agent-host/` Gate-owned module, tool schemas, registration/configuration examples, packaging and dispatch tests; explicit handoff for shared package metadata | Installed adapter and actual outside-Codex MCP dispatch passed |
| AH12 | Optional evaluation-service contract, proxy, and shared-suite acceptance | AH8 | `docs/evaluation-service-design.md`; `integrations/mirrorecma/service/` and service/client fixtures/tests; explicit handoff for integration package metadata | Loopback HTTP v1 service/proxy and shared-suite acceptance implemented locally |

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
All were assigned to `specification_implementer`. AH1.1/AH8.1 remain historical
planning drafts; current code and evidence are recorded below. Acceptance status
does not follow from a planning document alone. Mirrors source, protocol and
compiler are unchanged by this work.

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
| AH8.1 | Existing generic factory/source/package audit; documentation only | [MirrorECMA migration work plan](https://github.com/NzSN/MirrorECMA/blob/main/docs/mbt-integration-tasks.md): extraction/exports, generic seam, reusable suite and regression boundaries; reviewed planning only |
| AH8.2 | AH8.1; stable Gate-owned integration contract | Extract Gate-aware composition and define tested package/export compatibility; exact ownership and ordering in the companion plan, no managed-author option in MirrorECMA |
| AH8.3 | AH8.1; generic factory/binding available | One reusable approved suite with source-test/CLI wrappers and local/proxy provider cases; no dependence on hosting or service delivery for local source tests |
| AH8.4 | AH5, AH6, AH11, AH8.2–AH8.3 | Coordinator-to-Gate fresh-author experiment and Gate-owned evaluation integration against an existing Mirrors server; source/artifact identity and required-match-before-worker-launch |
| AH8.6 | AH5, AH6, AH8.2–AH8.3 | Supported Gate-owned local workflow/provider and aggregate receipt; one owner from hosting/prepared source to generic MBT and cleanup, with private/public projections and partial-failure tests |
| AH8.7 | AH8.6 and AH11 | Installed-package Counter consumer supplies only approved task/configuration/suite; no custom host/broker/credential/process/cleanup scripts or per-run library compilation/npm packing |
| AH8.5 | AH8.2–AH8.4 and AH8.7 | Core dependency/export/consumer audit, unchanged generic MBT behavior, local/proxy result equivalence and compatibility/deprecation evidence |
| AH9.1 | AH2–AH8 and AH11 | Integrated adversarial/public-interface acceptance, real author/build/worker isolation, preserved existing gates, native-client parity and bounded cleanup |
| AH10.1 | AH9.1 | Coordinator-independent destination review, exact gate exits/versions, compatible package/usage docs and explicit remaining service scope; no publication inferred |
| AH12.1 | AH8 suite/integration contract; planning can precede code | Freeze separate evaluation-service transport/schema, authorized suite/artifact references, caller/run identity, duplicate-start/query, bounds, retention/disconnect and cleanup rules |
| AH12.2 | AH12.1, AH8.3 and AH8.6 | Optional trusted service resolving approved immutable suites/implementations and invoking the same harness; preserve Gate owner connection and private result projection |
| AH12.3 | AH12.2 | Proxy client plus configuration/registration examples; start/get/cancel, malformed/cross-caller references, uncertain replies and disconnect behavior |
| AH12.4 | AH12.2–AH12.3 | Fixed-input source-test/CLI/service equivalence, correct/faulty local and real Gate-backed runs, private-suite integrity and cleanup; record service-specific support separately |

Host implementation order is AH1.2 -> AH2 -> AH3/AH4/AH5.1 -> AH5.2 ->
AH6/AH7 -> AH11 -> AH8.4/AH8.6/AH8.7 -> AH8.5 -> AH9/AH10. The reviewed AH8 plan and
generic suite work need not wait for hosting; optional AH12 service delivery
must not become a dependency of local source tests or MirrorECMA's core.

Shared codec/policy/controller/package files have one owner at a time. A delegate
may read dependencies but must obtain an explicit ownership handoff before
editing another package's files. It must use public interfaces, preserve dirty
work and scratch files, and report source edits versus destination integration.
No task includes committing, pushing, credential acquisition, hosted deployment,
or unrelated Mirrors changes. Missing runtime/model access is a reported gate
limitation, not permission to weaken or claim the gate.

## R1–R3 task ownership

| Requirement | Owning tasks | Exit evidence |
| --- | --- | --- |
| R1: private host/config directories, credentials, broker, fresh launch, deadlines and teardown | AH2.2, AH3.1–AH3.2, AH4, AH5.2, AH11 | Actual supported-runtime audit and fresh author; partial-start/deadline/EOF cleanup removes temporary credentials and owned host resources |
| R2: workspace isolation, source/artifact freezing, restricted build/worker execution and cleanup | AH5.1–AH5.2 with existing supervisor/backend | Immutable lease reuse, writer quiescence, no unauthorized worker launch, real private-canary checks, and accurate cleanup receipts |
| R3: connect the submission to MBT, preserve owner, combine evaluation and cleanup evidence | AH8.2, AH8.6, AH8.7 and AH9/AH10 | Supported installed Gate workflow supplies a deferred factory to generic MBT; correct/faulty Counter, pre-factory failure cleanup, and trusted/public result projection |

The application retains Counter/public requirements, approved models and suite
revision, replay choices and disclosure policy. Development packaging belongs
to Gate's release/setup tooling, not the per-run application. AH12 wraps R3's
local implementation; it must not duplicate it or block local source tests.

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
  permitted. Specify the Gate-owned integration's generic implementation factory,
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
  transport, now implemented by `mirrorgate/hosting-tool` and its CLI. Actual
  outside-agent MCP acceptance remains separate from installed transport tests.

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
facade into a Gate-owned supported integration under `integrations/mirrorecma/`,
using public interfaces from both libraries. Separate packaging protects core
dependencies; MirrorGate owns its distribution, lifecycle and evaluation receipts. Inventory `src/sandbox.ts`,
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
to private suites. See the [harness design](https://github.com/NzSN/MirrorECMA/blob/main/docs/mbt-harness-design.md).

Migrate the Counter workflow so the user-started coordinator calls Gate directly
through AH11 (or native Gate automation). The resulting implementation is tested
by ordinary MirrorECMA MBT against an existing Mirrors server. Preserve private
evaluation/disclosure ownership, archived historical evidence, source/artifact
identity, and real restricted build/worker execution. Retain a Gate-free core
test/consumer gate and compare local versus proxy implementations through the
same MBT entry point. The external package and MirrorECMA 2 cutover now implement
this migration; completed destination/core/live checks establish delivery
beyond the isolated implementation checkout.

Exit evidence: equivalent native client behavior, public package/declaration
consumption, and a migrated experiment receipt that records source/artifact
identities, versions, public tool traffic, private evaluation outcome, and cleanup
without exposing credentials or private oracle contents.

### AH8.6 — Gate-owned local workflow and aggregate receipt

Own the integration's `src/workflow.ts`, `src/provider.ts`,
`src/receipt.ts`, public exports/declarations and focused workflow/receipt tests
under `integrations/mirrorecma/`. AH8.2 hands over these shared files explicitly.
Reuse AH3/AH4 host machinery, AH5 authoritative lifecycle and AH6 public control;
do not create another session/snapshot/worker state machine.

Freeze the trusted workflow input/output records before implementation: approved
task/profile/workspace and suite references, model transport, deadline/disclosure
policy, run/source/artifact/interface correlations, model outcome, primary error,
cleanup outcome and remaining resources. Support source authoring followed by
evaluation and an approved prebuilt implementation. Keep the same Gate owner
connection and release it only after the complete workflow settles. The
implementation factory is invoked after a required model match, not before.

The Gate module owns readiness, host/credential/broker lifetime, evaluation
composition and bounded cleanup; applications supply domain inputs and their
suite. Cover failure before factory invocation, partial factory construction,
late resolution after cancellation, source commit followed by failure, and
cleanup failure after a model pass. Keep full diagnostics/identities trusted
and apply the configured public projection to tool/service results. No private
model or credentials may enter author/worker channels.

### AH8.7 — Installed consumer with no custom lifecycle scripts

Own new installed-consumer fixtures and registration/configuration examples under
`integrations/mirrorecma/test/` and `integrations/mirrorecma/examples/`; coordinate
Counter experiment migration with AH8.4. Consume packed installed artifacts as
the test setup, then run with declarative configuration and the approved suite.
No normal evaluation may compile the MirrorECMA library, run repository
`npm pack`, or require caller-written copies of `setup-fresh-restricted-counter.py`
and `run-fresh-restricted-counter.py`. Submitted application builds remain
restricted and are not removed by this requirement.

Verify a fresh implementer and a prebuilt submission through the same supported
workflow. Require correct/faulty MBT outcomes, private-canary guards, no worker
on model mismatch, retained owner through cleanup, and separate public/trusted
receipts. Compare submitted source identity and show that only approved input
configuration and suite code live in the consumer. The prior helper-driven
MirrorExamples success is migration evidence, not completion of this task.

AH8.6/AH8.7 are implemented in the external package and installed consumer.
The synthetic-host/real-backend matrix supplements actual SDK, installed MCP
protocol-harness and outside-Codex framework runs. Completed AH8.5/AH9/AH10
destination evidence is recorded by the coordinator.

## AH11 — Standard outside-agent hosting-tool adapter

MirrorGate distributes the adapter that lets an outside coordinating agent
request an approved hosted implementer run. Applications configure and register
this supplied adapter in their agent framework; those frameworks' registration
APIs remain outside MirrorGate's ownership. AH4 separately supplies the tools
used by the implementer inside restricted authoring. Neither adapter creates a
second launcher, broker lifecycle, or session transition implementation.
Hosting tools are exposed only to the outside coordinating agent; they do not
enable delegation by the restricted implementer.

AH1's tool contract is implemented in the Gate-owned
`integrations/agent-host/` module using the public native SDK. Its first
transport is stdio MCP backed by the Node SDK, supplied through the package
entry and CLI. Package the entry point, schemas, explicit
trusted configuration, and registration examples so consumers need no custom
launch wrapper. Configuration fixes approved task/context bindings and agent
profiles; requests carry approved task references and caller-scoped opaque run
references. `hosting_start`, `hosting_status` and `hosting_cancel` have closed
schemas in the supplied adapter.

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
as a wrapper around AH8.6's Gate-owned local workflow and receipt projection.
Reuse AH8's approved suite; do not duplicate evaluation or cleanup orchestration. Keep
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
| End-to-end evaluation | AH8, AH9, AH11: Gate-owned integration supplies the implementation to ordinary MBT |
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
and real worker. The Gate-owned integration supplies that proxy through the same
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

R1–R3 completion additionally requires AH8.6/AH8.7 installed-consumer evidence:
no custom host/broker/process/credential/cleanup glue and no per-run library
compilation/packing. The optional service must reuse the local workflow/receipt
implementation. Record the helper-run baseline separately from product support.

The coordinator independently reviews negative paths and final destination
status. Update compatibility only for demonstrated profiles; keep release,
hosted CI, resume, and other unimplemented behavior explicitly separate. No
commit, push, or publication is implied by this task assignment.

## Current implementation evidence and remaining acceptance

| Work packages | In-repository implementation / reproducible checks | Current boundary |
| --- | --- | --- |
| AH1.1–AH1.2, AH2.1 | [V2 contract](agent-hosting-control-v2.md), [shared corpus](../conformance/control-v2/vectors.jsonl), [codec tests](../tests/test_control_protocol_v2.py) | Frozen v1 assets and worker/model protocols preserved |
| AH2.2, AH3.1–AH3.2 | [Runtime/profile/audit tests](../tests/test_agent_backend.py), [runtime adapter](../supervisor/mirrorgate/agent_runtime.py), [dispatcher audit](../supervisor/mirrorgate/agent_audit.py) | Actual audit, SDK author and real outer/inner Codex MCP workflow passed; per-installation audit freshness remains required |
| AH4.1–AH4.2, AH5.1–AH5.2 | [Broker/backend tests](../tests/test_agent_backend.py), [controller races](../tests/test_hosting_controller.py) | Fake-host races are labeled; real Bubblewrap source/build handoff is tested separately |
| AH6.1 | [Node v2 tests](../tests/node/control-v2.test.mjs), [real controller tests](../tests/node/control-v2-integration.test.mjs), [SDK API](../sdk/node/README.md) | Owned/attached native access; fixture authors are synthetic |
| AH7.1 | [C++ hosting tests](../tests/cpp/hosting_test.cpp), [native lifecycle gate](../tests/cpp/hosting_e2e.cpp), [SDK API](../sdk/cpp/README.md) | Shared contract and real controller/build/worker; synthetic author is explicit |
| AH8.1–AH8.3, AH8.5–AH8.7 | [Package API](../integrations/mirrorecma/README.md), [workflow](../integrations/mirrorecma/src/workflow.ts), [receipt](../integrations/mirrorecma/src/receipt.ts), [installed consumer gate](../integrations/mirrorecma/scripts/installed-workflow.mjs) | MirrorECMA core cutover and generic source/local/proxy suite verified in destination/core/live and interop gates |
| AH8.4, AH9.1 | [Installed Counter application](../integrations/mirrorecma/examples/counter/evaluate.mjs), [full Gate gate](../scripts/test.sh) | Actual SDK/MCP/framework authors and synthetic matrix are distinct; destination Gate and real mTLS replay passed |
| AH11.1–AH11.2 | [Hosting-tool API/configuration](../integrations/agent-host/README.md), [installed MCP tests](../tests/node/hosting-tool-package.test.mjs), [tool tests](../tests/node/hosting-tool.test.mjs) | AH11.1/AH11.2 passed: installed protocol harness and real outside-Codex framework registration/dispatch |
| AH12.1–AH12.4 | [Local service contract](evaluation-service-contract-v1.md), [service/proxy tests](../integrations/mirrorecma/test/service.test.ts), [installed source/service driver](../integrations/mirrorecma/test/service-installed-driver.mjs) | Authenticated loopback HTTP and real Gate/Mirrors same-suite checks; no remote/TLS or durable restart profile |
| AH10.1 | [Coordinator validation report](managed-workflow-validation.md) | Destination and final code gates passed; publication/hosted CI remain separate |

Independent review additionally exercised hostile runtime descendants, source and
cleanup races, delayed SDK replies/events, service response socket teardown,
callback getter mutation, overall polling deadlines and arbitrary rejection
values. Fixes are supported by regression tests; the final evidence report owns
exact final-tree commands, versions and exits.

## Planning and execution record

The following earlier entries describe their state at the time of each design
step. References to queued work in these historical entries are superseded by
the current implementation/evidence tables above.

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
- 2026-09-09: Explicitly assigned R1 agent hosting, R2 sandbox/artifact lifecycle,
  and R3 trusted MBT integration to MirrorGate. Added AH8.6 local workflow/receipt
  and AH8.7 installed-consumer delivery; AH12 must reuse that local workflow.
  The reviewed helper-driven Counter run passed five traces/24 ticks, but these
  supported workflow tasks remain queued and no runtime change is claimed.
- Planning review: complete using the worker fallback described above; the
  ledger incorporates the following source-grounded prerequisites. This is
  planning evidence, not completion of AH1 or any runtime task.
- Runtime implementation, native clients, external MBT migration and optional
  local service: implemented and exercised in the shared checkouts. Gate full
  isolation/native gates passed locally. Actual outside-agent MCP dispatch and
  final destination verification remain explicit acceptance work.

- Final validation: destination parity, Gate full/native gates, MirrorECMA
  core/live gates, integration/package tests, Mirrors gates and central interop
  passed. Actual outside Codex registered the shipped MCP tool, launched a fresh
  real implementer, submitted source, passed MBT and confirmed cleanup.

### Historical planning review evidence

These findings explain the original implementation requirements. The current
code resolves the source-lease, run/tool-slot, runtime cleanup and package gaps;
they are not descriptions of an unchanged current implementation.

- Decoupling review confirmed that MirrorECMA's public async adapter registry
  already defers factory invocation until a validated model match. AH8 can keep
  Gate authorize/acquire/connect in the external factory and supply the generic
  binding without extending MBT semantics. Retain authority privacy and late
  factory/disposal behavior. At that planning point, sandbox source, root exports, peer metadata and
  packaging still required migration; AH8 now implements that cutover.

- [`ControlBackend.prepare`](../supervisor/mirrorgate/preparation.py) at the planning baseline
  rejected an already sealed session and combines source freezing with build and
  artifact freezing. `_stop_authoring` sets the sealed flag. AH1/AH5 must define
  and implement reuse of a committed source lease; simply sealing in `submit`
  and invoking the current preparation path cannot work.
- [`_op_session_prepare` and `_new_operation`](../supervisor/mirrorgate/orchestration.py)
  enforce one active ordinary operation. AH1/AH5 must keep the hosted-run slot
  separate, otherwise a pending host operation excludes its own authoring tools.
- The experiment's
  [`run_author.py`](https://github.com/NzSN/MirrorECMA/blob/main/experiments/blind-counter/author-host/run_author.py)
  inherits `os.environ`, writes unbounded transcript/diagnostic files, and removes
  the authentication copy without establishing full host/broker/descendant
  cleanup. These are migration gaps for AH3/AH5, not supported hosting behavior.
- The experiment's
  [`audit_tools.py`](https://github.com/NzSN/MirrorECMA/blob/main/experiments/blind-counter/author-host/audit_tools.py)
  exercises shell, image, and patch rejection and a permitted public-contract
  call. It permits resource-discovery tools in the advertised inventory without
  exercising their denial. AH3/AH9 require the broader actual-dispatch and
  context-isolation evidence specified above.
- Adapter planning review separates AH11 outside-agent launch/query/cancel
  mediation from AH4 implementer-side authoring tools. Shared ownership remains
  connection-bound as specified in
  [control v1 ownership](orchestration-control-v1.md#3-startup-principal-and-ownership);
  AH1 must define the adapter/evaluator shared-connection lifetime before AH11
  implementation. At that stage the stdio MCP adapter had no runtime/package evidence. The
  current installed adapter and actual outside-Codex dispatch are covered above
  by separately identified protocol-harness and real-framework evidence.
