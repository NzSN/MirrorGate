# Optional MBT evaluation service and proxy

Status: local HTTP v1 implementation, 2026-09-09; real transport and adversarial
service tests are separate from complete Gate-backed consumer acceptance. This service wraps a reusable
trusted MBT harness and is distinct from both Gate's hosting tool and its worker
proxy. It does not extend frozen control v1, worker v1, or the Mirrors model
protocol. The [local service contract](evaluation-service-contract-v1.md) freezes
loopback HTTP, configured caller authentication, closed records and bounded
retention. Remote HTTP/TLS deployment is not implemented.

## Purpose and ownership

An application may keep its MBT suite in source control and invoke the same suite
from a test file, CLI, or proxy-accessible evaluator. The service wrapper lives in
MirrorGate-owned trusted evaluation integration, under
`integrations/mirrorecma/service/`. Gate also owns the supported local evaluation
workflow beneath it; only deploying this service transport is optional.
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
[MirrorECMA harness design](https://github.com/NzSN/MirrorECMA/blob/main/docs/mbt-harness-design.md) for an
illustrative layout and the existing generic negotiated factory seam.

A suite may live beside implementation source in a repository. The trusted
evaluator still selects a fixed approved suite revision and keeps private
models/traces outside authoring/build/worker mounts. Never load a submission's
replacement evaluator module with trusted privileges. Public development tests
can be supplied to the author, but their successful execution does not certify
the private evaluator or the implementation's model conformance.

## Service request and run semantics

The supplied service proxy exposes:

| Operation | Meaning |
| --- | --- |
| `start({startKey, suiteRef, implementationRef})` | Resolve authorized immutable suite/implementation identities and accept a bounded evaluation run |
| `get({runId})` or `get({startKey})` | Return approved progress or a retained terminal outcome for that caller's run |
| `cancel(runId)` | Request cancellation; report terminal cleanup only once actually settled |

The [versioned contract](evaluation-service-contract-v1.md) specifies these
operations, transport, closed schemas, numeric bounds, authentication, caller
ownership, duplicate-start keys, failure codes, retention, and disconnect policy.
The start key is retained before sending; a lost reply is recovered against the
same service epoch. Expired keys remain tombstones and cannot launch another run.

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
2. Gate's trusted evaluation integration supplies a deferred implementation factory to the
   suite's ordinary MirrorECMA runner, connected to the existing Mirrors server.
3. Only after the required model match does that factory authorize/acquire the
   Gate worker and construct the trusted generated binding over its proxy.
4. MirrorECMA executes the same suite semantics as the local entry point. The
   service stores bounded progress and projects permitted model results.
5. Gate's trusted evaluation integration disposes/releases resources through the supervisor, including
   failures before factory invocation. Final evidence separates the primary
   model failure from cleanup failure or unconfirmed cleanup.

The service/integration retains Gate's owner connection while resources are
live. A remote service client never receives that connection or its handles.
An implementation reference may resolve to a session already owned by the
trusted integration, or to an approved immutable artifact imported through a
specified preparation path. It must not adopt another connection's live session
merely because a caller supplies its ID. Cross-process lease handoff beyond the
existing contract requires explicit versioned work.

The current service exposes loopback evaluation while using local Gate control
and a separate Mirrors model connection internally. Future remote deployment
requires a separately specified authenticated transport profile. It does not make Gate control v1
remote, change worker RPC, or require MirrorECMA to implement a network server.
The implementer receives only public port inputs/results; private model-facing
bindings, full negotiation authority, and diagnostic reports remain trusted.

The service must call the same [Gate-owned local workflow](managed-workflow-design.md)
and use its receipt/disclosure projection. It adds transport, authorized run
references and retention, not another MBT or cleanup implementation. Source tests
and local evaluation remain available without deploying the service.

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
Production deployment and publication are not claimed here. Service transport
tests do not replace Gate isolation or model-checking evidence.

## Local validation evidence

The local v1 implementation has 67 focused codec/HTTP tests, including duplicate
JSON keys, unsafe inputs, caller isolation, lost-start recovery, tombstones,
capacity/rate limits, cancellation, disconnect retention, unconfirmed cleanup,
shutdown and a real incomplete-body timeout. Draft 2020-12 validation checks the
shared positive corpus; the public TypeScript consumer checks declarations.

The optional `--service` mode of
`integrations/mirrorecma/scripts/installed-workflow.mjs` validates installed package
exports and the HTTP proxy against the same compiled Counter suite used by source
tests. With real Gate workers and Mirrors, correct local/service implementations
both pass (one trace, two accepted steps), faulty implementations both mismatch,
and R3 reports confirmed cleanup. The setup's author is explicitly synthetic;
this service gate does not claim a fresh actual Codex authoring audit. It uses
approved prebuilt implementations and adds no application lifecycle helper.

Commands, from `integrations/mirrorecma`, with the repository's pinned toolchain
and prepared Mirrors/Apalache environment:

```bash
NODE_OPTIONS=--experimental-vm-modules ./node_modules/.bin/jest --runInBand \
  --runTestsByPath test/service.test.ts test/service-schema.test.ts
python3 service/check-schema.py
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module Node16 \
  --moduleResolution Node16 --types node test/service-consumer.mts
node scripts/installed-workflow.mjs --service
```

Real HTTP and Bubblewrap checks require loopback and namespace access. A failure
of an outer sandbox to permit those operations is not a successful service gate.
