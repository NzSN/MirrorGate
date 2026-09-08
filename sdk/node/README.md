# MirrorGate Node control SDK

The private package exposes two explicit ESM entry points:

```js
import {ControlClient} from 'mirrorgate/control';
import {WorkerClient, createManagedWorker} from 'mirrorgate/worker';
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
