# Linux bubblewrap profile

For a request-by-request explanation with source pointers, read the
[sandbox design walkthrough](https://github.com/NzSN/MirrorGate/blob/main/docs/sandbox-design.md). This guide records the backend's
operational requirements and limits.

MirrorGate's first supervisor uses Python 3.12 and rootless bubblewrap 0.9 or
newer. This is a Linux namespace backend, with no unsandboxed fallback. The
administrative API and CLI belong to the trusted evaluator. An agent tool gateway
exposes only `ToolRequest(argv, cwd)` on a preconfigured `GateSession`; it never
exposes session construction, CLI flags, runtime mounts, or policy replacement.

## Profiles and trust

| Profile | Submission mount | Writable resources |
| --- | --- | --- |
| authoring | approved workspace at `/workspace` | workspace, private `/tmp`, `/scratch` |
| build | frozen source at `/source` | supervisor-owned `/output`, private `/tmp`, `/scratch` |
| execution | frozen artifact at `/artifact` | private `/tmp`, `/scratch` |

Build/execution snapshot their input before launch. Regular files and directories
are accepted; symlinks, hardlinked files, special files, traversal components,
and files changed during copying are rejected. Traversal opens each component
relative to an already opened directory using `O_NOFOLLOW`. Snapshot content,
relative names, and executable flags determine the SHA-256 identity. A snapshot
is distinct from the live authoring tree and mounted read-only. The trusted
controller must stop concurrent writers for a coherent multi-file submission;
copying does not create an atomic transaction across a live directory tree.

The operator approves runtime mounts. The initial `system_runtime_mounts()`
profile exposes host `/usr` read-only: operators must ensure that this approved
toolchain tree contains only public runtime material. Extra approved trees mount
under `/runtime/NAME`. No host root, home, `/etc`, management socket, or evaluator
directory is automatically mounted. Runtime roots and the supervisor must be
owned by the trusted operator and inaccessible to authoring tools for mutation.
Admission rejects equal, ancestor, or descendant relationships between approved
runtime roots and either submission or build-output roots. Pinned directory
identities also reject writable mounts aliasing a runtime root. Operators must
not introduce separate bind-mount aliases of runtime subtrees into writable
resources; this version does not reconstruct the host's complete mount graph.

The backend creates user, PID, IPC, network, and UTS namespaces, disables nested
user namespaces, drops all capabilities, clears inherited environment, creates a
new session, and uses bubblewrap's `no_new_privs` and parent-death handling. A new
`/proc` exposes only sandbox processes. Fresh `/dev` contains basic devices; its
shared-memory area is separately size-limited. The root mount is read-only.
Only a private network namespace with loopback is available; network access to
host services and external hosts is unavailable. There is no service exception
in this backend version. Commands receive no inherited host file descriptors
other than the explicitly forwarded stdin/stdout/stderr transport. Source roots
are pinned with directory descriptors during namespace setup. A trusted Python
bootstrap (`-I -S`, from the approved `/usr` tree) closes those descriptors before
executing submitted code; bubblewrap alone preserves inherited descriptors.

All commands run as namespace PID 1, so kernel PID-namespace cleanup terminates
remaining descendants when the main command dies, including children that
create a new session. The supervisor owns cancellation, wall-clock deadlines,
and stdout/stderr caps; exceeded bounds cause forced termination. Streaming
execution-channel EOF closes worker input and allows a short fixed grace period
before forced cleanup. Batch `run()` and authoring/build CLI stdin completion
allow the command to finish within its wall deadline.

Normal completion, cancellation, and timeout remove supervisor-owned host
snapshots on session close. Abruptly killing the supervisor still terminates
worker processes and releases namespace mounts, but can leave its public
snapshot directory in the host temporary directory. Operators must remove
abandoned directories after establishing that the owning controller has exited;
this first backend does not provide crash-recovery garbage collection.

## Enforced bounds and limitations

Defaults: 30 seconds wall time, 20 CPU seconds per process, 4 GiB virtual address
space per process, 4096 UID-scoped processes/threads, 128 file descriptors per
process, 64 MiB per regular output file, 4 MiB stdout and 1 MiB stderr per
session, 64 MiB private `/tmp`, and 256 MiB private `/scratch`. `/dev/shm` is
limited to 16 MiB. Core dumps are disabled. Limits are inherited and cannot be
raised by submitted code. The address-space limit is not an RSS guarantee;
Node v24 starts under 4 GiB here, but other V8 builds may need an explicitly
approved larger value to reserve virtual memory.

These rlimits do **not** provide aggregate cgroup memory/CPU/PID accounting.
`RLIMIT_NPROC` is scoped to the real UID, can interact with other processes, and
counts threads on Linux. A bound below existing UID thread usage can prevent
namespace admission. It is not a per-sandbox PID quota. The backend rejects
requested aggregate memory, CPU, PID, or disk quotas, external networking, and
other unsupported capabilities. It does not claim protection against all host
resource exhaustion: many files in an authoring/output host mount, or aggregate
memory across processes, require a future quota/cgroup backend. Deploy hostile
workloads on an expendable dedicated host/VM when stronger denial-of-service
containment is needed. The kernel and bubblewrap remain trusted; this backend
does not add a syscall seccomp allowlist.

## API and commands

```python
from mirrorgate import GateSession, ToolRequest, TrustedConfig

with GateSession(TrustedConfig(profile="execution", workspace="artifact")) as gate:
    result = gate.run(ToolRequest(("/artifact/worker", "--manifest", "/artifact/port.json")))
    assert result.reason == "exited"
```

Trusted administrators can use `python -m mirrorgate.cli run --profile execution
--workspace ARTIFACT -- COMMAND`. Raw stdin/stdout are forwarded, and stderr is
bounded. This CLI is not an agent-facing capability. `--runtime-root
HOST:/runtime/NAME` adds an operator-approved read-only runtime tree. Worker RPC
semantics remain the responsibility of the separate protocol/SDK layer.

## Acceptance checks

`python -m unittest discover -s tests -p 'test_supervisor.py'` checks admission,
artifact handling, and command policy. `MIRRORGATE_REQUIRE_SANDBOX=1 python -m
unittest discover -s tests -p 'test_isolation.py'` requires actual namespace
execution and checks private-file/process/environment/network denial, profile
write permissions, no-new-privileges, deadlines, output limits, descendant
cleanup, and EOF handling. Without the environment switch, unavailable namespaces
are explicitly skipped. A skip is not isolation evidence.

Primary references: [bubblewrap security and limitations](https://github.com/containers/bubblewrap/blob/main/README.md),
[bubblewrap options](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.xml),
and [Linux resource-limit semantics](https://man7.org/linux/man-pages/man2/setrlimit.2.html).
