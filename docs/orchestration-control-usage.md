# Using orchestration control v1

The experimental local controller owns preparation, authorization, worker
reservation, and cleanup. Node and C++ clients speak the same
[control contract](https://github.com/NzSN/MirrorGate/blob/main/protocol/control-v1/README.md).
The worker stream retains the existing
[worker v1 contract](https://github.com/NzSN/MirrorGate/blob/main/docs/protocol-v1.md).
The [task ledger](https://github.com/NzSN/MirrorGate/blob/main/docs/orchestration-control-v1-tasks.md)
records implementation and gate evidence. The model-facing MirrorECMA and
MirrorCPP orchestration facades remain separate follow-on work.

## Start the shared process

This guide covers the implemented controller. Agent launch/configuration is
currently supplied by external hosts; `authoring.exec` runs restricted commands
and does not start an AI implementer. The [agent-hosting design](agent-hosting-design.md)
assigns that future responsibility to MirrorGate through a versioned control
extension. No agent-launch or resume command is available in control v1.

That planned extension also backs a MirrorGate-supplied
[hosting-tool adapter](agent-hosting-design.md#standard-hosting-tool-adapter)
for outside agents. Applications will configure/register the adapter; it will
retain the owning connection across tool calls and expose only approved task
and run operations. The adapter is not an existing control-v1/MCP entry point.

In the primary planned workflow, the coordinator supplies the approved brief
directly to Gate's hosting tool/SDK. A separate trusted evaluation integration
retains the Gate owner connection and supplies a generic implementation proxy
to MirrorECMA, which does not start/attach Gate in the revised target. The existing
Mirrors server uses a separate model transport. See the
[implementation boundary](../../MirrorECMA/docs/implementation-boundary-design.md).

Run the approved installation as an owned stdio process:

```bash
bin/mirrorgate control --stdio --policy-file /approved/control-policy.json
```

For a shared daemon, first create an owned directory with mode `0700`, then
select an absolute filesystem socket inside it:

```bash
install -d -m 0700 /approved/control
bin/mirrorgate control --unix-socket /approved/control/gate.sock \
  --policy-file /approved/control-policy.json
```

The socket has mode `0600`. Attached clients verify its path and ownership;
Gate verifies the peer UID. Each connection still owns distinct session and
operation handles. Closing one connection cleans only its sessions. The daemon
has no public shutdown operation. A Node SDK installation or C++ library alone
does not install this Python controller or its approved runtime trees.

## Fix the operator policy

The catalog schema is `mirrorgate.control-policy/v1`. It selects approved input
roots, authoring tools, build plans, runtime commands and mounts, and maximum
limits. See the concrete
[policy example](https://github.com/NzSN/MirrorGate/blob/main/tests/fixtures/control-policy-v1.example.json)
and the
[policy implementation](https://github.com/NzSN/MirrorGate/blob/main/supervisor/mirrorgate/control_policy.py).
The [policy guide](https://github.com/NzSN/MirrorGate/blob/main/docs/control-policy-v1.md)
describes each catalog entry and its ownership rules.
Replace the example's deployment paths and runtime choices with reviewed public
trees before using it. The host stops external writers before submission.

The trusted evaluator supplies an input reference and catalog IDs. An authoring
tool wrapper fixes the session and exposes only its approved tool operation.
Neither interface lets submitted code extend mounts, select a host shell,
inherit controller descriptors, or loosen limits. Authoring and build commands
execute in the same actual isolation backend as execution, with their own
writable workspace or output directory.

For repository tests, `tests/control_policy_fixture.py` generates a runnable
catalog using the selected public Node runtime tree:

```bash
export MIRRORGATE_NODE_RUNTIME_ROOT=/approved/node-v24.15.0-linux-x64
python3 tests/control_policy_fixture.py /tmp/control-policy.json /approved/submissions
```

The trusted Node shim is copied as a minimal read-only tree containing the
worker and its protocol implementation. Its public manifest is a separate
frozen lease. The submitted adapter lives in the artifact tree.

## Drive one evaluation

1. Connect and complete `hello`, requiring the capabilities used by this
   evaluation. Inspect their enforced scopes and limits.
2. Open a session with the exact public manifest text. Keep the private model
   and replay configuration in the evaluator. Optional authoring operations
   may run before preparation. A normal nonzero tool exit is a command result
   so editing and testing can continue.
3. Prepare once and wait for its terminal operation result. Gate freezes source,
   runs the selected build when needed, and freezes the final artifact. Build
   failure closes the sealed session; a new attempt needs a new session.
4. Complete compiled `verify/require` negotiation in the trusted model driver.
   Only a validated `matched` result permits creating the attestation containing
   the exact semantic digest and adapter/profile/contract identities. Pass the
   prepared revision and fresh challenge to `session.authorize`.
5. Acquire the worker reservation and attach using its one-use token. Acquisition
   alone starts no submitted executable. The native proxy performs worker
   `hello` and `create` before exposing the public port.
6. Invoke declared operations and observe actual values through that port.
   The evaluator owns projection, expected values, and the conformance verdict.
7. Release the worker and wait for shared cleanup. Gate first blocks ordinary
   requests. If its reply permits `dispose-then-terminate`, the native proxy may
   send one cooperative disposal using its own request-ID sequence. Gate owns
   deadlines and process signals. Pending or cancelled calls use termination;
   a cancellation acknowledgement does not establish quiescence.

Use the public Node `mirrorgate/control` and `mirrorgate/worker` subpaths or the
native C++ SDK under `sdk/cpp/`. The
[Node guide](https://github.com/NzSN/MirrorGate/blob/main/sdk/node/README.md) and
[C++ guide](https://github.com/NzSN/MirrorGate/blob/main/sdk/cpp/README.md) describe native
transport and value conversion. Both interpret operation results and events;
the session transition function remains in Gate.

An accepted operation has one terminal result. Late waiters can query
`operation.status`; they must not retry an uncertain mutation. Control damage
or loss terminates the connection. A new evaluation uses a new connection and
new handles. Tokens and challenges belong in trusted in-memory state, outside
agent-facing diagnostics.

Retain a body failure as the primary evaluation result if cleanup also fails.
`cleanupFailed` remains a failure even when the remaining-resource list is
empty, such as after unsuccessful cooperative disposal followed by confirmed
process exit. Unexpected Gate death leaves cleanup unconfirmed; automatic
snapshot recovery is unavailable in this profile.

## Verify the development distribution

The machine-readable
[compatibility manifest](https://github.com/NzSN/MirrorGate/blob/main/sdk/compatibility.json)
records the development SDK version, separate control/worker versions, native
clients, worker runtimes, and pinned build prerequisites. Every connection also
negotiates actual capabilities; a manifest does not establish backend admission.

The full required-backend gate is:

```bash
cargo fetch --manifest-path runtimes/rust/Cargo.toml --locked
npm ci --ignore-scripts
bash scripts/test.sh
```

This includes public CLI acceptance, shared malformed-frame vectors, native
Node/C++ clients, package/declaration consumption, and the existing worker and
isolation suites. The C++ gate requires CMake, a C++17 compiler, and
`nlohmann_json` exactly `3.11.3`; it performs no dependency download. When that
dependency is supplied as headers, set `MIRRORGATE_NLOHMANN_JSON_INCLUDE_DIR`
to its directory containing `nlohmann/json.hpp`.

Production publication remains disabled. Full client-guide section-13
acceptance also requires correct and faulty model evaluations through the
actual MirrorECMA and MirrorCPP facades, with their precise repository and
generated-binding revisions recorded separately.
