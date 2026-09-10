# MirrorGate

Isolated execution through a shared interface.

MirrorGate is the shared worker infrastructure for the Mirrors ecosystem. It
separates submitted adapters and their systems under test from a trusted
evaluation environment, using a language-neutral port protocol.

## Status

The initial Linux/Bubblewrap profile is implemented, with a Python supervisor,
Node and Rust workers, strict public-port RPC, and a trusted Node proxy SDK.
Isolation claims apply to the configured and tested profile, not arbitrary host
tools. Aggregate cgroup quotas, Windows/macOS backends, and other language shims
are not implemented. See the [backend's exact limits](docs/sandbox/linux-bubblewrap.md).
Policy-v2 source roots may use implemented
[filtered source views](docs/sandbox/supervisor-design.md#filtered-source-views)
to expose an exact repository subset during authoring and preparation.
Managed hosting, native v2 clients, the external MBT workflow and optional local
HTTP service are integrated in the destination repositories and their required
gates passed. An actual Codex implementer also ran through the installed hosting
tool's MCP protocol harness. A real outside Codex coordinator then registered
the same installed MCP adapter and completed a real implementer/MBT/cleanup run. The [validation report](docs/managed-workflow-validation.md)
records exact versions, commands and evidence. No package publication is claimed.

## Design documents

The [design index](docs/README.md) records the architecture discussion and links
the [architecture](docs/architecture.md), [blind-validation requirements](docs/sandbox/blind-validation.md),
[shared worker protocol](docs/worker-protocol.md), and
[implementation plan](docs/implementation-plan.md). Open technology and wire
format decisions are identified explicitly.

The [sandbox documentation](docs/sandbox/README.md) groups the
[supervisor design](docs/sandbox/supervisor-design.md), the
[sandbox walkthrough](docs/sandbox/design.md), backend, policy, and
blind-validation references. Together they follow a tool request through
trusted admission, Bubblewrap isolation, monitoring, snapshots, and cleanup.

The [agent-hosting implementation](docs/agent-hosting-design.md) provides
implementer launch, configuration, restricted tools, and cleanup through
[control v2](docs/agent-hosting-control-v2.md).
The user-started coordinator requests implementation directly from Gate through
its standard hosting tool or native SDK. MirrorECMA retains generic MBT against
implementations; a Gate-owned trusted integration supplies the proxy and local
evaluation workflow, retains the owner connection, and combines result/cleanup
evidence. All three responsibilities are covered by the
[managed workflow design](docs/managed-workflow-design.md).
Agent prompts, launch, builds, and Gate lifecycle stay outside MirrorECMA's
core. The extracted `mirrorgate-mirrorecma` package supplies `evaluateImplementation`,
prepared providers and the compatibility `/legacy` entry point. MirrorECMA 2
removes the Gate-specific core exports. The [task ledger](docs/agent-hosting-tasks.md)
records completed destination and actual-framework acceptance evidence.

The experimental [orchestration control v1 contract](https://github.com/NzSN/MirrorGate/blob/main/docs/orchestration-control-v1.md)
defines the shared process needed by Mirrors client-guide section 13. The
[operator policy catalog](docs/sandbox/control-policy-v1.md) fixes approved roots,
commands, runtime mounts, launchers, attestation identities, and limit ceilings. The
[usage guide](https://github.com/NzSN/MirrorGate/blob/main/docs/orchestration-control-usage.md)
and [implementation tasks](https://github.com/NzSN/MirrorGate/blob/main/docs/orchestration-control-v1-tasks.md)
cover the controller, immutable preparation, managed transport, and native
Node/C++ SDKs. Its
[MirrorECMA landing plan](https://github.com/NzSN/MirrorECMA/blob/main/docs/shared-orchestration-design.md)
separates the control implementation, async replay prerequisites, native
model facade, and cross-language acceptance. Recorded local facade results are
in the [implementation ledger](docs/orchestration-control-v1-tasks.md). V2 hosting
uses separate schemas and capabilities; frozen v1 and worker RPC remain unchanged.
Production package publication remains disabled.

The optional [evaluation service](docs/evaluation-service-design.md) lets an agent,
CI job, or application invoke the same trusted MBT harness used by source-code
tests. Its service proxy requests evaluations; the implementation proxy invokes
the SUT. The service's [local HTTP contract](docs/evaluation-service-contract-v1.md)
uses configured caller tokens and approved suite/implementation references.
Remote/TLS service deployment is not implemented. Both proxies stay outside
MirrorECMA's core, and neither extends control v1.

## Architecture

```text
Private evaluation environment             Restricted worker

Mirrors + Apalache
        |
Trusted evaluator  <--- public port RPC ---> Language shim -> Adapter -> SUT
        |
MirrorGate supervisor --------------------> Launch, limit, terminate, clean up
```

MirrorGate's trusted evaluation integration uses generic MirrorECMA MBT and a
Gate implementation proxy. A restricted worker implements public-port RPC and
does not need a complete Mirrors client. Gate core and native SDKs remain usable
without MirrorECMA; the external integration uses only public APIs from both.

## Responsibilities

| Owner | Responsibility |
| --- | --- |
| Mirrors | Model resolution, interface generation, model execution, and comparison |
| MirrorGate | Worker protocol, sandbox lifecycle, runtime shims, managed agent host, hosting tool and conformance |
| MirrorECMA | Generic MBT against supplied implementations; core excludes hosting and Gate lifecycle |
| MirrorGate-owned trusted evaluation integration | Supply the supported local workflow/proxy/factory, preserve admission and ownership, combine evaluation/cleanup evidence, and optionally expose a service |
| Trusted evaluator | Private specification, validation configuration, expected results, and evaluation policy |
| Application | Actual implementation and the adapter mapping public operations to it |

The worker receives declared operation inputs and returns actual observations.
Keep private specifications, expected states, evaluator credentials, raw model
messages, and evaluation diagnostics in the trusted environment. Place the RPC
seam at the generated implementation port; the lower-level `StateComputer`
interface can expose initial model state and previous reported state.

Repository separation is organizational. Enforced blindness also requires
restricted access during authoring, building, and execution. An ordinary child
process or a TypeScript interface alone does not supply that isolation.

## Repository organization

```text
protocol/       Message schemas, value semantics, lifecycle, and versioning
supervisor/     Python policy, snapshots, Bubblewrap launch, and cleanup
runtimes/       Node and Rust shims; other languages can implement the protocol
sdk/node/       Trusted control client and worker port proxy
sdk/cpp/        Native C++ control client and worker port proxy
conformance/    Shared positive, malformed-message, and isolation fixtures
integrations/   Optional trusted evaluator integrations
docs/           Designs, decisions, and implementation plans
```

Share protocol and policy mechanisms across languages. Keep native invocation
and value conversion in small language shims. Model resolution and generation
stay in Mirrors; MirrorGate consumes public interface artifacts without private
invariant logic or dependencies on MirrorECMA internals.

## Build and verify

Use Python 3.12, Bubblewrap 0.9 or newer, Node 24.15.0, and Rust 1.96.0 on Linux.
The C++ SDK gate additionally requires CMake 3.20 or newer, a C++17 compiler,
and `nlohmann_json` exactly 3.11.3. The declaration-consumer gate uses the
development TypeScript compiler selected by the package lockfile.
The backend requires working unprivileged user namespaces and a non-root
controller. It refuses unsupported isolation; the full test script treats an
unavailable backend as failure rather than silently skipping it.

```bash
cargo fetch --manifest-path runtimes/rust/Cargo.toml --locked
npm ci --ignore-scripts
bash scripts/build.sh
bash scripts/test.sh
```

The fetch step obtains checksum-locked dependencies; subsequent build/test steps
use Cargo offline. The core Python supervisor and Node worker/SDK use standard libraries only.
The optional MBT package separately depends on public MirrorECMA/Gate APIs.
The TypeScript compiler is a test-only development dependency. Set
`MIRRORGATE_NODE_RUNTIME_ROOT` to the approved Node 24.15.0 distribution root
so actual sandbox workers use the same pinned runtime as the host tests.
For a headers-only C++ dependency, set `MIRRORGATE_NLOHMANN_JSON_INCLUDE_DIR`
to the directory containing `nlohmann/json.hpp` from version 3.11.3.
When the installed Rust toolchain has a different local name but is exactly
1.96.0, select it explicitly with `RUSTUP_TOOLCHAIN`; the build script verifies
the actual compiler version. This repository does not require a global toolchain
alias change.

The full gate covers strict Python validation, the shared vector corpus, both
worker SDKs, both native control clients, actual sandbox access denial,
public control lifecycle cases, package consumption, and
correct/faulty Counter behavior. CI uses the same required-backend gate. Hosted
CI results are separate from local validation.

## Integrate an evaluator or agent host

- [Managed authoring control v2](docs/agent-hosting-control-v2.md): approved
  profiles and public tasks through Node `startAgent` or C++ `start_agent`.
- [Standard hosting tool](integrations/agent-host/README.md): configure/register
  `mirrorgate-hosting-tool`; applications do not write a launcher or broker.
- [Local evaluation workflow](integrations/mirrorecma/README.md):
  `evaluateImplementation` and original-owner `evaluateHostedSubmission`.
- [Optional evaluation service](integrations/mirrorecma/service/README.md):
  authenticated loopback HTTP over the same approved suite and workflow.
- [Node worker and proxy](docs/node-worker.md): `WorkerClient.launch`, native
  values, lifecycle, cancellation, and cleanup.
- [Rust worker SDK](docs/rust-worker.md): reusable native adapter trait and
  correct/faulty Counter worker.
- [MirrorECMA integration](integrations/mirrorecma/README.md): private model-side
  replay through generated port proxies, including the queue example.
- [Authoring host example](examples/authoring-host.py): the trusted host fixes a
  public workspace once, then accepts only `{argv, cwd}` tool requests. It does
  not expose administrative profile or host-mount selection to the agent.

`bin/mirrorgate` and `python -m mirrorgate.cli` are administrative interfaces for
trusted controllers. Giving them unrestricted host invocation to an agent would
bypass the intended tool boundary. The caller must also keep private prompts,
retrieval context, credentials, and external tools outside the agent's access.

## Development sequence and status

1. Specify the public worker protocol and its relationship to the existing
   Mirrors model-interface types and semantic digest.
2. Define the isolation guarantees, trusted configuration, and allowed worker
   capabilities for the first sandbox backend.
3. Implement the supervisor and a Node worker, then one native-language worker
   to demonstrate that the protocol is independent of JavaScript.
4. Integrate a trusted evaluator through generated port proxies.
5. Verify equivalent behavior across workers and actual denial of private
   filesystem, process, credential, and network access under the chosen policy.

The [assigned task tracker](docs/tasks.md) records implementation and evidence.
The [milestone plan](docs/implementation-plan.md) distinguishes the implemented
local profile from future backends, additional shims, and release/hosted work.
