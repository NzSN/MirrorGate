# MirrorGate design index

Recorded on 2026-09-06 from the architecture discussion establishing MirrorGate.
These documents describe the agreed direction and proposed implementation work.
No MirrorGate supervisor, worker runtime, or enforced isolation is implemented.

| Document | Read when working on |
| --- | --- |
| [Architecture](architecture.md) | Repository responsibilities, trusted evaluation, shared infrastructure, and language shims |
| [Blind validation and isolation](blind-validation.md) | Information access during authoring, building, execution, and result disclosure |
| [Worker protocol](worker-protocol.md) | The public port RPC, value semantics, lifecycle, and compatibility |
| [Implementation plan](implementation-plan.md) | Milestones, dependencies, acceptance tests, and open decisions |

The central decisions are:

- Keep private specifications and evaluation configuration with the trusted
  evaluator; give implementers a sufficient public interface contract.
- Place worker RPC at the generated implementation port. Keep raw model
  messages and expected states inside the trusted environment.
- Share supervisor policy mechanisms, protocol semantics, and conformance
  fixtures across languages. Use small language-specific runtime shims.
- Keep MirrorGate independent of MirrorECMA internals. MirrorECMA is the first
  proposed evaluator integration, not a required implementation language.
- Treat isolation and observation fidelity as separate requirements.

The implementation language, first sandbox backend, first native worker,
concrete wire schema, numerical limits, and release process remain to be chosen.
Protocol examples and lifecycle names below are design vocabulary, not a frozen
API or commands that can already be executed.
