# Blind validation and isolation

Status: design requirements; no isolation guarantee is implemented yet.

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

### Authoring

Give the implementation agent only the public interface, requirements, SUT, and
adapter workspace. Private material must be absent from or inaccessible to its
tools. Another directory or repository is insufficient when the agent can read
it through the same account or tool permissions. Previously disclosed material
cannot become an unseen test merely by moving it.

### Building

Treat submission build hooks, dependency installation scripts, compiler plugins,
and adapter initialization code as submission-controlled execution. Build them
in an environment without evaluator credentials or private specifications.
Record the resulting artifact and dependency identities. Avoid importing the
submission into the trusted evaluator just to discover its interface.

### Execution

Launch the adapter and SUT in a restricted worker after evaluation admission.
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

A restricted container is a candidate first backend. Docker's isolation depends
on namespaces, capabilities, mounts, and configuration; rootless mode reduces
host-root exposure but is not a complete guarantee by itself. A VM or separate
evaluation host is another option depending on the required trust boundary.
Backend choice remains open. See
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

Related: [architecture](architecture.md) and [implementation plan](implementation-plan.md).
