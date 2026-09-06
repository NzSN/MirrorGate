# MirrorGate

Isolated execution through a shared interface.

MirrorGate is the shared worker infrastructure for the Mirrors ecosystem. It
separates submitted adapters and their systems under test from a trusted
evaluation environment, using a language-neutral port protocol.

## Status

Initial repository setup. The architecture below describes the intended scope;
no sandbox launcher, worker runtime, or enforced isolation is implemented yet.

## Design documents

The [design index](docs/README.md) records the architecture discussion and links
the [architecture](docs/architecture.md), [blind-validation requirements](docs/blind-validation.md),
[shared worker protocol](docs/worker-protocol.md), and
[implementation plan](docs/implementation-plan.md). Open technology and wire
format decisions are identified explicitly.

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

## Planned organization

```text
protocol/       Message schemas, value semantics, lifecycle, and versioning
supervisor/     Sandbox launch, resource policy, cancellation, and cleanup
runtimes/       Language-specific shims for Node, C++, Rust, and Lean
conformance/    Shared positive, malformed-message, and isolation fixtures
docs/           Designs, decisions, and implementation plans
```

Share protocol and policy mechanisms across languages. Keep native invocation
and value conversion in small language shims. Model resolution and generation
stay in Mirrors; MirrorGate consumes public interface artifacts without private
invariant logic or dependencies on MirrorECMA internals.

## Initial development sequence

1. Specify the public worker protocol and its relationship to the existing
   Mirrors model-interface types and semantic digest.
2. Define the isolation guarantees, trusted configuration, and allowed worker
   capabilities for the first sandbox backend.
3. Implement the supervisor and a Node worker, then one native-language worker
   to demonstrate that the protocol is independent of JavaScript.
4. Integrate a trusted evaluator through generated port proxies.
5. Verify equivalent behavior across workers and actual denial of private
   filesystem, process, credential, and network access under the chosen policy.

Implementation language, sandbox backend, and build commands will be documented
when selected and exercised. No runtime dependency or build system is selected
by this initial setup.
