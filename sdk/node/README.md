# MirrorGate Node control SDK

This page documents control-v1, opt-in hosting control-v2, and worker-v1.
`ControlClient.launch()` starts the Gate controller, not a coding agent.
On a v2 connection, `ControlSession.startAgent()` requests a separately managed
implementer through the controller. The [hosting wire contract](../../docs/agent-hosting-control-v2.md)
fixes admission, submission, progress and cleanup behavior. Runtime audit and
backend availability remain mandatory; an SDK operation alone is not evidence
that a particular agent profile passed its runtime/isolation gates. The optional
[evaluation-service design](../../docs/evaluation-service-design.md) remains a
separate API and is not added to control v1 or worker v1.

In the revised architecture, a coordinator's Gate tool or a separate trusted
evaluation integration uses this SDK. MirrorECMA core receives a generic
implementation factory/binding; it does not own Gate setup. The integration
retains its owner connection and authorizes/acquires an evaluation worker only
inside the factory after the required model match. See the
[integration migration](../../integrations/mirrorecma/README.md).

The private package exposes three explicit ESM entry points:

```js
import {ControlClient} from 'mirrorgate/control';
import {WorkerClient, createManagedWorker} from 'mirrorgate/worker';
import {createHostingTool} from 'mirrorgate/hosting-tool';
```

`ControlClient.launch()` owns a local control process connected over stdio.
`ControlClient.connectUnix()` attaches to a filesystem Unix socket after checking
that the socket and its private directory are owned by the current UID, have
modes `0600` and `0700`, and have no symlink path components. Closing an attached
client closes that connection only; it does not stop the daemon.

```js
const control = await ControlClient.launch({
  controller: {
    command: '/opt/mirrorgate/bin/mirrorgate',
    args: ['control', '--stdio', '--policy-file', '/etc/mirrorgate/policy.json'],
  },
  requiredCapabilities: [
    'control.local-stdio-v1',
    'submission.prebuilt-v1',
    'worker.managed-unix-v1',
    'worker.node-v1',
  ],
});

const session = await control.openSession({
  policyId: 'default',
  submission: {
    kind: 'prebuilt',
    input: {rootId: 'submissions', relativePath: 'counter'},
  },
  runtime: 'node-v1',
  manifestJson, // the exact approved mirrorgate.port/v1 JSON document
});

const preparation = await (await session.prepare()).wait();
if (preparation.status !== 'succeeded') throw preparation.error;

const authorization = await session.authorize({
  preparedRevision: preparation.result.preparedRevision,
  challenge: preparation.result.challenge,
  attestation: requiredMatchAttestation,
});
const reservation = await session.acquireWorker(authorization);
const worker = await reservation.connect();
```

The managed worker performs the private attachment prefix and the unchanged
worker-v1 `hello`/`create` handshake before it is returned. On close, it asks
Gate to arm `worker.release`. It sends one cooperative worker `dispose` only
when Gate replies with `dispose-then-terminate`; Gate owns every process signal
and forced-stop deadline. Cancellation of a pending callback immediately asks
Gate to cancel the session and uses `terminate-only`, so disposal cannot race a
callback that may still be running.

Long control mutations return `OperationHandle` objects. `wait()` first checks
the retained `operation.status`, then consumes the correlated terminal event.
The SDK never retries a mutation after a timeout or lost response. A malformed
frame, event-sequence gap, unsolicited response, or control EOF poisons the
connection and makes cleanup confirmation unavailable to that client.

## Managed hosting over control v2

V1 remains the default. Set `controlVersion: 2` explicitly with `launch`,
`connectUnix`, or `fromTransport`. The SDK sends the unchanged v1 hello envelope
offering only `[2]` and automatically requires `hosting.fresh-agent-v1`; it never
silently downgrades. After selection, control frames use v2. Worker attachment
and `releaseMode: "control-v1"` remain unchanged.

