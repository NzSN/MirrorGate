# Standard coordinating-agent hosting tool

The `mirrorgate/hosting-tool` module and `mirrorgate-hosting-tool` executable
provide the outside coordinator's stdio MCP adapter. The implementer's
`public_contract`, `gate_exec`, and `submit` broker is supplied by the hosting
controller. This adapter never replaces that broker or launches the implementer
itself. The controller independently admits the runtime, audit, profile and
sandbox before accepting `agent.start`.

## Tool contract

| Tool | Closed arguments | Result |
| --- | --- | --- |
| `hosting_start` | `{taskRef}` | Safe run reference and accepted status |
| `hosting_status` | Exactly one of `{runRef}` or `{taskRef}` | Public hosting progress and terminal outcome; bounded evaluation status if configured |
| `hosting_cancel` | `{runRef}` | Authoritative hosting outcome after joined cleanup |

Task references select immutable operator-approved session/profile/public-task
configuration. Tools accept no prompt text, executable, credential, environment,
mount, host path, administrative handle, or policy override. A safe `run_...`
reference belongs only to this adapter instance and cannot adopt another
controller connection's handles. `hosting_status({taskRef})` recovers a reference
after a lost tool reply; repeating start never repeats the controller mutation.
One attempt is supported per configured task and references have bounded retention.

Public status omits run/session/submission handles, controller error text,
remaining-resource identities, raw stdout/stderr and evaluator diagnostics.
It exposes committed source hash/revision, public progress, categorical failures,
and separate cleanup status. Trusted callback results stay in process and are
never automatically serialized to a tool caller.

## Ownership and trusted evaluation

`createHostingTool({connect, tasks, onSubmitted?})` calls the trusted `connect`
factory once per task run. Each run has its own dedicated v2 owner connection,
even when the connections attach to the same shared daemon. A single tool reply
does not close its owner or discard its submitted source.

After explicit submission and confirmed hosting cleanup, `onSubmitted` receives
`{client, session, run, taskRef, signal}` in the same process. Gate's trusted MBT
integration can prepare/evaluate using that original session and client; it must
not serialize handles or open a replacement connection. The callback may close
the dedicated owner itself and call the trusted-local
`completeCleanup({status: "succeeded" | "failed"})` hook exactly once after its
provider receipt establishes that cleanup status. Only this explicit handoff
skips duplicate session cleanup; a disconnected transport does not imply success.
The adapter still joins client closure. Otherwise it joins session/client cleanup when the
callback returns or fails. It supplies no MBT implementation or private oracle.
Without a callback, a submitted session remains available to trusted in-process
code until adapter shutdown. `completion(runRef)` is trusted local access to the
callback result; it is not an MCP operation.

Cancellation signals the trusted callback and invokes Gate's joined hosting
cancellation, then closes the owned session. EOF or process termination revokes
all adapter-owned work and joins bounded cleanup. An attached daemon is never
killed. An uncertain control request poisons that dedicated connection and must
not be retried; another task's owner remains independent.
For an owned v2 controller, uncertain requests first close stdin so the controller
can revoke resources on owner EOF. Forced termination follows only after the
hosting cleanup allowance. A nonzero exit or signal is unconfirmed cleanup.
Cancellation allows seven seconds for a running trusted callback to settle and
hand off cleanup. A callback that does not settle is reported as unconfirmed
cleanup while the adapter still closes its Gate resources.

## Installed configuration

Register the installed command with the coordinating agent's MCP configuration:

```text
mirrorgate-hosting-tool --config /absolute/operator-owned/hosting.json
```

The JSON file uses this shape (the manifest string below must be replaced by the
actual approved public manifest):

```json
{
  "schema": "mirrorgate.hosting-tool/v1",
  "controller": {"kind": "attached", "socketPath": "/run/user/1000/gate/control.sock"},
  "requiredCapabilities": ["backend.linux-bubblewrap-v1"],
  "tasks": {
    "counter": {
      "session": {
        "policyId": "counter",
        "submission": {"kind": "source", "input": {"rootId": "submissions", "relativePath": "counter"}, "buildPlanId": "node-build", "authoring": true},
        "runtime": "node-v1",
        "manifestJson": "<approved public manifest JSON>"
      },
      "agent": {"profileId": "restricted-codex", "publicTask": {"instructions": "Implement Counter from the approved public contract.", "files": []}}
    }
  }
}
```

An owned controller can instead be configured as
`{kind:"owned", controller:{command,args,cwd?,env?}}`, using the existing trusted
SDK launch contract. The fixed operator controller configuration belongs in
this file, never in tool arguments. The public task is context, not a writable
submission overlay. The file must be a regular, non-symlink file owned by the
current user and inaccessible to other users. Applications may supply approved
tasks programmatically; they do not need custom process launch or cleanup scripts.

The CLI supports MCP `initialize`, `ping`, `tools/list` and `tools/call` over
bounded UTF-8 JSONL. It advertises protocol `2024-11-05`. It does not advertise
resources, prompts, sampling, filesystem tools, or delegate authority. Native
callers can use `ControlSession.startAgent` directly instead.

## Verification boundary

Node shared-vector tests cover the independent v2 contract. MCP dispatch and
installed-package tests cover the supplied registration path, approved-task
mapping, uncertain replies, caller-scoped references and disclosure. Synthetic
controller/model tests do not certify runtime audits or sandbox isolation; those
remain controller/backend and full hosted-workflow gates.
