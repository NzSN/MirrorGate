# Optional MBT evaluation service and proxy

Status: accepted design, 2026-09-09; not implemented. This service wraps a reusable
trusted MBT harness and is distinct from both Gate's hosting tool and its worker
proxy. It does not extend frozen control v1, worker v1, or the Mirrors model
protocol. No service endpoint, transport, or wire version is advertised yet.

## Purpose and ownership

An application may keep its MBT suite in source control and invoke the same suite
from a test file, CLI, or proxy-accessible evaluator. The service wrapper lives in
the optional trusted integration, proposed under `integrations/mirrorecma/service/`.
MirrorECMA continues to test supplied implementations through generic factories
and bindings. Application suites and private evaluation/disclosure policy stay
with the trusted evaluator. Gate's core owns isolation and resource lifecycle.

| Interface | Role |
| --- | --- |
| Gate hosting tool / SDK | Coordinator requests a restricted implementer and receives submission/hosting outcomes |
| Implementation proxy | Generated binding invokes public operations on the actual SUT/adapter |
| Evaluation-service proxy | Agent, CI, application, or test wrapper requests an MBT run and obtains allowed progress/results |

Hosting completion is not an evaluation result. The service may evaluate an
existing approved implementation without launching an author. A hosting run ID
cannot silently substitute for an implementation reference, evaluation run ID,
Gate session, or worker handle.

## Shared harness and source placement

Use one reusable suite module for source-code tests and service handlers; the
entry points select an implementation provider and call that module. See the
[MirrorECMA harness design](../../MirrorECMA/docs/mbt-harness-design.md) for an
illustrative layout and the existing generic negotiated factory seam.

A suite may live beside implementation source in a repository. The trusted
evaluator still selects a fixed approved suite revision and keeps private
models/traces outside authoring/build/worker mounts. Never load a submission's
replacement evaluator module with trusted privileges. Public development tests
can be supplied to the author, but their successful execution does not certify
the private evaluator or the implementation's model conformance.

## Service request and run semantics

The proposed logical interface is:

| Operation | Meaning |
| --- | --- |
| `startEvaluation(suiteId, implementationRef)` | Resolve authorized immutable suite/implementation identities and accept a bounded evaluation run |
| `getEvaluation(runId)` | Return approved progress or a retained terminal outcome for that caller's run |
| `cancelEvaluation(runId)` | Request cancellation; report terminal cleanup only once actually settled |

These are design labels, not existing tool or wire names. AH12 must specify the
transport, versioned closed schemas, numeric bounds, admission/authentication,
caller-scoped references, correlation, duplicate-start handling, failure codes,
run retention, and disconnect policy before service code is implemented.

Requests select approved suites and implementation references; they do not carry
arbitrary executable harness code, host file paths, untrusted remote endpoints,
model credentials, expected states, or administrative control handles. The service
records the resolved suite revision, generated interface identity, implementation
artifact identity, and replay configuration in trusted evidence. Expose only
the subset permitted by the fixed disclosure policy.

For a lost start reply, provide an explicit correlation/query or deduplication
contract. Do not blindly retry and create a second run. Cancelling a request,
losing a network client, finishing model replay, and confirming Gate cleanup
are distinct events. Define whether client disconnect cancels or leaves the
service-owned run queryable, with a bounded lifetime either way; this does not
create durable restart/reconnect support in the Gate controller.

## Execution and control ownership

1. The service resolves the approved suite and implementation and creates its
   evaluation context with a deadline and disclosure policy.
2. The external integration supplies a deferred implementation factory to the
   suite's ordinary MirrorECMA runner, connected to the existing Mirrors server.
3. Only after the required model match does that factory authorize/acquire the
   Gate worker and construct the trusted generated binding over its proxy.
4. MirrorECMA executes the same suite semantics as the local entry point. The
   service stores bounded progress and projects permitted model results.
5. The external integration disposes/releases resources through Gate, including
   failures before factory invocation. Final evidence separates the primary
   model failure from cleanup failure or unconfirmed cleanup.

The service/integration retains Gate's owner connection while resources are
live. A remote service client never receives that connection or its handles.
An implementation reference may resolve to a session already owned by the
trusted integration, or to an approved immutable artifact imported through a
specified preparation path. It must not adopt another connection's live session
merely because a caller supplies its ID. Cross-process lease handoff beyond the
existing contract requires explicit versioned work.

The service can expose remote evaluation while using local Gate control and a
separate Mirrors model connection internally. It does not make Gate control v1
remote, change worker RPC, or require MirrorECMA to implement a network server.
The implementer receives only public port inputs/results; private model-facing
bindings, full negotiation authority, and diagnostic reports remain trusted.

## Acceptance and delivery

AH12 is a separate optional delivery task. Existing source tests and generic
MBT replay must work without deploying the service. Before claiming service
support, verify:

- Local test/CLI and service entry points call the same approved suite and agree
  on semantic results for fixed model/replay/implementation identities.
- A real proxy client starts, inspects, and cancels evaluations, including local
  and Gate-backed implementations; MirrorECMA has no service/Gate-specific API.
- Cross-caller references, unapproved suites, forged implementation references,
  arbitrary paths/code, excessive frames/output, lost replies, and duplicate
  starts follow the versioned admission and bounds contract.
- Suite revision and evaluator integrity are independent of submitted source;
  private files/diagnostics never enter author context or public results.
- Required-match failures cause zero evaluation-worker launches; timeout,
  disconnect, cancellation, and partial construction preserve resource ownership
  and produce accurate cleanup outcomes without leaked owned resources on success.
- Test service transport/retention behavior separately from Gate's actual
  authoring/build/execution isolation and from hosted CI/publication claims.

The [hosting task ledger](agent-hosting-tasks.md) tracks prerequisites and evidence.
No evaluation-service acceptance or production deployment is claimed here.
