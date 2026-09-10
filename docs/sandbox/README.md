# MirrorGate sandbox documentation

This directory groups the documents whose primary subject is restricted
execution, trusted supervision, filesystem exposure, or isolation evidence.
MirrorGate's broader architecture, control protocol, managed hosting, and worker
RPC documents remain one level above because they cover responsibilities beyond
the sandbox boundary.

## Start here

| Question | Document | Status |
| --- | --- | --- |
| What does the trusted supervisor own? | [Supervisor design](supervisor-design.md) | Implemented design and explicit current limits |
| How does one request become an isolated command? | [Sandbox walkthrough](design.md) | Implemented Linux/Bubblewrap path |
| Which namespaces, mounts, and limits are enforced? | [Linux/Bubblewrap profile](linux-bubblewrap.md) | Implemented backend |
| Which roots, source views, tools, build plans, and runtimes may be selected? | [Control-policy catalog](control-policy-v1.md) | Implemented policy v1 and v2 extensions |
| What evidence supports a blindness claim? | [Blind validation](blind-validation.md) | Required threat and validation model |
| Which sandbox/workflow improvements remain? | [Restricted-workflow follow-ups](restricted-workflow-followups.md) | Proposed work, not implementation claims |
| How are filtered repository views implemented? | [Filtered source views plan](source-views-plan.md) | Implemented contract, assignments, review fixes, and completion gates |

## Related top-level contracts

| Concern | Document |
| --- | --- |
| Repository and trust boundaries | [Architecture](../architecture.md) |
| Shared session state machine and operations | [Orchestration control v1](../orchestration-control-v1.md) |
| Managed implementer lifecycle | [Agent-hosting control v2](../agent-hosting-control-v2.md) |
| Authoring and evaluation composition | [Managed workflow](../managed-workflow-design.md) |
| Runtime-neutral implementation port | [Worker protocol](../worker-protocol.md) |
| Node and Rust runtime shims | [Node worker](../node-worker.md), [Rust worker](../rust-worker.md) |
| Current compatibility claims | [Compatibility](../compatibility.md) |
| Recorded aggregate validation | [Managed-workflow validation](../managed-workflow-validation.md) |

The supervisor is trusted host software. Bubblewrap and the Linux kernel enforce
the environment it constructs. The restricted command, submitted build hooks,
runtime adapters, and SUT are untrusted. Mirrors owns model semantics and
comparison; a trusted evaluator owns private specifications, traces, expected
states, and disclosure policy.

When changing a sandbox guarantee, update the supervisor design and the most
specific backend or policy document together. A claim is complete only after
the relevant negative test runs against the real required backend; mock process
tests and unavailable namespaces do not establish isolation.
