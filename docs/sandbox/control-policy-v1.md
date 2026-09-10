# Control v1/v2 operator policy catalog

Status: implemented local control-v1 catalog and compatible policy-v2 extensions.

The policy file is trusted operator input loaded before a control connection is
served. A request selects `policyId`, `rootId`, `buildPlanId`, `toolId`, and
`runtime`; it cannot supply a command, host path, runtime mount, environment, or
launcher argument. Every object below is closed: unknown and missing fields are
rejected. IDs use `[A-Za-z][A-Za-z0-9_.-]{0,127}`.

The top-level form is:

```json
{"schema":"mirrorgate.control-policy/v1","policies":[POLICY]}
```

Policy catalog v2 retains those fields and adds closed `agentProfiles` plus
per-policy `agentProfileIds`. A v2 approved root may also add a filtered source
view:

```json
{
  "id": "application-source",
  "path": "/srv/MirrorRBT",
  "kinds": ["source"],
  "allowedUids": [1000],
  "sourceView": {
    "schema": "mirrorgate.source-view/v1",
    "workspaceRoot": "/srv/MirrorRBT/.mirrors/work",
    "includePaths": ["package.json", "app", "src", "tests", ".mirrors/public"]
  }
}
```

A view requires a source-only root. `workspaceRoot` must already be a real,
symlink-free directory owned by the supervisor UID with mode `0700`; Gate pins
its device/inode identity. `includePaths` contains 1 to 1,024 unique canonical
relative files or directories and at most 65,535 aggregate UTF-8 bytes.
Directories are recursive. Globs, exclusions, negation, optional paths, `.`, and
ancestor/descendant selection overlap are rejected.

Gate materializes the selected files at `workspaceRoot/session-<sessionId>`
before authoring. The client still supplies only `{rootId, relativePath}`. A
successfully committed or prepared authoring view is retained for trusted
promotion; unsuccessful and no-author views are cleaned. The workspace path is
operator configuration and never enters public capability output. See
[supervisor design](supervisor-design.md#filtered-source-views) and the
[source-view plan](source-views-plan.md).

Each `POLICY` has exactly these fields:

| Field | Closed record or value |
| --- | --- |
| `id` | Policy ID |
| `roots` | Nonempty `[{id,path,kinds,allowedUids}]`; `path` is an absolute, symlink-free operator-approved directory, `kinds` is a unique subset of `prebuilt` and `source`, and `allowedUids` contains unique nonnegative host UIDs |
| `buildPlans` | `[{id,command,cwd,artifactPath}]`; `command` is the complete fixed sandbox argv, and both paths are canonical submission-relative paths |
| `tools` | `[{id,command,argumentMode}]`; mode `none` accepts no request arguments and `append` appends bounded arguments to the fixed command |
| `runtimes` | Nonempty runtime records described below |
| `limits` | Complete default limit record described below |

A Node runtime has exactly `id`, `kind: "node"`, `runtimeMounts`, `command`,
`artifactEntry`, `nodeShim`, `descriptorSchema`, `adapterId`, `targetProfile`,
and `stateComputerContractVersion`. `nodeShim` has exactly `root`, `workerPath`,
and `protocolPath`. Gate copies only those two trusted public files into a new
minimal frozen tree; it never mounts `nodeShim.root` or an evaluator checkout.
The command must name that frozen shim, the separate manifest path
`/runtime/mirrorgate-manifest/port.json`, and the fixed `/artifact` entry.

A Rust runtime has the same fields except `nodeShim`. Its executable must be
the fixed `/artifact/<artifactEntry>` path, which puts all submitted native
startup and pre-main code inside the execution sandbox. Every `runtimeMounts`
item is exactly `{source,destination}`. Destinations are `/usr` or one
`/runtime/NAME`; `/usr` is required. Requests can only select the runtime ID and
cannot add a mount or alter the argv.

The attestation identity fields are exact printable ASCII policy values. The
descriptor schema for this landing is
`mirrors.model-interface-descriptor/v1`. The example workers use adapter IDs
`mirrorgate/node-v1` and `mirrorgate/rust-v1`, target profiles `node-v1` and
`rust-v1`, and state-computer contract `mirrors.state-computer/v1`.

`limits` contains all and only these positive safe JSON integers:
`sessionWallMs`, `executionWallMs`, `commandCpuSeconds`,
`addressSpaceBytes`, `uidProcesses`, `openFiles`, `fileBytes`, `stdoutBytes`,
`stderrBytes`, `snapshotFiles`, `snapshotBytes`, `tmpBytes`, and
`scratchBytes`. `openFiles` is at least 32. A session request may omit fields or
tighten them; an unknown, boolean, zero, negative, unsafe, or larger value is
rejected. Address-space enforcement is per process, and the process count is
host-UID scoped. This catalog cannot request aggregate cgroup guarantees.

Input references and working directories are canonical relative paths of at
most 1,024 UTF-8 bytes; `.` is allowed. Parent traversal, absolute paths,
symlinks, NUL, invalid Unicode scalars, and special files are rejected. Commands
and appended tool arguments contain 1–256 nonempty NUL-free strings and at most
65,535 total UTF-8 bytes. Build and runtime commands are operator-authored fixed
argv arrays and never pass through a shell chosen by a control request.

Before source preparation, Gate seals authoring and terminates or awaits every
writer it owns. An operator importing a tree must separately stop writers that
are outside Gate; change-during-copy checks do not make a concurrently modified
external directory into an atomic snapshot.

Runnable Node and Rust fixtures are constructed from current absolute test
paths with:

```text
python tests/control_policy_fixture.py POLICY SUBMISSION_ROOT --runtime node
python tests/control_policy_fixture.py POLICY SUBMISSION_ROOT --runtime rust
python tests/control_policy_fixture.py POLICY SUBMISSION_ROOT --runtime rust --faulty
python tests/control_policy_fixture.py POLICY SUBMISSION_ROOT --runtime shared --faulty
```

The Node builder reads `MIRRORGATE_NODE_RUNTIME_ROOT` and mounts that pinned
distribution at `/runtime/node`. The Rust builder expects a prebuilt executable
at the selected artifact entry. The last command emits policy ID
`test.rust-faulty` while retaining worker runtime `rust-v1`; `--faulty` is part
of the trusted fixed launcher argv. `shared` emits the Node and Rust policies
in one catalog for cross-client tests. Static shape examples are under
`tests/fixtures/control-policy-v1*.example.json`.
