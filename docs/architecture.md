# MirrorGate architecture

Status: reference architecture with an initial Linux implementation. The
[backend guide](linux-bubblewrap.md) and [task evidence](tasks.md) identify the
implemented restrictions and limitations; broader platform guarantees remain
requirements rather than verified claims.

The accepted [agent-hosting design](agent-hosting-design.md) extends MirrorGate
ownership to the trusted agent host. That module is planned: current agent
launch/configuration still lives in external hosts and experiment helpers.
The standard outside-agent hosting-tool adapter is also planned MirrorGate-owned
code; applications configure and register it in their chosen agent framework.

MirrorGate is intended to manage access boundaries throughout authoring,
building, and evaluating an application's adapter and system under test (SUT).
It keeps the implementer's tools and submitted code separate from the private
validation oracle, while providing a shared interface for isolated execution.

## Primary user workflow

The user starts the coordinating agent, develops behavior/invariant specifications,
and checks the models. That agent requests restricted implementation directly
through Gate's hosting interface, supplying only an approved brief and public
compiler-generated port declarations. Gate creates the implementer and manages
authoring, source/build/artifact freezing, restricted execution, and cleanup.

The coordinator also writes the MBT harness. A separate trusted integration
supplies the generated binding over a Gate worker proxy to MirrorECMA's ordinary
MBT interface and connects to the existing Mirrors server. This integration owns
the Gate connection and authorization/cleanup composition. MirrorECMA itself
does not launch agents, accept prompts, build artifacts, or manage Gate.

This [implementation boundary](../../MirrorECMA/docs/implementation-boundary-design.md)
is the revised target. Current `evaluateSandboxed` code still couples MirrorECMA
to Gate and needs an explicit migration. The hosting-tool adapter remains
Gate-owned and is the primary agent-facing route; native Gate SDK automation
is also supported by the design. No runtime migration is claimed yet.

## Ownership

| Owner | Responsibilities |
| --- | --- |
| Mirrors | Resolve model interfaces, emit bindings, invoke Apalache, and compare reported observations with model states |
| Trusted evaluator/caller | Own private specifications, validation configuration, selected scenarios, expected results, task selection, and approval of public context and feedback |
| MirrorGate | Manage authoring, build, and execution sandboxes, tools, worker RPC, runtime shims, and conformance; planned agent host owns implementer launch, configuration, context delivery, and cleanup |
| Isolation backend | Enforce the configured filesystem, process, privilege, network, and resource restrictions through OS, container, or VM mechanisms |
| Trusted agent host (planned MirrorGate module; currently external) | Launch/configure the implementer, route access-capable tools through MirrorGate, deliver approved public context, and manage agent lifecycle |
| Hosting-tool adapter (planned MirrorGate module) | Expose restricted start/status/cancel operations to the outside agent through the public Gate SDK; validate approved task bindings and project allowed results |
| Application integration | Register/configure Gate's agent-facing tools and approve public inputs |
| Separate trusted evaluation integration | Supply an implementation proxy/binding to MirrorECMA, bridge negotiated admission to Gate, retain Gate ownership, and await cleanup |
| MirrorECMA | Generic MBT against caller-supplied implementations; Gate-aware orchestration is a migration concern, not target core semantics |
| Application implementer | Write the actual SUT and adapter through the public authoring environment, then submit a fixed artifact for evaluation |

The complete specification may contain public interface information as well as
private invariants and transition logic. The evaluator exports the public
contract needed by the implementer; it retains the private validation material.

MirrorECMA provides generic MBT and binding execution. A separate trusted
integration composes it with Gate's implementation proxy. Trust belongs to the
evaluator code/configuration and its execution environment, not to a library name.
Gate's core does not depend on MirrorECMA; the optional integration uses only
public interfaces from both libraries.

## Access boundary ownership

MirrorGate owns the policy and lifecycle layer for all three sandbox profiles.
The isolation backend supplies actual access enforcement; the evaluator owns
the private data and decides what information may be disclosed.

| Profile | Permitted work and resources | Controlled handoff |
| --- | --- | --- |
| Authoring | Public contract, SUT/adapter source, approved development tools and public tests | Snapshot the submitted source without a live writable link to evaluation |
| Build | Submitted source, approved dependencies/toolchain, and build scripts; no evaluator secrets | Record and freeze the built artifact and dependency identities |
| Execution | Frozen artifact, permitted port inputs, writable SUT resources, and approved test services | Return actual observations; keep private evaluation reports with the evaluator |

