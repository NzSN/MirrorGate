# Repository Guidelines

## Start here

Read [architecture.md](docs/architecture.md) and [README.md](README.md) before
adding functionality or changing a boundary. MirrorGate owns policy and lifecycle
for authoring, build, and execution sandboxes, tool mediation, worker RPC, runtime
shims, and conformance tests. The isolation backend enforces access restrictions;
Mirrors owns model resolution, generation, execution, and comparison; the trusted
evaluator owns private specifications, expected results, and disclosure policy.

The current implementation uses Python supervision, Linux/Bubblewrap, Node and
Rust workers, and a trusted Node proxy SDK. Consult
[task evidence](docs/tasks.md) and [compatibility](docs/compatibility.md) before
claiming support. Other language workers, Windows/macOS backends, and aggregate
cgroup quotas remain future work.

## Repository map and focused reading

- `protocol/`: shared schemas, source-contract identity, and wire fixtures in
  `conformance/`. Read [protocol v1](docs/protocol-v1.md) before changing framing,
  values, manifests, lifecycle, or cancellation; read
  [compatibility](docs/compatibility.md) for version changes.
- `supervisor/mirrorgate/`: trusted policy, artifact snapshots, sandbox launch,
  cleanup, and administrative CLI. Read the
  [Linux backend guide](docs/linux-bubblewrap.md) before changing profiles,
  mounts, resource limits, snapshots, or process lifecycle.
- `runtimes/node/`, `runtimes/rust/`: native adapter invocation and value
  conversion. Read the [Node](docs/node-worker.md) or
  [Rust](docs/rust-worker.md) worker guide for the affected runtime.
- `sdk/node/`: trusted evaluator transport and public-port proxy.
  `integrations/mirrorecma/` contains the optional evaluator bridge; read its
  [integration guide](integrations/mirrorecma/README.md) before changing it.
- `tests/` and `conformance/`: supervisor/isolation tests, Node SDK tests, and
  shared cross-language vectors and lifecycle cases. Rust tests also live in
  `runtimes/rust/tests/`.
- `examples/authoring-host.py`: restricted agent-tool integration. Read
  [blind validation](docs/blind-validation.md) before changing tool exposure,
  public-context export, or result disclosure.

## Build and verification

Run commands from this repository's root. Prerequisites and pinned versions are
in the README; real isolation requires a non-root Linux controller and working
unprivileged Bubblewrap namespaces.

```bash
cargo fetch --manifest-path runtimes/rust/Cargo.toml --locked
bash scripts/build.sh
bash scripts/test.sh
```

Fetch dependencies once; build/test scripts use Cargo offline with the committed
lockfile. If needed, select an installed matching compiler with
`RUSTUP_TOOLCHAIN` rather than changing global toolchain aliases.

`scripts/test.sh` rebuilds and runs Python, Node, Rust, Rust formatting, shared
vectors, and lifecycle gates with `MIRRORGATE_REQUIRE_SANDBOX=1`. Run it for code,
protocol, or sandbox changes. `npm test` covers only the Node and integration
test files and is not the full gate. An unavailable backend is a failure of the
required gate; report unavailable checks separately from passes.

For evaluator-bridge changes, also run the integration guide's smoke command
with explicit `MIRRORECMA_ROOT` and `MIRRORS_ROOT` pointing to compatible, prepared
checkouts. That smoke is separate from the standalone gate. For documentation-only
changes, check referenced paths and `git diff --check`.

## Architecture constraints

- Place worker communication at the generated implementation port: declared
  actions and inputs, actual observations, and lifecycle controls.
- Keep raw Mirrors messages, expected model states, private configuration, and
  evaluator credentials on the trusted side. A worker must not receive a raw
  `StateComputer` or `ReplayComputer` invocation as a shortcut for the public port.
- Keep supervisor policy and protocol semantics independent of any client
  language. Language shims own native invocation and value conversion.
- Reuse versioned public interface/type contracts from Mirrors. Keep worker
  protocol versions, semantic interface digests, runtime profiles, artifact
  hashes, and private specification revisions distinct. Keep evaluator integration
  on public client interfaces rather than MirrorECMA private modules.
- Treat submitted build scripts and adapter code as untrusted execution. The
  trusted launcher selects allowed runtime profiles and permissions.
- Freeze source before build and artifacts before evaluation. Later authoring
  edits must not alter an active evaluation through a live writable mount.
- The trusted agent host must mediate every access-capable tool and exclude
  private data from prompts, retrieval, and tool results. An unrestricted host
  tool or connector invalidates the corresponding blindness claim.

## Implementation and verification

Before implementing a new protocol or sandbox behavior, write its interface,
ownership, failure rules, and acceptance checks under `docs/`; link the relevant
document from the README. Preserve one owner for shared schemas and lifecycle
rules rather than copying them independently into every runtime.

Follow nearby Python, JavaScript ESM (`.mjs`), and Rust conventions; use Rust's
formatter for Rust changes. Keep build output and temporary evaluator artifacts
untracked.

Conformance tests should exercise identical operations and malformed-message
cases across workers. Isolation tests must attempt the prohibited access and
verify denial in the actual configured backend for each affected profile,
including submission-controlled build hooks. Cover policy-relaxation attempts,
frozen artifact handoff, and cleanup when those boundaries change.

Keep application observation fidelity separate from sandbox isolation: preventing
oracle access does not prove an adapter reports the real implementation's state.

`GateSession` configuration and the administrative CLI belong to trusted code.
Agent-facing integrations expose only validated tool requests on a preconfigured
session. A sandbox admission failure must never fall back to a raw subprocess.
Report per-process/UID limits accurately; this backend rejects aggregate cgroup
guarantees. Retain shared Node/Rust fixtures when changing a protocol behavior.

## Commits and review

Use focused commits with concise scoped subjects, following existing `feat:`
and `docs:` history. Describe resulting behavior, affected trust boundaries,
protocol/fixture compatibility, and validation commands with their outcomes.
Record local evidence separately from hosted CI or release claims.
