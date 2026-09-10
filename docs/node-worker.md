# Node worker and trusted port proxy

Status: first implementation. Node 24 ESM, no external runtime dependencies.
The shared [worker protocol](worker-protocol.md) owns the wire contract.

The evaluator provides a validated public manifest and approved supervisor
command. `WorkerClient.launch({supervisor: {command, args}, manifest,
runtime: 'node-v1'})` launches that supervisor and performs hello/create. No
adapter-controlled command, private model, expected state, or MirrorECMA
configuration belongs in these arguments. The explicit
`WorkerClient.fromIsolatedTransport(transport, options)` entry point delegates
isolation to the trusted caller; ordinary subprocess tests do not prove it.

An adapter module exports `createAdapter()` returning `{actions, observe,
dispose?}`. `actions` maps declared stable initializer/action IDs to functions
`(inputs, {signal})`; `observe({signal})` returns all stable observation IDs.
The worker validates the manifest before importing the adapter, and imports
and constructs only after successful hello and a create request. It decodes
inputs, awaits callbacks, validates actual observations, and disposes at most
once. After any failure or cancellation it admits only disposal. Every
initializer/action must be followed by observation before another operation.
Initializer/action callbacks must return `undefined`, either directly or after
awaiting their promise/thenable. Other results, including `null`, are application
failures and poison the worker before observation.
When its event loop processes cancellation, the worker ends the public operation
and signals the callback; late results cannot reopen it or trigger observation.
Synchronous CPU-bound JavaScript can block that event loop and prevent
cooperative cancellation from being processed. SDK deadlines and supervisor
forced termination provide the termination guarantee in that case.

Native values are bigint, boolean, string, null, Array (sequence/tuple), Set,
Map with string keys, ordinary records, and `{tag, value}` variants. The public
manifest disambiguates native arrays. Stable IDs are exact and no model wire
aliases are accepted. Collections reject semantic duplicates; integers never
pass through floating point. Opaque ITF values are unsupported by this profile.

`createPortProxy(client)` exposes `invoke(id, inputs, options)`,
`observe(options)`, and `dispose()`. A trusted generated async-port wrapper maps
its native method names to these calls. The proxy sends only current public
operation inputs. It does not send replay positions, private configuration,
previous model state, or comparison diagnostics.

The SDK validates every response, correlation ID, state transition, and value.
It accepts no unsolicited replies, applies deadlines and cancellation, and
terminates an unresponsive transport after a bounded grace period. No mutation
is automatically retried. The worker redirects `console` logging to stderr;
raw stdout is reserved for JSONL and invalid writes terminate the trusted
client. The supervisor independently bounds process stderr and wall time.

Acceptance checks include shared value/message vectors, honest and faulty
Counter observations, reset, admission before import, exact inputs/outputs,
async cancellation and late results, duplicate fields, invalid UTF-8, output
limits, wrong response IDs, EOF, and at-most-once disposal. Run
`node --test tests/node/*.test.mjs` from the repository root. These unit tests
use subprocesses and fake transports and do not establish filesystem or
network isolation; backend access-denial tests belong to the supervisor suite.

## Evaluator API and cleanup ownership

The minimal trusted call sequence is:

```js
import {WorkerClient, createPortProxy} from '../sdk/node/index.mjs';

const client = await WorkerClient.launch({
  supervisor: approvedSupervisor, // evaluator-owned command/args/cwd/env
  manifest: publicManifest,
  runtime: 'node-v1', // 'rust-v1' uses the same client and public value contract
});
const port = createPortProxy(client);
try {
  await port.invoke('Initialize', {});
  await port.observe();
  await port.invoke('Tick', {Stride: 2n});
  const actual = await port.observe(); // {Count: 2n} for the correct Counter
  // Private comparison stays here in the evaluator.
} finally {
  await port.dispose();
}
```

`supervisor` is trusted configuration, not a submission field. Bundle the
public worker shim, `sdk/node` codecs, adapter, manifest, and required application
files into the frozen artifact. Mount that public artifact through the
[supervisor](sandbox/linux-bubblewrap.md); do not mount an evaluator checkout containing
private data merely to make an import path convenient.

`invoke` and `observe` accept `{signal, timeoutMs}`. Default operation timeout is
10 seconds; cancellation grace is 250 milliseconds. Launch also accepts
`cleanupTimeoutMs` (3 seconds), `terminationGraceMs` (1 second), `stderrLimit`
(65,536 bytes total), and an evaluator-owned `onStderr` callback. All launch
options and a frozen manifest snapshot are validated before process creation.
A cancelled or timed-out action is never retried and permits no later
observation. Pending disposal is terminated at its deadline without sending a
wire cancellation. Cancellation acknowledges a terminal protocol outcome;
disposal waits for callback quiescence before touching its resources.

Externally isolated transports must provide `readable`, `writable`,
`terminate()`, and `closed: Promise`; optional `onClose(callback)` reports early
process failure. `closed` must settle only after backend-owned cleanup has
finished. `close()` / `dispose()` send remote disposal at most once, await
bounded supervisor termination, and preserve an earlier application failure
when cleanup also fails. Callers supplying an external transport own its actual
isolation and process-tree termination guarantees.

The protocol corpus is consumed directly by `tests/node/protocol.test.mjs` and
the shared lifecycle scenarios by `tests/node/lifecycle.test.mjs`. These tests
also check typed equality for marker-looking record fields, so a record named
`#set` is never mistaken for an ITF set. Sandbox-enforced tests and the trusted
Mirrors integration are separate gates; a passing Counter alone establishes
neither oracle secrecy nor observation fidelity for arbitrary adapters.