The implementer is the human or coding agent that writes the code. The
restricted execution worker runs the submitted adapter and SUT; it does not
host an authoring agent that can change the submission between private cases.
An authoring agent may have broad development capabilities within its own
profile without gaining access to the evaluation environment.

The trusted agent host, owned by MirrorGate in the target design, must route
the coding agent's filesystem operations,
shell commands, search, builds, and other resource-access tools through
MirrorGate-managed execution or an explicitly approved restricted integration.
The agent must not retain an unrestricted host tool or connector that can read
private evaluator resources. Such a route bypasses MirrorGate and invalidates
the corresponding blindness claim; merely placing the workspace in another
directory or repository does not close it.

Private specifications, credentials, expected states, and hidden diagnostics
must also be excluded from the agent's prompts, retrieved context, and tool
responses. The evaluator approves disclosure; the agent host enforces delivery
and capability restrictions. A sandbox
cannot conceal information already supplied through an allowed channel.

MirrorGate accepts policy from trusted configuration. Submitted artifacts and
tool requests cannot grant themselves additional mounts, privileges, secrets,
network access, or access to sandbox-management interfaces. An environment
whose backend cannot enforce the requested profile must fail admission. A weaker
development profile must be selected explicitly and cannot claim the stronger
profile's blindness guarantee.

## Authoring, build, and evaluation flow

```mermaid
flowchart TB
    User["User"] <-->|"Requirements and specifications"| Coordinator["User-started coordinating agent"]
    Coordinator -->|"Approved brief and public port"| HostingTool["Gate hosting tool / SDK: planned"]
    Coordinator -->|"Write MBT harness"| Integration["Separate trusted evaluation integration"]
    subgraph Trusted["Trusted evaluation environment"]
        Spec["Behavior specification + invariants"] --> Mirrors["Existing Mirrors server + Apalache"]
        Mirrors <-->|"Model protocol"| MBT["MirrorECMA + trusted generated binding"]
        Integration -->|"Supply implementation factory"| MBT
        Integration -->|"Matched admission, owner lifecycle"| Supervisor["MirrorGate supervisor"]
        HostingTool --> Host["MirrorGate agent host: planned"]
        Host -->|"Bind tools to owning session"| Supervisor
        Host -->|"Launch with approved context"| Agent["Restricted implementer"]
        Supervisor --> Backend["Linux / Bubblewrap enforcement"]
    end
    subgraph Authoring["Restricted authoring environment"]
        Tools["Managed development tools"] <--> Workspace["Public source + port declarations"]
    end
    subgraph Build["Restricted build environment"]
        Builder["Toolchain + submitted build scripts"] --> Artifact["Frozen artifact"]
    end
    subgraph Execution["Restricted execution worker"]
        Shim["Runtime shim"] <--> Adapter["Submitted adapter + actual SUT"]
    end
    Agent <-->|"Approved authoring requests / results"| Supervisor
    Supervisor <-->|"Tool execution"| Tools
    Backend -.-> Tools
    Backend -.-> Builder
    Backend -.-> Shim
    Workspace -->|"Sealed frozen source"| Builder
    Artifact --> Shim
    MBT <-->|"Implementation calls / observations"| Proxy["External implementation proxy"]
    Proxy <-->|"Public port RPC"| Shim
```

The coding model or agent controller may be hosted elsewhere; the authoring
profile governs its accessible resources and tool execution, not the physical
location of model inference. Its host exposes the managed tool gateway without
an independent path to evaluator resources.