```js
const control = await ControlClient.connectUnix({
  controlVersion: 2,
  socketPath: '/run/user/1000/gate/control.sock',
  requiredCapabilities: ['backend.linux-bubblewrap-v1', 'worker.node-v1'],
});
const session = await control.openSession(approvedSourceSession);
const run = await session.startAgent({
  profileId: 'restricted-codex',
  publicTask: {instructions: approvedInstructions, files: approvedPublicFiles},
});
const terminal = await run.wait();
if (terminal.outcome !== 'submitted' || terminal.cleanup.status !== 'succeeded') {
  throw new Error('No clean committed submission is available');
}
// Retain this same control/session for trusted preparation and evaluation.
```

The `approved*` values above are trusted application inputs. `approvedSourceSession`
uses a source submission with `authoring: true`, an approved build-plan/profile,
and exact public-manifest JSON. Public task files are immutable author context;
they do not supply arbitrary host paths or overwrite the submitted source tree.

`startAgent` returns an owner-bound `HostedAgentRun` with `id`, `status()`,
`wait()` and `cancel()`. `session.agentStatus()` inspects the accepted run without
needing its ID, allowing recovery after a reply was lost above the SDK. A timed-out
control request poisons its connection; do not replay an uncertain start or
reconstruct handles on another connection. Synchronous controller admission
rejection does not consume the session's one accepted-run slot.
`wait({signal, timeoutMs})` cancellation/deadline stops only that local waiter;
it does not send `agent.cancel` or close the owner. Any in-flight readonly poll
keeps its normal control-request bound and its eventual result is still checked.

`run.cancel()` joins hosting cleanup and returns a terminal run record, not an
ordinary `OperationHandle`. Its acknowledgement budget is at least seven seconds
and respects the controller's advertised cleanup/acknowledgement bounds. A
committed submission keeps its identity after cancellation. `session.prepare()`
still returns an `OperationHandle`; preparation consumes that exact frozen source
only after hosting cleanup is confirmed. Source hashes, submission IDs, artifact
IDs and semantic model digests remain separate identities.

Hosted snapshots and progress are bounded and frozen. Events must refer to the
same session/run, retain immutable committed identity and follow connection
sequence ordering. Status has the authoritative terminal outcome even when a
rolling progress window was truncated. Hosting cleanup and later session/build/
worker cleanup are separate results; a submitted outcome cannot hide failed cleanup.

An owned v2 controller gets stdin EOF before forced termination so it can revoke
hosted resources. Nonzero or signal exits are reported as unconfirmed cleanup.
An attached client's close affects only its connection and never kills the
shared daemon. Trusted native callers must retain and eventually close their
session/owner; the standard hosting-tool adapter supplies that lifecycle.

## Coordinating-agent tool and trusted callback

The installed `mirrorgate-hosting-tool --config /absolute/hosting.json` command
exposes `hosting_start`, `hosting_status`, and `hosting_cancel` over stdio MCP.
It accepts approved task references and safe caller-scoped run references. It
does not expose arbitrary prompts, executable/credential overrides, administrative
handles, raw controller diagnostics or private evaluator results. The implementer's
contract/exec/submit tools come from the controller's authoring broker.

`createHostingTool({connect, tasks, onSubmitted?})` offers the same handlers for
trusted in-process composition. `connect` creates one dedicated owner per task;
`onSubmitted` receives that original client/session after explicit submission
and confirmed hosting cleanup. Gate's trusted evaluation integration uses this
callback without moving model semantics into the hosting tool. The explicit
`completeCleanup` receipt hook prevents duplicate cleanup after the integration
has already released the worker/session and closed its dedicated owner. The
callback and its result remain private, outside the MCP tool schema.

See the [installed configuration, ownership and dispatch contract](../../integrations/agent-host/README.md).
The Node v2 integration tests exercise real controller/Bubblewrap source freezing,
build, worker execution and cleanup using a clearly marked synthetic author.
Actual agent-runtime capability/audit certification and full managed MBT acceptance
remain separate gates; the SDK tests do not substitute for them.
