# Choosing a Gate client and worker

Gate owns the shared controller and isolation backend. A native evaluator SDK
connects trusted application testing code to that controller; a worker runtime
executes submitted implementation code inside the sandbox. These are different
roles. See the [framework map](../../Mirrors/Docs/framework-map.md) for model-client
capabilities and the [architecture](architecture.md) for ownership.

| Evaluator | SDK | Integration | Current boundary |
| --- | --- | --- | --- |
| TypeScript / Node | [Node SDK](../sdk/node/README.md), control-v1/v2 | [MirrorECMA suites](../integrations/mirrorecma/README.md) and `evaluateSuite` | Default Node application workflow; model transport may be local or remote |
| C++ | [C++ SDK](../sdk/cpp/README.md), control-v1/v2 | [MirrorCPP integration](../integrations/mirrorcpp/README.md) | Reusable source facade plus generated Counter acceptance; no mandatory Node evaluator |
| Rust | [Rust SDK](../sdk/rust/README.md), control-v1 only | [MirrorRust integration](../integrations/mirrorrust/README.md) | Reusable composition with reviewed bindings; handwritten Counter fixture; local model stdio in the current facade |
| Lean | Not implemented | Not implemented | MirrorLean's model-server client and async jobs do not provide Gate orchestration |

All implemented SDKs drive the same Python controller. Gate's Node and Rust
workers implement worker-v1 and can be selected independently of evaluator
language. `runtimes/rust` is the worker side; `sdk/rust` is the evaluator side.
The Rust evaluator/Rust worker path needs no Node runtime. A Node worker still
needs the approved Node installation.

The controller backend is Linux/Bubblewrap. A remote Windows Mirrors checker can
be used through an appropriate model client without moving Gate isolation to
Windows. See [remote model-server integration](remote-mirrors.md); its
`evaluateSuite` transport examples apply to the Node integration, not every
native facade.

## Shared lifecycle

1. Open an owned controller or attach to an explicitly selected trusted Unix endpoint.
2. Prepare the admitted submission and frozen artifact.
3. Obtain the required model-interface match in the trusted evaluator.
4. Authorize and acquire the worker inside the post-match binding factory.
5. Invoke public operations and observe the real implementation; keep private models, expected states and credentials on the trusted side.
6. Preserve the primary result while checking worker/session cleanup and controller-close receipts. An attached client must not kill the shared controller.

The [Rust acceptance record](rust-evaluator-sdk-status.md) distinguishes its
implemented control-v1 fixture from a future generated Rust target and v2
hosting. [Compatibility](compatibility.md) lists version/platform limits.
A green model result alone does not establish completed cleanup or sandbox
isolation. None of these source-level results implies package publication or
hosted CI success.