The agent-host node shows planned ownership, not an implemented launcher.
Its trusted process and model credentials remain outside the writable authoring
environment. Native clients will request hosting through shared Gate control
without implementing their own launchers. External hosts and human authoring
remain optional integrations with their own tool/context obligations. See the
[hosting lifecycle](agent-hosting-design.md#lifecycle-and-failure-rules).

For direct tool invocation by the outside coordinating agent, MirrorGate will supply the
[standard hosting-tool adapter](agent-hosting-design.md#standard-hosting-tool-adapter).
The application registers it and configures approved tasks and profiles. Its
start/status/cancel tools are distinct from the implementer's restricted
authoring tools; supplying the hosting tool to the implementer would enable
delegation outside the initial profile.

Solid arrows show information or control handoffs; dashed arrows show backend
enforcement. The supervisor creates, limits, terminates, and cleans up the
environments through that backend. The evaluator owns semantic validation.
Worker messages may travel over a channel supplied by the supervisor. The
authoring source is not mounted live into an active private evaluation.

## Harness reuse and evaluation-service access

The trusted MBT harness can be a reusable source module called by a test file,
CLI, or optional evaluation service. The service wrapper belongs to the external
trusted integration; suites and disclosure policy belong to the evaluator.
MirrorECMA still receives a generic implementation factory/binding.

An implementation proxy carries public operations between the generated binding
and the SUT. An evaluation-service proxy lets an outside caller start/query/cancel
an entire MBT run. They are separate interfaces and may be composed. Service
RPC does not extend Gate control v1, worker RPC, or the Mirrors model protocol.
See the [evaluation-service design](evaluation-service-design.md) and
[harness/source-test design](../../MirrorECMA/docs/mbt-harness-design.md).

## The public port is the RPC seam

The evaluator keeps the generated binding and model-facing replay logic. It
decodes model stimuli into declared inputs, calls a proxy implementing the
generated port, and encodes the returned observations for Mirrors.

The proxy sends public operations such as initialization, a typed action, or
observation. It never forwards an entire `StateComputer`/`ReplayComputer` call:
those interfaces can include the initial expected model state and previous
reported state. Filtering must happen before the worker channel.

Expected states, specification paths, invariant choices, private traces, raw
Mirror messages, and evaluator credentials remain in the trusted environment.
The worker receives only information permitted by its public port contract.

## Shared infrastructure and language-specific code

| Mechanism | Ownership |
| --- | --- |
| Authoring/build/execution policy, tool mediation, resources, process cleanup | Shared supervisor with isolation backend |
| Framing, correlation, lifecycle, cancellation/error semantics | Shared protocol |
| Stable IDs, value semantics, compatibility fixtures | Shared contracts and conformance suite |
| Loading the approved submission entry point and invoking native methods | Runtime-specific shim |
| Native representation conversion | Runtime-specific or generated codecs |
| Mapping model operations to real application behavior | Application adapter |

Node, C++, Rust, and Lean workers can implement the same protocol without
sharing a binary ABI. A worker does not need to run its language's complete
Mirrors client. A single trusted MirrorECMA driver could therefore evaluate
submissions in all these languages; other evaluators can integrate later.

The supervisor chooses trusted profiles for the three stages. Profiles may
have different dependencies and resource limits while sharing policy mechanisms.
The worker RPC is the execution-stage interface; it does not replace the
authoring tool gateway or authorize submission build scripts to run in the
trusted evaluator.

## Evidence required for an access-boundary claim

Verify each supported profile in the actual backend. Authoring tests must
attempt private-resource access through every exposed class of tool. Build
tests must exercise submission-controlled hooks. Execution tests must attempt
access through the running adapter, including filesystem, process, network,
credential, and management-interface routes denied by its policy.

Also verify that rejected tool requests cannot relax the policy, that private
context is not included in returned tool results, and that source edits after
submission cannot change the frozen artifact being evaluated. Record cleanup,
resource-limit, backend, and platform evidence separately.

These checks establish the tested access restrictions. They do not prove that
an observer reads the actual SUT rather than fabricating an answer, or that
permitted stimuli and verdicts reveal no information. Observation fidelity and
result disclosure remain separate obligations, as described in
[blind validation](blind-validation.md).

## Repository and dependency boundaries

The intended repository areas are `protocol/`, `supervisor/`, `runtimes/`,
`conformance/`, and `docs/`. Python supervision and Node/Rust runtime shims are
implemented; other language workers and backends remain extensions.

Mirrors remains authoritative for model-interface resolution and generation.
MirrorGate consumes versioned public artifacts and provides SDK/protocol
interfaces for generated code to target. It does not duplicate the resolver or
depend on MirrorECMA's private modules. External integrations depend on public
MirrorGate and MirrorECMA interfaces through explicit compatible versions.
The revised MirrorECMA core does not depend on Gate's SDK or lifecycle; current
coupled sandbox exports require the migration recorded in the task ledger.

Protocol compatibility, runtime profile identity, and semantic interface
identity are distinct. See [worker protocol](worker-protocol.md). The private
validation specification requires its own revision record; an interface digest
does not identify the hidden invariants used for evaluation.

Related: [isolation](blind-validation.md), [implementation plan](implementation-plan.md),
and the existing
[Mirrors generated-interface contract](https://github.com/NzSN/Mirrors/blob/main/Docs/generated-model-interface-spec.md).
