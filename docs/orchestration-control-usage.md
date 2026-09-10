# Using orchestration control v1

The experimental local controller owns preparation, authorization, worker
reservation, and cleanup. Node and C++ clients speak the same
[control contract](https://github.com/NzSN/MirrorGate/blob/main/protocol/control-v1/README.md).
The worker stream retains the existing
[worker v1 contract](https://github.com/NzSN/MirrorGate/blob/main/docs/protocol-v1.md).
The [task ledger](https://github.com/NzSN/MirrorGate/blob/main/docs/orchestration-control-v1-tasks.md)
records the original v1 landing. The Gate-owned MirrorECMA integration and
MirrorCPP facade now pass the shared matrix; see [final validation](managed-workflow-validation.md).

## Start the shared process

This guide describes control v1 preparation and worker orchestration. Its
`authoring.exec` operation runs restricted commands; managed AI authoring uses
[control v2](agent-hosting-control-v2.md), which the same controller supports.
Control v1 records remain unchanged, and neither version supports resume.

For coordinating agents, register the implemented
[hosting-tool adapter](../integrations/agent-host/README.md). It accepts approved
task references and retains a dedicated Gate owner through hosting and evaluation.
The [installed Counter application](../integrations/mirrorecma/examples/counter/README.md)
shows the MCP entrypoint and operator configuration.

The [Gate-owned local evaluation workflow](../integrations/mirrorecma/WORKFLOW.md)
composes hosting, preparation, a deferred implementation factory, and cleanup.
Applications provide approved tasks, profiles, suites and configuration. The
coordinator calls Gate directly; MirrorECMA performs generic MBT, and an existing
Mirrors server uses a separate model transport. See the
[implemented ownership boundary](managed-workflow-design.md).

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

The v1 examples use `mirrorgate.control-policy/v1`. Managed hosting uses the
[v2 catalog](agent-hosting-control-v2.md) with approved agent profiles and runtime
audits. The v1 catalog selects approved input
roots, authoring tools, build plans, runtime commands and mounts, and maximum
limits. See the concrete
[policy example](https://github.com/NzSN/MirrorGate/blob/main/tests/fixtures/control-policy-v1.example.json)
and the
[policy implementation](https://github.com/NzSN/MirrorGate/blob/main/supervisor/mirrorgate/control_policy.py).
The [policy guide](https://github.com/NzSN/MirrorGate/blob/main/docs/sandbox/control-policy-v1.md)
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

Production publication remains disabled. The [final validation record](managed-workflow-validation.md)
includes all 42 shared MirrorECMA/MirrorCPP cases, correct and faulty model
evaluations, and the installed MCP workflow with actual coordinating and
implementing Codex processes. Those model-facing gates supplement this SDK gate.
