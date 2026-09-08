"""Immutable control-v1 preparation and backend integration surface."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import os
from pathlib import Path, PurePosixPath
import secrets
import shutil
import stat
import sys
import tempfile
import threading
import time
from typing import Any, Callable

from .artifacts import FrozenLease, FrozenStore, remove_snapshot
from .control_policy import (CATALOG_ID, BuildPlan, ControlLimits,
                             ControlPolicy, PolicyCatalog, RuntimePlan,
                             checked_relative_path)
from .policy import AdmissionError, ToolRequest, TrustedConfig
from .protocol import MAX_MANIFEST_BYTES, _parse_json, validate_manifest
from .sandbox import GateSession, SandboxProcess
from .worker_broker import BrokerError, WorkerReservation


OutputCallback = Callable[[str, bytes], None]
WorkerEventCallback = Callable[[str, dict[str, Any]], None]


class BackendError(RuntimeError):
    """Safe backend failure for translation to a control error family."""

    def __init__(self, code: str, stage: str, message: str):
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.message = message[:1024]


@dataclass(frozen=True)
class BackendOwner:
    connection_id: str
    principal_uid: int
    session_id: str

    def __post_init__(self) -> None:
        if any(type(item) is not str or not item for item in (self.connection_id, self.session_id)):
            raise AdmissionError("backend owner handles must be nonempty strings")
        if type(self.principal_uid) is not int or self.principal_uid < 0:
            raise AdmissionError("backend principal UID is invalid")


@dataclass(frozen=True)
class CommandOutcome:
    returncode: int
    reason: str
    duration_ms: int


@dataclass(frozen=True)
class PreparedBackend:
    artifact_id: str
    artifact_hash: str
    source_hash: str | None
    runtime_id: str
    policy_id: str


@dataclass(frozen=True)
class AdmissionLease:
    """Opaque proof that this owner/artifact/runtime was admitted."""
    owner: BackendOwner
    artifact_lease_id: str
    runtime_id: str
    semantic_digest: str
    nonce: str


@dataclass(frozen=True)
class CleanupResult:
    complete: bool
    remaining_resources: tuple[str, ...] = ()
    failures: tuple[str, ...] = ()
    cleanup_mode: str | None = None


@dataclass
class BackendSession:
    owner: BackendOwner
    policy: ControlPolicy
    runtime: RuntimePlan
    limits: ControlLimits
    submission_kind: str
    input_path: Path
    build_plan: BuildPlan | None
    authoring_enabled: bool
    manifest_bytes: bytes
    semantic_digest: str
    manifest_lease: FrozenLease
    node_shim_lease: FrozenLease | None
    owned: Path
    deadline: float
    on_deadline: Callable[["BackendSession"], None] | None = None
    deadline_stop: threading.Event = field(default_factory=threading.Event)
    cleanup_event: threading.Event = field(default_factory=threading.Event)
    cleanup_lock: threading.Lock = field(default_factory=threading.Lock)
    cleanup_deadline: float | None = None
    cleanup_result: CleanupResult | None = None
    prepare_done: threading.Event = field(default_factory=threading.Event)
    preparing: bool = False
    closing: bool = False
    active_build_gate: GateSession | None = None
    active_build_process: SandboxProcess | None = None
    lock: threading.RLock = field(default_factory=threading.RLock)
    sealed: bool = False
    closed: bool = False
    active_authoring_gate: GateSession | None = None
    active_authoring_process: SandboxProcess | None = None
    authoring_starting: bool = False
    authoring_done: threading.Event = field(default_factory=threading.Event)
    source_lease: FrozenLease | None = None
    artifact_lease: FrozenLease | None = None
    prepared: PreparedBackend | None = None
    authorization: AdmissionLease | None = None
    reservation: WorkerReservation | None = None


def _submission(value: Any, policy: ControlPolicy, uid: int) -> tuple[str, Path, BuildPlan | None, bool]:
    if type(value) is not dict or value.get("kind") not in ("prebuilt", "source"):
        raise AdmissionError("submission must be prebuilt or source")
    kind = value["kind"]
    expected = {"kind", "input"} if kind == "prebuilt" else {"kind", "input", "buildPlanId", "authoring"}
    if set(value) != expected:
        raise AdmissionError("submission fields do not match its selected kind")
    input_ref = value["input"]
    if type(input_ref) is not dict or set(input_ref) != {"rootId", "relativePath"}:
        raise AdmissionError("input reference fields do not match contract")
    root_id = input_ref["rootId"]
    if type(root_id) is not str or CATALOG_ID.fullmatch(root_id) is None or root_id not in policy.roots:
        raise AdmissionError("input root is not approved")
    path = policy.roots[root_id].resolve(uid, input_ref["relativePath"], kind)
    if kind == "prebuilt":
        return kind, path, None, False
    if type(value["authoring"]) is not bool:
        raise AdmissionError("source authoring flag must be boolean")
    build_id = value["buildPlanId"]
    if type(build_id) is not str or CATALOG_ID.fullmatch(build_id) is None or build_id not in policy.build_plans:
        raise AdmissionError("build plan is not approved")
    if not path.is_dir():
        raise AdmissionError("source submission input must be a directory")
    return kind, path, policy.build_plans[build_id], value["authoring"]


def _safe_file(root: Path, relative: str) -> Path:
    relative = checked_relative_path(relative, "trusted shim file")
    path = root
    for part in PurePosixPath(relative).parts:
        path /= part
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise AdmissionError("trusted shim path contains a symlink")
    if not path.is_file():
        raise AdmissionError("trusted shim selection must be a regular file")
    return path


def _freeze_exact_files(store: FrozenStore, owner: BackendOwner, root: Path,
                        relatives: tuple[str, ...], staging_parent: Path,
                        limits: ControlLimits) -> FrozenLease:
    """Create a minimal tree; never freeze or mount the evaluator checkout."""
    staging = Path(tempfile.mkdtemp(prefix="trusted-shim-", dir=staging_parent))
    try:
        for relative in relatives:
            source = _safe_file(root, relative)
            target = staging / relative
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            before = source.stat()
            with source.open("rb") as incoming, target.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=65_536)
            after = source.stat()
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                    after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise AdmissionError("trusted shim source changed during copying")
            target.chmod(0o500 if before.st_mode & 0o111 else 0o400)
        return store.freeze(owner, staging, max_files=limits.snapshot_files,
                            max_bytes=limits.snapshot_bytes)
    finally:
        remove_snapshot(staging)


def _freeze_manifest(store: FrozenStore, owner: BackendOwner, manifest: bytes,
                     staging_parent: Path, limits: ControlLimits) -> FrozenLease:
    staging = Path(tempfile.mkdtemp(prefix="public-manifest-", dir=staging_parent))
    try:
        target = staging / "port.json"
        target.write_bytes(manifest)
        target.chmod(0o400)
        return store.freeze(owner, staging, max_files=limits.snapshot_files,
                            max_bytes=limits.snapshot_bytes)
    finally:
        remove_snapshot(staging)


class ControlBackend:
    """Blocking backend called off the control dispatcher for long operations."""

    def __init__(self, catalog: PolicyCatalog | str | Path, *, attachment_timeout_ms: int = 5000,
                 graceful_stop_ms: int = 1000, teardown_timeout_ms: int = 5000):
        self.catalog = catalog if isinstance(catalog, PolicyCatalog) else PolicyCatalog.from_file(catalog)
        self.attachment_timeout_ms = attachment_timeout_ms
        self.graceful_stop_ms = graceful_stop_ms
        self.teardown_timeout_ms = teardown_timeout_ms
        for name, value in (("attachment_timeout_ms", attachment_timeout_ms),
                            ("graceful_stop_ms", graceful_stop_ms),
                            ("teardown_timeout_ms", teardown_timeout_ms)):
            if type(value) is not int or value <= 0:
                raise AdmissionError(f"{name} must be a positive integer")
        self.instance_id = secrets.token_hex(16)
        self._owned = Path(tempfile.mkdtemp(prefix="mirrorgate-control-backend-"))
        # Linux sockaddr_un paths are capped at 108 bytes.  Keep the private
        # mode-0700 broker root short even when TMPDIR or session paths are long.
        self._endpoint_root = Path(tempfile.mkdtemp(prefix="mg-worker-", dir="/tmp"))
        self._endpoint_root.chmod(0o700)
        (self._owned / "snapshots").mkdir(mode=0o700, exist_ok=True)
        self._store = FrozenStore(self._owned / "snapshots")
        self._lock = threading.RLock()
        self._sessions: dict[BackendOwner, BackendSession | None] = {}
        self._probe_result: tuple[bool, str | None] | None = None

    def _probe_backend(self) -> tuple[bool, str | None]:
        with self._lock:
            if self._probe_result is not None:
                return self._probe_result
        probe_root = Path(tempfile.mkdtemp(prefix="probe-", dir=self._owned))
        try:
            with GateSession(TrustedConfig("execution", probe_root)) as gate:
                outcome = gate.run(ToolRequest(("/usr/bin/true",)))
            result = (outcome.returncode == 0, None if outcome.returncode == 0 else "BACKEND_PROBE_FAILED")
        except (AdmissionError, OSError, ValueError):
            result = (False, "BACKEND_PROBE_FAILED")
        finally:
            remove_snapshot(probe_root)
        with self._lock:
            self._probe_result = result
        return result

    def capability_reports(self, connection_mode: str) -> tuple[dict[str, Any], ...]:
        if connection_mode not in ("stdio", "unix"):
            raise BackendError("ARGUMENT_INVALID", "bootstrap", "unknown local control mode")
        backend_available, backend_reason = self._probe_backend()
        policies = tuple(self.catalog._policies.values())
        has_node = any("node-v1" in policy.runtimes for policy in self.catalog._policies.values())
        has_rust = any("rust-v1" in policy.runtimes for policy in self.catalog._policies.values())
        has_prebuilt = any("prebuilt" in root.kinds for policy in policies for root in policy.roots.values())
        has_source = any(policy.build_plans and any("source" in root.kinds for root in policy.roots.values())
                         for policy in policies)
        has_authoring = any(policy.tools and policy.build_plans
                            and any("source" in root.kinds for root in policy.roots.values())
                            for policy in policies)
        ids = {
            "control.local-stdio-v1": connection_mode == "stdio",
            "control.local-unix-v1": connection_mode == "unix",
            "submission.prebuilt-v1": has_prebuilt,
            "submission.source-build-v1": has_source,
            "authoring.tools-v1": has_authoring,
            "execution.compiled-verify-v1": has_node or has_rust,
            "worker.managed-unix-v1": sys.platform == "linux",
            "worker.node-v1": has_node,
            "worker.rust-v1": has_rust,
            "backend.linux-bubblewrap-v1": backend_available,
            "cleanup.bounded-attempt-v1": True,
            "limit.address-space-v1": backend_available,
            "limit.uid-processes-v1": backend_available,
            "quota.aggregate-v1": False,
        }
        reports = []
        for capability_id, available in ids.items():
            scope = "session"
            if capability_id.startswith("control.local"):
                scope = "connection"
            elif capability_id == "backend.linux-bubblewrap-v1":
                scope = "command"
            elif capability_id == "limit.address-space-v1":
                scope = "process"
            elif capability_id == "limit.uid-processes-v1":
                scope = "host-uid"
            elif capability_id == "quota.aggregate-v1":
                scope = "none"
            limits = {}
            if capability_id == "limit.address-space-v1":
                limits["addressSpaceBytes"] = max(policy.limits.address_space_bytes for policy in self.catalog._policies.values())
            if capability_id == "limit.uid-processes-v1":
                limits["uidProcesses"] = max(policy.limits.uid_processes for policy in self.catalog._policies.values())
            report = {"id": capability_id, "available": available,
                      "enforcedScope": scope if available else "none", "limits": limits}
            if not available:
                report["reason"] = ("UNSUPPORTED_AGGREGATE_QUOTAS" if capability_id == "quota.aggregate-v1"
                                    else backend_reason or "UNAVAILABLE")
            reports.append(report)
        return tuple(reports)

    def open_session(self, *, owner: BackendOwner, policy_id: str, submission: dict[str, Any],
                     runtime: str, manifest_bytes: bytes,
                     tightened_limits: dict[str, int] | None = None,
                     on_deadline: Callable[[BackendSession], None] | None = None) -> BackendSession:
        with self._lock:
            if len(self._sessions) >= 64:
                raise BackendError("LIMIT_EXCEEDED", "policy", "process-wide control session limit exceeded")
            if owner in self._sessions:
                raise BackendError("HANDLE_INVALID", "policy", "backend session owner is already registered")
            # Reserve ownership before allocating any partial resource.
            self._sessions[owner] = None
        state: BackendSession | None = None
        allocated_leases: list[FrozenLease] = []
        session_owned = self._owned / ("session-" + secrets.token_hex(16))
        try:
            if owner.principal_uid != os.getuid():
                raise AdmissionError("control principal UID is not admitted by this local backend")
            policy = self.catalog.select(policy_id)
            limits = policy.limits.tighten(tightened_limits)
            if type(runtime) is not str or runtime not in policy.runtimes:
                raise AdmissionError("requested runtime is not approved")
            runtime_plan = policy.runtimes[runtime]
            kind, input_path, build_plan, authoring = _submission(submission, policy, owner.principal_uid)
            if type(manifest_bytes) is not bytes or len(manifest_bytes) > MAX_MANIFEST_BYTES:
                raise AdmissionError("manifestJson exceeds the public manifest byte limit")
            manifest = validate_manifest(_parse_json(manifest_bytes))
            session_owned.mkdir(mode=0o700)
            manifest_lease = _freeze_manifest(self._store, owner, manifest_bytes, session_owned, limits)
            allocated_leases.append(manifest_lease)
            shim_lease = None
            if runtime_plan.node_shim is not None:
                shim = runtime_plan.node_shim
                shim_lease = _freeze_exact_files(self._store, owner, shim.root,
                                                 (shim.worker_path, shim.protocol_path),
                                                 session_owned, limits)
                allocated_leases.append(shim_lease)
            state = BackendSession(
                owner=owner, policy=policy, runtime=runtime_plan, limits=limits,
                submission_kind=kind, input_path=input_path, build_plan=build_plan,
                authoring_enabled=authoring, manifest_bytes=manifest_bytes,
                semantic_digest=manifest["interfaceDigest"], manifest_lease=manifest_lease,
                node_shim_lease=shim_lease, owned=session_owned,
                deadline=time.monotonic() + limits.session_wall_ms / 1000,
                on_deadline=on_deadline,
            )
            state.prepare_done.set()
            state.authoring_done.set()
            with self._lock:
                self._sessions[owner] = state
            threading.Thread(target=self._deadline_watchdog, args=(state,), daemon=True,
                             name="mirrorgate-session-deadline").start()
            return state
        except BaseException as exc:
            if state is not None:
                self.cleanup_session(state, reason="client-failure", cancel_event=threading.Event())
            else:
                for lease in reversed(allocated_leases):
                    try:
                        lease.close(owner)
                    except BaseException:
                        pass
                remove_snapshot(session_owned)
                with self._lock:
                    self._sessions.pop(owner, None)
            if isinstance(exc, BackendError):
                raise
            raise BackendError("POLICY_DENIED", "policy", str(exc)) from exc

    def _deadline_watchdog(self, state: BackendSession) -> None:
        if state.deadline_stop.wait(max(0, state.deadline - time.monotonic())):
            return
        state.cleanup_event.set()
        try:
            if state.on_deadline is not None:
                state.on_deadline(state)
        finally:
            # The callback starts controller bookkeeping.  This backstop owns
            # physical teardown even if the control connection is stalled.
            self.cleanup_session(state, reason="deadline", cancel_event=threading.Event())

    def _check_state(self, state: BackendSession) -> None:
        with self._lock:
            if self._sessions.get(state.owner) is not state or state.closed:
                raise BackendError("HANDLE_INVALID", "policy", "backend session is not active")
        if state.closing or state.cleanup_event.is_set():
            raise BackendError("STATE_INVALID", "cleanup", "backend session is closing")
        if time.monotonic() >= state.deadline:
            raise BackendError("DEADLINE_EXCEEDED", "cleanup", "evaluation session deadline exceeded")

    def resource_counts(self, state: BackendSession) -> dict[str, int]:
        """Report registered physical ownership without exposing host paths."""
        with state.lock:
            authoring = state.active_authoring_process
            build = state.active_build_process
            return {
                "authoringProcesses": int(authoring is not None and authoring.returncode is None),
                "buildProcesses": int(build is not None and build.returncode is None),
                "workers": int(state.reservation is not None),
                "snapshots": sum(lease is not None for lease in (
                    state.manifest_lease, state.node_shim_lease,
                    state.source_lease, state.artifact_lease)),
            }

    def _sandbox_limits(self, state: BackendSession, *, execution: bool):
        remaining = state.deadline - time.monotonic()
        if remaining <= 0:
            raise BackendError("DEADLINE_EXCEEDED", "cleanup", "evaluation session deadline exceeded")
        limits = state.limits.sandbox_limits(execution=execution)
        return replace(limits, wall_seconds=min(limits.wall_seconds, remaining))

    @staticmethod
    def _stream(process: SandboxProcess, emit_output: OutputCallback,
                *cancel_events: threading.Event) -> CommandOutcome:
        def drain(stream: str, reader: Callable[[], bytes]) -> None:
            while chunk := reader():
                for offset in range(0, len(chunk), 16 * 1024):
                    emit_output(stream, chunk[offset:offset + 16 * 1024])
        stdout = threading.Thread(target=drain, args=("stdout", process.read_stdout), daemon=True)
        stderr = threading.Thread(target=drain, args=("stderr", process.read_stderr), daemon=True)
        stdout.start()
        stderr.start()
        while True:
            if any(event.is_set() for event in cancel_events) and process.returncode is None:
                process.cancel()
            try:
                returncode = process.wait(timeout=0.05)
                break
            except TimeoutError:
                continue
        stdout.join(timeout=1)
        stderr.join(timeout=1)
        return CommandOutcome(returncode, process.reason, int((time.monotonic() - process.started) * 1000))

    def authoring_exec(self, state: BackendSession, *, tool_id: str, arguments: list[str], cwd: str,
                       cancel_event: threading.Event, emit_output: OutputCallback) -> CommandOutcome:
        self._check_state(state)
        with state.lock:
            if state.sealed or not state.authoring_enabled or state.submission_kind != "source":
                raise BackendError("STATE_INVALID", "authoring", "authoring is unavailable after preparation starts")
            if state.active_authoring_process is not None or state.authoring_starting:
                raise BackendError("STATE_INVALID", "authoring", "an authoring command is already active")
            if tool_id not in state.policy.tools:
                raise BackendError("POLICY_DENIED", "authoring", "tool is not approved by policy")
            cwd = checked_relative_path(cwd, "authoring cwd")
            argv = state.policy.tools[tool_id].argv(arguments)
            state.authoring_starting = True
            state.authoring_done.clear()
        gate = None
        process = None
        try:
            try:
                gate = GateSession(TrustedConfig("authoring", state.input_path,
                                                 runtime_mounts=state.runtime.runtime_mounts,
                                                 limits=self._sandbox_limits(state, execution=False)))
                with state.lock:
                    if state.closing or state.cleanup_event.is_set():
                        raise BackendError("CANCELLED", "authoring", "authoring admission was cancelled")
                    state.active_authoring_gate = gate
                process = gate.start(ToolRequest(argv, cwd))
                with state.lock:
                    if state.closing or state.cleanup_event.is_set():
                        process.cancel()
                        raise BackendError("CANCELLED", "authoring", "authoring launch was cancelled")
                    state.active_authoring_process = process
            except BackendError:
                raise
            except (AdmissionError, OSError) as exc:
                raise BackendError("BACKEND_ADMISSION_FAILED", "authoring", str(exc)) from exc
            outcome = self._stream(process, emit_output, cancel_event, state.cleanup_event)
            if outcome.reason == "cancelled":
                raise BackendError("CANCELLED", "authoring", "authoring command was cancelled")
            if outcome.reason in ("wall_timeout", "stdin_eof"):
                raise BackendError("DEADLINE_EXCEEDED", "authoring", "authoring command exceeded its deadline")
            if outcome.reason.endswith("_limit"):
                raise BackendError("LIMIT_EXCEEDED", "authoring", "authoring command exceeded an output limit")
            if outcome.returncode < 0:
                raise BackendError("PREPARATION_FAILED", "authoring", "authoring command was terminated by a signal")
            # A normal nonzero tool exit is a successful CommandOutcome.  Its
            # diagnostics are part of authoring iteration and the session stays usable.
            return outcome
        finally:
            try:
                if gate is not None:
                    gate.close()
            finally:
                late_cleanup = False
                with state.lock:
                    state.active_authoring_process = None
                    state.active_authoring_gate = None
                    state.authoring_starting = False
                    state.authoring_done.set()
                    late_cleanup = state.cleanup_event.is_set() and not state.closed
                if late_cleanup:
                    threading.Thread(target=self.cleanup_session, args=(state,),
                                     kwargs={"reason": "client-failure", "cancel_event": threading.Event()},
                                     daemon=True, name="mirrorgate-late-authoring-cleanup").start()

    def _stop_authoring(self, state: BackendSession) -> None:
        with state.lock:
            state.sealed = True
            process = state.active_authoring_process
            gate = state.active_authoring_gate
        if process is not None and process.returncode is None:
            process.cancel()
            try:
                process.wait(timeout=self.teardown_timeout_ms / 1000)
            except TimeoutError as exc:
                raise BackendError("CLEANUP_FAILED", "prepare", "authoring writer did not terminate") from exc
        if gate is not None:
            gate.close()

    def prepare(self, state: BackendSession, *, cancel_event: threading.Event,
                emit_output: OutputCallback) -> PreparedBackend:
        self._check_state(state)
        with state.lock:
            if state.sealed or state.prepared is not None or state.preparing:
                raise BackendError("STATE_INVALID", "prepare", "preparation is permitted once")
            state.sealed = True
            state.preparing = True
            state.prepare_done.clear()
        try:
            self._stop_authoring(state)
            if cancel_event.is_set() or state.cleanup_event.is_set():
                raise BackendError("CANCELLED", "prepare", "preparation was cancelled")
            if state.submission_kind == "prebuilt":
                artifact = self._store.freeze(state.owner, state.input_path,
                                              max_files=state.limits.snapshot_files,
                                              max_bytes=state.limits.snapshot_bytes)
                with state.lock:
                    cancelled = state.closing or cancel_event.is_set() or state.cleanup_event.is_set()
                if cancelled:
                    artifact.close(state.owner)
                    raise BackendError("CANCELLED", "prepare", "preparation was cancelled")
                source_hash = None
            else:
                source = self._store.freeze(state.owner, state.input_path,
                                            max_files=state.limits.snapshot_files,
                                            max_bytes=state.limits.snapshot_bytes)
                with state.lock:
                    cancelled = state.closing or cancel_event.is_set() or state.cleanup_event.is_set()
                    if not cancelled:
                        state.source_lease = source
                if cancelled:
                    source.close(state.owner)
                    raise BackendError("CANCELLED", "prepare", "preparation was cancelled")
                output = state.owned / "build-output"
                output.mkdir(mode=0o700)
                assert state.build_plan is not None
                gate = GateSession.from_frozen(
                    profile="build", lease=source, owner=state.owner,
                    runtime_mounts=state.runtime.runtime_mounts,
                    limits=self._sandbox_limits(state, execution=False), output=output)
                with state.lock:
                    cancelled = state.closing or state.cleanup_event.is_set()
                    if not cancelled:
                        state.active_build_gate = gate
                if cancelled:
                    gate.close()
                    raise BackendError("CANCELLED", "build", "build was cancelled")
                try:
                    process = gate.start(ToolRequest(state.build_plan.command, state.build_plan.cwd))
                    with state.lock:
                        state.active_build_process = process
                    outcome = self._stream(process, emit_output, cancel_event, state.cleanup_event)
                    if cancel_event.is_set() or state.cleanup_event.is_set() or outcome.reason == "cancelled":
                        raise BackendError("CANCELLED", "build", "build was cancelled")
                    if outcome.returncode != 0:
                        raise BackendError("BUILD_FAILED", "build", "approved build plan failed")
                finally:
                    gate.close()
                    with state.lock:
                        state.active_build_process = None
                        state.active_build_gate = None
                if cancel_event.is_set() or state.cleanup_event.is_set():
                    raise BackendError("CANCELLED", "build", "build was cancelled")
                artifact_path = output if state.build_plan.artifact_path == "." else output / state.build_plan.artifact_path
                artifact = self._store.freeze(state.owner, artifact_path,
                                              max_files=state.limits.snapshot_files,
                                              max_bytes=state.limits.snapshot_bytes)
                source_hash = source.digest
            with state.lock:
                cancelled = state.closing or cancel_event.is_set() or state.cleanup_event.is_set()
                if not cancelled:
                    state.artifact_lease = artifact
                    entry = artifact._mount_path(state.owner)
                    if state.runtime.artifact_entry != ".":
                        entry /= state.runtime.artifact_entry
                    try:
                        entry_info = entry.lstat()
                    except OSError as exc:
                        raise BackendError("PREPARATION_FAILED", "prepare", "fixed runtime artifact entry is missing") from exc
                    if stat.S_ISLNK(entry_info.st_mode) or not (stat.S_ISREG(entry_info.st_mode) or stat.S_ISDIR(entry_info.st_mode)):
                        raise BackendError("PREPARATION_FAILED", "prepare", "fixed runtime artifact entry is invalid")
            if cancelled:
                artifact.close(state.owner)
                raise BackendError("CANCELLED", "prepare", "preparation was cancelled")
            prepared = PreparedBackend(secrets.token_hex(16), artifact.digest, source_hash,
                                       state.runtime.id, state.policy.id)
            with state.lock:
                if state.closing or state.cleanup_event.is_set():
                    raise BackendError("CANCELLED", "prepare", "preparation was cancelled")
                state.prepared = prepared
            return prepared
        except BackendError:
            raise
        except (AdmissionError, OSError) as exc:
            raise BackendError("PREPARATION_FAILED", "prepare", str(exc)) from exc
        finally:
            late_cleanup = False
            with state.lock:
                state.preparing = False
                state.prepare_done.set()
                late_cleanup = state.cleanup_event.is_set() and not state.closed
            if late_cleanup:
                # A teardown attempt may already have reported its bounded
                # failure.  Continue best-effort physical reclamation without
                # changing the controller's retained primary outcome.
                threading.Thread(target=self.cleanup_session, args=(state,),
                                 kwargs={"reason": "client-failure", "cancel_event": threading.Event()},
                                 daemon=True, name="mirrorgate-late-prepare-cleanup").start()

    def _execution_gate(self, state: BackendSession) -> GateSession:
        with state.lock:
            artifact = state.artifact_lease
            manifest = state.manifest_lease
            shim = state.node_shim_lease
            if state.closing or state.cleanup_event.is_set():
                raise BackendError("STATE_INVALID", "authorize", "session is closing")
        if artifact is None or manifest is None:
            raise BackendError("STATE_INVALID", "authorize", "artifact has not been prepared")
        readonly = [(manifest, state.owner, "/runtime/mirrorgate-manifest")]
        if shim is not None:
            readonly.append((shim, state.owner, "/runtime/mirrorgate-node-shim"))
        try:
            return GateSession.from_frozen(
                profile="execution", lease=artifact, owner=state.owner,
                runtime_mounts=state.runtime.runtime_mounts,
                limits=self._sandbox_limits(state, execution=True),
                readonly_leases=tuple(readonly))
        except (AdmissionError, OSError) as exc:
            raise BackendError("BACKEND_ADMISSION_FAILED", "authorize", str(exc)) from exc

    def authorize_admission(self, state: BackendSession, *, prepared_revision: int,
                            challenge: str,
                            attestation: dict[str, Any]) -> AdmissionLease:
        self._check_state(state)
        if prepared_revision != 1 or type(challenge) is not str or len(challenge) != 32 or any(char not in "0123456789abcdef" for char in challenge):
            raise BackendError("NEGOTIATION_ATTESTATION_INVALID", "authorize", "prepared revision is invalid")
        with state.lock:
            if state.prepared is None or state.artifact_lease is None or state.authorization is not None:
                raise BackendError("STATE_INVALID", "authorize", "session is not awaiting authorization")
        fields = {"registrationId", "request", "policy", "status", "descriptorSchema",
                  "semanticDigest", "adapterId", "targetProfile", "stateComputerContractVersion"}
        expected = {
            "request": "verify", "policy": "require", "status": "matched",
            "descriptorSchema": state.runtime.descriptor_schema,
            "semanticDigest": state.semantic_digest,
            "adapterId": state.runtime.adapter_id,
            "targetProfile": state.runtime.target_profile,
            "stateComputerContractVersion": state.runtime.state_computer_contract_version,
        }
        if type(attestation) is not dict or set(attestation) != fields:
            raise BackendError("NEGOTIATION_ATTESTATION_INVALID", "authorize", "attestation fields do not match contract")
        try:
            registration_size = (len(attestation["registrationId"].encode("utf-8"))
                                 if type(attestation["registrationId"]) is str else 0)
        except UnicodeError:
            registration_size = 129
        if (type(attestation["registrationId"]) is not str or not attestation["registrationId"]
                or registration_size > 128):
            raise BackendError("NEGOTIATION_ATTESTATION_INVALID", "authorize", "registrationId is invalid")
        if any(attestation[name] != value for name, value in expected.items()):
            raise BackendError("NEGOTIATION_ATTESTATION_INVALID", "authorize", "required negotiation did not match the frozen plan")
        # Construct and close the real backend now; no submitted code is started.
        probe = self._execution_gate(state)
        probe.close()
        with state.lock:
            if state.closing or state.cleanup_event.is_set() or state.artifact_lease is None:
                raise BackendError("CANCELLED", "authorize", "session closed during backend admission")
            lease = AdmissionLease(state.owner, state.artifact_lease.lease_id, state.runtime.id,
                                   state.semantic_digest, secrets.token_hex(32))
            state.authorization = lease
        return lease

    def reserve_worker(self, state: BackendSession, *, authorization: AdmissionLease, worker_id: str,
                       owner: BackendOwner,
                       launch_guard: Callable[[BackendOwner, str, AdmissionLease], bool],
                       on_worker_event: WorkerEventCallback) -> WorkerReservation:
        self._check_state(state)
        with state.lock:
            if (owner != state.owner or state.authorization is not authorization
                    or authorization.owner != owner or state.artifact_lease is None
                    or authorization.artifact_lease_id != state.artifact_lease.lease_id
                    or authorization.runtime_id != state.runtime.id
                    or authorization.semantic_digest != state.semantic_digest):
                raise BackendError("BACKEND_ADMISSION_FAILED", "attach", "worker authorization is stale or foreign")
            if state.reservation is not None:
                raise BackendError("STATE_INVALID", "attach", "session already owns a worker reservation")

            def launch() -> tuple[GateSession, SandboxProcess]:
                # Physical admission is reconstructed from frozen IDs directly
                # before the first instruction of submitted code.
                with state.lock:
                    if (state.closed or state.authorization is not authorization
                            or state.artifact_lease is None
                            or authorization.artifact_lease_id != state.artifact_lease.lease_id):
                        raise BrokerError("ATTACHMENT_FAILED", "physical launch admission became stale")
                gate = self._execution_gate(state)
                try:
                    process = gate.start(ToolRequest(state.runtime.command, "."))
                    return gate, process
                except BaseException:
                    gate.close()
                    raise

            try:
                reservation = WorkerReservation(
                    owner=owner, principal_uid=owner.principal_uid,
                    session_id=owner.session_id, worker_id=worker_id,
                    admission=authorization, endpoint_parent=self._endpoint_root,
                    attachment_timeout_ms=self.attachment_timeout_ms,
                    launch_guard=launch_guard, launch=launch, on_event=on_worker_event,
                    graceful_stop_ms=self.graceful_stop_ms,
                    teardown_timeout_ms=self.teardown_timeout_ms)
            except (OSError, BrokerError) as exc:
                raise BackendError("ATTACHMENT_FAILED", "attach", str(exc)) from exc
            # Register before the endpoint descriptor is returned to control.
            state.reservation = reservation
            return reservation

    def arm_worker_release(self, state: BackendSession, *, worker_id: str, reason: str) -> str:
        with self._lock:
            if self._sessions.get(state.owner) is not state or state.closed:
                raise BackendError("HANDLE_INVALID", "cleanup", "backend session is not active")
        with state.lock:
            if state.cleanup_deadline is None:
                state.cleanup_deadline = time.monotonic() + self.teardown_timeout_ms / 1000
            reservation = state.reservation
            if reservation is None or reservation.worker_id != worker_id:
                raise BackendError("HANDLE_INVALID", "cleanup", "worker reservation is unknown")
            return reservation.arm_closing(reason=reason)

    def finish_worker_release(self, state: BackendSession, *, worker_id: str, reason: str,
                              cancel_event: threading.Event) -> CleanupResult:
        # Cancellation cannot cancel Gate cleanup; it only shortens cooperation.
        with state.lock:
            reservation = state.reservation
            if reservation is None or reservation.worker_id != worker_id:
                return CleanupResult(True)
            mode = reservation.arm_closing(reason=reason)
            deadline = state.cleanup_deadline or (time.monotonic() + self.teardown_timeout_ms / 1000)
        physical_complete, failures = reservation.close(reason=reason, cleanup_mode=mode, deadline=deadline)
        with state.lock:
            if physical_complete:
                state.reservation = None
        return CleanupResult(physical_complete and not failures,
                             () if physical_complete else ("worker",), failures, mode)

    def cleanup_session(self, state: BackendSession, *, reason: str,
                        cancel_event: threading.Event) -> CleanupResult:
        with state.lock:
            if state.cleanup_result is not None and not state.cleanup_result.remaining_resources:
                return state.cleanup_result
            if state.cleanup_result is not None:
                state.cleanup_result = None
                state.cleanup_deadline = None
            if state.cleanup_deadline is None:
                state.cleanup_deadline = time.monotonic() + self.teardown_timeout_ms / 1000
            deadline = state.cleanup_deadline
        acquired = state.cleanup_lock.acquire(timeout=max(0, deadline - time.monotonic()))
        if not acquired:
            return CleanupResult(False, ("cleanup",), ("another cleanup attempt did not finish before deadline",))
        try:
            with state.lock:
                if state.cleanup_result is not None:
                    return state.cleanup_result
            return self._cleanup_session_locked(state, reason=reason, cancel_event=cancel_event,
                                                deadline=deadline)
        finally:
            state.cleanup_lock.release()

    def _cleanup_session_locked(self, state: BackendSession, *, reason: str,
                                cancel_event: threading.Event, deadline: float) -> CleanupResult:
        failures: list[str] = []
        remaining: list[str] = []
        with state.lock:
            if state.closed:
                return CleanupResult(True)
            state.closing = True
            state.sealed = True
            state.cleanup_event.set()
            state.deadline_stop.set()
            process = state.active_authoring_process
            gate = state.active_authoring_gate
            build_process = state.active_build_process
            build_gate = state.active_build_gate
            reservation = state.reservation
        if process is not None and process.returncode is None:
            process.cancel()
        if build_process is not None and build_process.returncode is None:
            build_process.cancel()
        if gate is not None:
            try:
                gate.close(timeout=max(0, deadline - time.monotonic()))
            except BaseException as exc:
                failures.append(f"authoring cleanup failed: {exc}")
                remaining.append("authoring")
        if build_gate is not None:
            try:
                build_gate.close(timeout=max(0, deadline - time.monotonic()))
            except BaseException as exc:
                failures.append(f"build cleanup failed: {exc}")
                remaining.append("build")
        if not state.authoring_done.wait(max(0, deadline - time.monotonic())):
            failures.append("authoring admission did not quiesce before cleanup deadline")
            remaining.append("authoring")
            return CleanupResult(False, tuple(dict.fromkeys(remaining)), tuple(failures))
        if not state.prepare_done.wait(max(0, deadline - time.monotonic())):
            # Do not race removal against an in-progress snapshot/build.  The
            # preparation thread will observe cleanup_event before publishing.
            failures.append("preparation did not quiesce before cleanup deadline")
            remaining.append("preparation")
            return CleanupResult(False, tuple(dict.fromkeys(remaining)), tuple(failures))
        if reservation is not None:
            mode = reservation.arm_closing(reason=reason)
            physical_complete, worker_failures = reservation.close(reason=reason, cleanup_mode=mode,
                                                                   deadline=deadline)
            failures.extend(worker_failures)
            if not physical_complete:
                remaining.append("worker")
            else:
                with state.lock:
                    state.reservation = None
        for name in ("artifact_lease", "source_lease", "node_shim_lease", "manifest_lease"):
            lease = getattr(state, name)
            if lease is not None:
                try:
                    lease.close(state.owner)
                    setattr(state, name, None)
                except BaseException as exc:
                    failures.append(f"{name} cleanup failed: {exc}")
                    remaining.append(name)
        try:
            remove_snapshot(state.owned)
        except BaseException as exc:
            failures.append(f"session directory cleanup failed: {exc}")
            remaining.append("session-directory")
        result = CleanupResult(not failures and not remaining,
                               tuple(dict.fromkeys(remaining)), tuple(failures))
        with state.lock:
            state.closed = result.complete
            state.closing = not result.complete
            state.active_authoring_process = None
            state.active_authoring_gate = None
            state.active_build_process = None
            state.active_build_gate = None
            state.reservation = None if "worker" not in remaining else reservation
            state.cleanup_result = result
        if result.complete:
            with self._lock:
                self._sessions.pop(state.owner, None)
        return result

    def close(self) -> CleanupResult:
        failures: list[str] = []
        physical_remaining: list[str] = []
        with self._lock:
            sessions = [state for state in self._sessions.values() if state is not None]
        for state in sessions:
            result = self.cleanup_session(state, reason="client-failure", cancel_event=threading.Event())
            failures.extend(result.failures)
            physical_remaining.extend(result.remaining_resources)
            if not result.remaining_resources:
                with self._lock:
                    self._sessions.pop(state.owner, None)
        store_failures = self._store.close(timeout=self.teardown_timeout_ms / 1000)
        failures.extend(store_failures)
        if self._store.pending_removals:
            physical_remaining.append("snapshot-store")
        if not physical_remaining and not store_failures:
            remove_snapshot(self._owned)
            remove_snapshot(self._endpoint_root)
        return CleanupResult(not failures and not physical_remaining,
                             tuple(dict.fromkeys(physical_remaining)), tuple(failures))
