# Blind validation and isolation

Status: design requirements with an implemented Linux/Bubblewrap profile.
Consult its [tested restrictions and limitations](linux-bubblewrap.md) and the
[task evidence](../tasks.md); repository layout alone still supplies no guarantee.

## Objective

An adapter author should be able to implement a public contract without reading
the private evaluation specification, expected states, or held-out scenarios.
Submitted code should also be prevented from directly inspecting those private
materials during evaluation under the selected sandbox policy.

Blindness limits direct oracle access. It is not a claim that operations,
observations, timing, or repeated verdicts reveal no information whatsoever.

## Public and private information

| Public contract for the implementer | Private evaluator material |
| --- | --- |
| Operation and observation signatures/types | Full evaluation model and invariant definitions |
| Operation meanings and required behavior | Private scenario and trace-generation strategy |
| Initialization, ordering, and cleanup requirements | Expected state sequences and future stimuli |
| Public development examples | Held-out cases and detailed evaluation diagnostics |

The public contract must be sufficient to implement the adapter correctly. For
example, duplicate-submission semantics can be public even when the invariant
expression and test sequences checking them remain private.

In current Mirrors examples, an `invariant` can be a deliberately violated
trace-generation objective such as `TraceComplete`. Hiding only that operator
name would not hide the transition relation, trace contents, or expected states.
The evaluator must control the complete oracle and its run configuration.

## Three environments

The primary workflow uses a user-started coordinating agent that supplies the
public brief directly to Gate. Gate starts the separate restricted implementer;
an external integration later supplies its implementation proxy to MirrorECMA. Isolation must continue when submitted code executes
after authoring; an agent's tool restrictions do not confine later host-side
build scripts or imports of its adapter.

| Stage | Executed code | Permitted working data |
| --- | --- | --- |
| Authoring | Agent development commands | Public requirements/tools and writable source |
| Build | Submission build scripts, dependency hooks, compiler plugins | Frozen source, approved dependencies/toolchain, writable output |
| Execution | SUT/adapter initialization and runtime operations | Frozen artifact, public port inputs, writable SUT state |

These are permission profiles and temporary process environments, not three
permanent machines. A submission needing no compilation can use minimal
preparation while retaining frozen artifacts and restricted runtime loading.

### Authoring

Give the implementation agent only the public interface, requirements, SUT, and
adapter workspace. Private material must be absent from or inaccessible to its
tools. Another directory or repository is insufficient when the agent can read
it through the same account or tool permissions. Previously disclosed material
cannot become an unseen test merely by moving it.

The implemented [MirrorGate agent host](../agent-hosting-control-v2.md) owns fresh
implementer launch/configuration, approved-context delivery, tool mediation,
and cleanup. Its runtime audit and actual authoring checks are recorded in
[final validation](../managed-workflow-validation.md). The evaluator
continues to approve public tasks and materials; Gate cannot determine that
arbitrary caller-supplied text is safe to disclose. Native tools, implicit
context loading, memory, connectors, hooks, and delegation must be disabled or
restricted and tested through actual runtime dispatch. Model credentials stay
on the trusted hosting path, outside author tools and submission mounts.

Submission must revoke authoring and quiesce managed writers before freezing.
Resume and follow-up messages require a separate context/disclosure contract;
the implemented managed hosting profile supports fresh runs only. Human authors
and external hosts may still use the gateway without claiming that Gate launched
or configured their controller.

### Building

Treat submission build hooks, dependency installation scripts, compiler plugins,
and adapter initialization code as submission-controlled execution. Build them
in an environment without evaluator credentials or private specifications.
Record the resulting artifact and dependency identities. A build hook can read
private host files if it runs with evaluator privileges, even when authoring
was restricted. Avoid importing the submission into the trusted evaluator just
to discover its interface.

### Execution

Launch the adapter and SUT in a restricted worker after evaluation admission.
Importing the adapter into the trusted MBT process could execute its initialization
with access to the oracle. Keep only the trusted generated binding and public-port
proxy in that process; the worker runs the submitted implementation and returns
actual observations.
Expose the approved submission/runtime, public interface artifacts, a private
writable SUT area, and the port channel. Private evaluator files and memory,
credentials, container-management sockets, and unrestricted host/process access
must not be exposed. Network access should be denied unless the chosen SUT
profile explicitly permits particular test services.

The supervisor selects the policy and bounds CPU, memory, process count, message
size, output, and wall-clock duration. It must be able to terminate the complete
worker and clean up owned resources when cooperative cancellation fails.
External test services need explicit lifecycle ownership too; terminating a
process does not undo a remote side effect.

A restricted container is an alternative backend. Docker's isolation depends
on namespaces, capabilities, mounts, and configuration; rootless mode reduces
host-root exposure but is not a complete guarantee by itself. A VM or separate
evaluation host is another option depending on the required trust boundary.
The initial implementation selects Linux/Bubblewrap; no Docker or VM backend
has been implemented. See
[Docker security](https://docs.docker.com/engine/security/) and
[rootless mode](https://docs.docker.com/engine/security/rootless/).

A plain child process can retain its parent's user permissions. Node's `vm`
module is explicitly not a security mechanism for untrusted code; it is not an
isolation backend for this design.
[Node documentation](https://nodejs.org/api/vm.html)

## Evaluation and disclosure

Freeze the submitted adapter/SUT artifact before the private evaluation. Record
the public interface identity separately from the private model revision, run
profile, trace/seed identities, runtime image, and policy version. Keep the full
record available to the trusted evaluator for reproduction.

Public development tests may return rich diagnostics. A private evaluation
needs a deliberate result-disclosure policy: repeatedly returning expected
states and counterexamples exposes the hidden oracle. Detailed MirrorECMA
reports should remain on the trusted side until disclosure is intended.

## Source-code suites and service access

MBT test modules may be versioned beside implementation source. The evaluator
must still select an approved immutable suite revision independently of the
submission. Keep private models/tests out of authoring/build/worker mounts,
and never import a submission-controlled test replacement with evaluator
privileges. Public author-written tests are development evidence, not the
authoritative private evaluation suite.

A service may expose start/query/cancel for that suite while retaining its code
and private data on the evaluator. Service results obey the same disclosure
policy as local evaluation. An implementation reference is not a raw Gate
session handle, and access to a service run must not grant access to other
callers' runs. See [evaluation-service design](../evaluation-service-design.md).

## Observation fidelity is a separate requirement

The observer must read an abstraction of the real implementation state. Reading
an actual queue's length is a valid abstraction. Updating a separate shadow
queue from requested actions and reporting it can conceal a broken SUT.

Neither sandboxing nor hiding the invariant forces an adapter to be truthful.
Use narrow, auditable mappings, application-owned observers where practical,
and tests that deliberately break the real implementation and require rejection.
Such tests supply evidence of fault detection rather than a universal proof of
the mapping's honesty.

## Acceptance evidence

Test the configured backend by attempting prohibited file reads, process
inspection, credential access, network connections, and sandbox-management
access from both build and runtime submissions. Verify denial and cleanup.
Test malformed/oversized worker messages and workers that hang, fork, crash,
ignore cancellation, or flood output. Record which operating systems and
backend configurations were actually exercised.

Related: [architecture](../architecture.md) and [implementation plan](../implementation-plan.md).
