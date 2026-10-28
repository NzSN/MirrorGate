# Optional local evaluation service

This transport exposes installed R3 evaluation callbacks on authenticated
loopback HTTP. It adds no MBT or Gate resource state machine. Use the same suite
and `evaluateImplementation` plan as an ordinary source test or CLI.

```js
import {evaluateImplementation} from 'mirrorgate-mirrorecma';
import {startEvaluationService} from 'mirrorgate-mirrorecma/service';
import {connectEvaluationService, newEvaluationStartKey}
  from 'mirrorgate-mirrorecma/service/proxy';

const service = await startEvaluationService({
  callers: [{
    id: 'ci', token: operatorToken, // 32 random bytes, encoded as lowercase hex
    bindings: [{
      suiteRef: 'Counter.v1', implementationRef: 'candidate.v1',
      evaluate: ({signal}) => evaluateImplementation(approvedPlan, {signal}),
    }],
  }],
});
const proxy = await connectEvaluationService({origin: service.origin, token: operatorToken});
const start = {
  startKey: newEvaluationStartKey(), // retain this before the request
  suiteRef: 'Counter.v1', implementationRef: 'candidate.v1',
};
try {
  const accepted = await proxy.start(start);
  const result = await proxy.wait(accepted.runId);
  // result.result is R3's fixed public projection; its cleanup is separate.
  console.log(result);
} finally {
  const shutdown = await service.close();
  // Check shutdown.cleanup; unconfirmed callbacks are never silently declared clean.
}
```

If the start reply is lost, use `proxy.get({startKey: start.startKey})` or repeat
that exact start key and references. The proxy never retries automatically.
`cancel(runId)` requests cancellation; poll until `finished` or `unconfirmed`.
Disconnecting or aborting a client HTTP request leaves the bounded evaluation
owned by the service. An explicit service restart changes the epoch; an old
proxy must not silently create replacement evaluations.

Callers configure immutable approved plans and tokens. Requests cannot provide
harness code, host paths, URLs, credentials or Gate session handles. Tokens must
not be supplied to the restricted implementer. The endpoint supports only literal
`127.0.0.1` or `::1`; no remote/TLS deployment is implemented.

`contract.json` and `schema.json` specify records and bounds. The normative
contract is `docs/evaluation-service-contract-v1.md` in the MirrorGate source.
Full private receipts remain in the registered trusted callback. Only its
validated `publicResult` is returned. Callback rejection or nonsettlement produces
an explicit unconfirmed workflow failure rather than an invented cleanup receipt.

For a private finite evaluation, select `requirePersistentBudget: true` and add
an operator-owned `attemptBudget` to each binding:

```js
attemptBudget: {
  directory: '/operator/private/alice-counter-corpus', // existing, mode 0700
  authorRef: 'ci', // must equal this caller's id
  corpusDigest: approvedPrivateCorpusSha256,
  maxAttempts: 1,
},
disclosure: {}, // no optional counts, identities or failure stages
```

Reuse the directory across restarts, token rotation and implementations for the
same author/corpus. Spent markers are synchronized before callback execution and
remain spent on failure or cancellation; concurrent services share the ceiling.
The operator must not delete/replace the directory to bypass that decision.
See the source contract's persistent-attempt section for crash, filesystem and
legacy-compatibility limits. This policy does not supply OS aggregate quotas or
prove Gate physical cleanup.
