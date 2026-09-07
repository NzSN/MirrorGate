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
are not implemented. See the [backend's exact limits](docs/linux-bubblewrap.md).

## Design documents

The [design index](docs/README.md) records the architecture discussion and links
the [architecture](docs/architecture.md), [blind-validation requirements](docs/blind-validation.md),
[shared worker protocol](docs/worker-protocol.md), and
[implementation plan](docs/implementation-plan.md). Open technology and wire
format decisions are identified explicitly.

The [sandbox design walkthrough](https://github.com/NzSN/MirrorGate/blob/main/docs/sandbox-design.md) follows a tool request
through trusted configuration, Bubblewrap isolation, monitoring, and cleanup,
and explains what the implementation agent's host must enforce.

The proposed [orchestration control v1 contract](https://github.com/NzSN/MirrorGate/blob/main/docs/orchestration-control-v1.md)
defines the shared process needed by Mirrors client-guide section 13. Its
[MirrorECMA landing plan](https://github.com/NzSN/MirrorECMA/blob/main/docs/shared-orchestration-design.md)
separates the control implementation, async replay prerequisites, native
facade, and cross-language acceptance. These interfaces are not yet shipped.

## Architecture

```text
Private evaluation environment             Restricted worker

Mirrors + Apalache
        |
Trusted evaluator  <--- public port RPC ---> Language shim -> Adapter -> SUT
        |
MirrorGate supervisor --------------------> Launch, limit, terminate, clean up
```

MirrorECMA can provide the first trusted evaluator integration. A restricted
worker implements the public port protocol and does not need a complete Mirrors
client. Other language clients can integrate through the same protocol.

## Responsibilities

| Owner | Responsibility |
| --- | --- |
| Mirrors | Model resolution, interface generation, model execution, and comparison |
| MirrorGate | Worker protocol, sandbox lifecycle, runtime shims, and shared conformance tests |
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
sdk/node/       Trusted evaluator port proxy
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
The backend requires working unprivileged user namespaces and a non-root
controller. It refuses unsupported isolation; the full test script treats an
unavailable backend as failure rather than silently skipping it.

```bash
cargo fetch --manifest-path runtimes/rust/Cargo.toml --locked
bash scripts/build.sh
bash scripts/test.sh
```

The fetch step obtains checksum-locked dependencies; subsequent build/test steps
use Cargo offline. The Python and Node components use standard libraries only.
When the installed Rust toolchain has a different local name but is exactly
1.96.0, select it explicitly with `RUSTUP_TOOLCHAIN`; the build script verifies
the actual compiler version. This repository does not require a global toolchain
alias change.

The full gate covers strict Python validation, the shared vector corpus, both
worker SDKs, actual sandbox access denial, cross-language lifecycle cases, and
correct/faulty Counter behavior. CI uses the same required-backend gate. Hosted
CI results are separate from local validation.

## Integrate an evaluator or agent host

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
