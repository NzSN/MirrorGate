"""Strict operator-owned policy catalog for orchestration control v1.

The catalog is loaded before serving control connections.  Requests select IDs
and may tighten numeric limits; they cannot add commands, roots, mounts, or
launch arguments.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
from typing import Any

from .policy import AdmissionError, Limits, RuntimeMount, checked_directory
from .source_view import SourceViewPolicy


CATALOG_SCHEMA = "mirrorgate.control-policy/v1"
CATALOG_ID = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,127}\Z", re.ASCII)
CONTROL_LIMIT_FIELDS = {
    "sessionWallMs", "executionWallMs", "commandCpuSeconds",
    "addressSpaceBytes", "uidProcesses", "openFiles", "fileBytes",
    "stdoutBytes", "stderrBytes", "snapshotFiles", "snapshotBytes",
    "tmpBytes", "scratchBytes",
}
MAX_SAFE_INTEGER = 9_007_199_254_740_991


def _object(value: Any, fields: set[str], label: str) -> dict[str, Any]:
    if type(value) is not dict or set(value) != fields:
        raise AdmissionError(f"{label} fields do not match the control policy schema")
    return value


def _array(value: Any, label: str, *, nonempty: bool = False) -> list[Any]:
    if type(value) is not list or (nonempty and not value):
        raise AdmissionError(f"{label} must be {'a nonempty ' if nonempty else 'an '}array")
    return value


def _id(value: Any, label: str) -> str:
    if type(value) is not str or CATALOG_ID.fullmatch(value) is None:
        raise AdmissionError(f"{label} is not a valid catalog ID")
    return value


def _opaque_ascii(value: Any, label: str) -> str:
    if (type(value) is not str or not value or len(value.encode("ascii", errors="ignore")) != len(value)
            or len(value) > 128 or any(ord(char) < 0x21 or ord(char) > 0x7e for char in value)):
        raise AdmissionError(f"{label} must be bounded printable ASCII")
    return value


def checked_relative_path(value: Any, label: str = "path") -> str:
    try:
        encoded = value.encode("utf-8") if type(value) is str else b""
    except UnicodeError as exc:
        raise AdmissionError(f"{label} must contain Unicode scalars") from exc
    if type(value) is not str or "\0" in value or len(encoded) > 1024:
        raise AdmissionError(f"{label} must be a bounded UTF-8 relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or str(path) != value or value == "":
        raise AdmissionError(f"{label} must be canonical and relative")
    return value


def _command(value: Any, label: str) -> tuple[str, ...]:
    items = _array(value, label, nonempty=True)
    if len(items) > 256 or any(type(item) is not str or not item or "\0" in item for item in items):
        raise AdmissionError(f"{label} contains invalid arguments")
    try:
        encoded_size = sum(len(item.encode("utf-8")) for item in items)
    except UnicodeError as exc:
        raise AdmissionError(f"{label} must contain Unicode scalars") from exc
    if encoded_size > 65_535:
        raise AdmissionError(f"{label} exceeds the argument byte limit")
    if not PurePosixPath(items[0]).is_absolute():
        raise AdmissionError(f"{label} executable must be an absolute sandbox path")
    return tuple(items)


def _unique(items: list[Any], label: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for item in items:
        if item.id in result:
            raise AdmissionError(f"duplicate {label} ID")
        result[item.id] = item
    return result


@dataclass(frozen=True)
class ControlLimits:
    session_wall_ms: int
    execution_wall_ms: int
    command_cpu_seconds: int
    address_space_bytes: int
    uid_processes: int
    open_files: int
    file_bytes: int
    stdout_bytes: int
    stderr_bytes: int
    snapshot_files: int
    snapshot_bytes: int
    tmp_bytes: int
    scratch_bytes: int

    @classmethod
    def parse(cls, value: Any) -> "ControlLimits":
        raw = _object(value, CONTROL_LIMIT_FIELDS, "limits")
        for name, item in raw.items():
            if type(item) is not int or not 1 <= item <= MAX_SAFE_INTEGER:
                raise AdmissionError(f"{name} must be a positive bounded integer")
        if raw["openFiles"] < 32:
            raise AdmissionError("openFiles must be at least 32")
        return cls(*(raw[name] for name in (
            "sessionWallMs", "executionWallMs", "commandCpuSeconds",
            "addressSpaceBytes", "uidProcesses", "openFiles", "fileBytes",
            "stdoutBytes", "stderrBytes", "snapshotFiles", "snapshotBytes",
            "tmpBytes", "scratchBytes")))

    def tighten(self, requested: Any | None) -> "ControlLimits":
        if requested is None:
            return self
        if type(requested) is not dict or set(requested) - CONTROL_LIMIT_FIELDS:
            raise AdmissionError("tightened limits contain unknown fields")
        current = self.as_wire()
        for name, item in requested.items():
            if type(item) is not int or item <= 0 or item > current[name]:
                raise AdmissionError(f"tightened {name} must be positive and no looser than policy")
            current[name] = item
        return ControlLimits.parse(current)

    def as_wire(self) -> dict[str, int]:
        return {
            "sessionWallMs": self.session_wall_ms,
            "executionWallMs": self.execution_wall_ms,
            "commandCpuSeconds": self.command_cpu_seconds,
            "addressSpaceBytes": self.address_space_bytes,
            "uidProcesses": self.uid_processes,
            "openFiles": self.open_files,
            "fileBytes": self.file_bytes,
            "stdoutBytes": self.stdout_bytes,
            "stderrBytes": self.stderr_bytes,
            "snapshotFiles": self.snapshot_files,
            "snapshotBytes": self.snapshot_bytes,
            "tmpBytes": self.tmp_bytes,
            "scratchBytes": self.scratch_bytes,
        }

    def sandbox_limits(self, *, execution: bool) -> Limits:
        return Limits(
            wall_seconds=(self.execution_wall_ms if execution else self.session_wall_ms) / 1000,
            cpu_seconds=self.command_cpu_seconds,
            address_space_bytes=self.address_space_bytes,
            uid_processes=self.uid_processes,
            open_files=self.open_files,
            file_bytes=self.file_bytes,
            stdout_bytes=self.stdout_bytes,
            stderr_bytes=self.stderr_bytes,
            tmp_bytes=self.tmp_bytes,
            scratch_bytes=self.scratch_bytes,
        )


@dataclass(frozen=True)
class ApprovedRoot:
    id: str
    path: Path
    kinds: frozenset[str]
    allowed_uids: frozenset[int]
    identity: tuple[int, int]
    source_view: SourceViewPolicy | None = None

    @classmethod
    def parse(cls, value: Any, *, allow_source_view: bool = False) -> "ApprovedRoot":
        expected = {"id", "path", "kinds", "allowedUids"}
        if type(value) is dict and "sourceView" in value:
            if not allow_source_view:
                raise AdmissionError("source views require the control policy v2 catalog")
            expected.add("sourceView")
        raw = _object(value, expected, "approved root")
        root_id = _id(raw["id"], "root id")
        path = checked_directory(raw["path"])
        kinds = _array(raw["kinds"], "root kinds", nonempty=True)
        if any(item not in ("prebuilt", "source") for item in kinds) or len(kinds) != len(set(kinds)):
            raise AdmissionError("root kinds must be unique prebuilt/source values")
        uids = _array(raw["allowedUids"], "allowedUids", nonempty=True)
        if any(type(uid) is not int or uid < 0 for uid in uids) or len(uids) != len(set(uids)):
            raise AdmissionError("allowedUids must contain unique nonnegative integers")
        source_view = None
        if "sourceView" in raw:
            if frozenset(kinds) != frozenset({"source"}):
                raise AdmissionError("source views require a source-only root")
            source_view = SourceViewPolicy.parse(raw["sourceView"])
        info = path.stat()
        return cls(root_id, path, frozenset(kinds), frozenset(uids),
                   (info.st_dev, info.st_ino), source_view)

    def resolve(self, principal_uid: int, relative: str, kind: str) -> Path:
        if principal_uid not in self.allowed_uids or kind not in self.kinds:
            raise AdmissionError("principal is not allowed to use this input root")
        relative = checked_relative_path(relative, "input relativePath")
        current_info = self.path.stat()
        if (current_info.st_dev, current_info.st_ino) != self.identity:
            raise AdmissionError("approved input root identity changed")
        current = self.path
        if relative == ".":
            return current
        for index, part in enumerate(PurePosixPath(relative).parts):
            current = current / part
            try:
                info = current.lstat()
            except OSError as exc:
                raise AdmissionError("approved input is unavailable") from exc
            last = index + 1 == len(PurePosixPath(relative).parts)
            if stat.S_ISLNK(info.st_mode) or (not last and not stat.S_ISDIR(info.st_mode)):
                raise AdmissionError("approved input path contains a symlink or non-directory component")
            if last and not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise AdmissionError("approved input must be a regular file or directory")
        return current


@dataclass(frozen=True)
class BuildPlan:
    id: str
    command: tuple[str, ...]
    cwd: str
    artifact_path: str

    @classmethod
    def parse(cls, value: Any) -> "BuildPlan":
        raw = _object(value, {"id", "command", "cwd", "artifactPath"}, "build plan")
        return cls(_id(raw["id"], "build plan id"), _command(raw["command"], "build command"),
                   checked_relative_path(raw["cwd"], "build cwd"),
                   checked_relative_path(raw["artifactPath"], "build artifactPath"))


@dataclass(frozen=True)
class ToolPlan:
    id: str
    command: tuple[str, ...]
    argument_mode: str

    @classmethod
    def parse(cls, value: Any) -> "ToolPlan":
        raw = _object(value, {"id", "command", "argumentMode"}, "tool plan")
        if raw["argumentMode"] not in ("none", "append"):
            raise AdmissionError("tool argumentMode must be none or append")
        return cls(_id(raw["id"], "tool id"), _command(raw["command"], "tool command"), raw["argumentMode"])

    def argv(self, arguments: Any) -> tuple[str, ...]:
        if type(arguments) is not list or len(arguments) > 256:
            raise AdmissionError("tool arguments must be a bounded array")
        if any(type(arg) is not str or not arg or "\0" in arg for arg in arguments):
            raise AdmissionError("tool arguments contain invalid values")
        try:
            encoded_size = sum(len(arg.encode("utf-8")) for arg in arguments)
        except UnicodeError as exc:
            raise AdmissionError("tool arguments must contain Unicode scalars") from exc
        if encoded_size > 65_535:
            raise AdmissionError("tool arguments exceed the byte limit")
        if self.argument_mode == "none" and arguments:
            raise AdmissionError("this tool does not accept request arguments")
        return self.command + tuple(arguments)


@dataclass(frozen=True)
class NodeShimPlan:
    root: Path
    worker_path: str
    protocol_path: str

    @classmethod
    def parse(cls, value: Any) -> "NodeShimPlan":
        raw = _object(value, {"root", "workerPath", "protocolPath"}, "node shim")
        return cls(checked_directory(raw["root"]),
                   checked_relative_path(raw["workerPath"], "node workerPath"),
                   checked_relative_path(raw["protocolPath"], "node protocolPath"))


@dataclass(frozen=True)
class RuntimePlan:
    id: str
    kind: str
    runtime_mounts: tuple[RuntimeMount, ...]
    command: tuple[str, ...]
    artifact_entry: str
    node_shim: NodeShimPlan | None
    descriptor_schema: str
    adapter_id: str
    target_profile: str
    state_computer_contract_version: str

    @classmethod
    def parse(cls, value: Any) -> "RuntimePlan":
        raw = value if type(value) is dict else {}
        kind = raw.get("kind")
        expected = {"id", "kind", "runtimeMounts", "command", "artifactEntry",
                    "descriptorSchema", "adapterId", "targetProfile",
                    "stateComputerContractVersion"}
        if kind == "node":
            expected.add("nodeShim")
        _object(raw, expected, "runtime plan")
        if kind not in ("node", "rust"):
            raise AdmissionError("runtime kind must be node or rust")
        mounts_raw = _array(raw["runtimeMounts"], "runtimeMounts", nonempty=True)
        mounts = []
        for value in mounts_raw:
            mount = _object(value, {"source", "destination"}, "runtime mount")
            mounts.append(RuntimeMount(mount["source"], mount["destination"]).checked())
        if len({mount.destination for mount in mounts}) != len(mounts) or "/usr" not in {mount.destination for mount in mounts}:
            raise AdmissionError("runtime mounts must be unique and include /usr")
        command = _command(raw["command"], "runtime command")
        entry = checked_relative_path(raw["artifactEntry"], "runtime artifactEntry")
        artifact_sandbox_path = "/artifact/" + entry if entry != "." else "/artifact"
        if kind == "rust" and command[0] != artifact_sandbox_path:
            raise AdmissionError("rust launch must start at the fixed artifact entry")
        if kind == "node" and artifact_sandbox_path not in command:
            raise AdmissionError("node launch must name the fixed adapter entry")
        manifest_path = "/runtime/mirrorgate-manifest/port.json"
        if manifest_path not in command:
            raise AdmissionError("runtime command must use the frozen public manifest mount")
        shim = NodeShimPlan.parse(raw["nodeShim"]) if kind == "node" else None
        if shim is not None:
            shim_entry = "/runtime/mirrorgate-node-shim/" + shim.worker_path
            if len(command) < 2 or command[1] != shim_entry or command[0].startswith("/artifact"):
                raise AdmissionError("node launch must start the trusted shim through an approved runtime")
        for field in ("descriptorSchema", "adapterId", "targetProfile", "stateComputerContractVersion"):
            _opaque_ascii(raw[field], field)
        runtime_id = _id(raw["id"], "runtime id")
        if runtime_id != kind + "-v1":
            raise AdmissionError("runtime ID must match the frozen worker profile")
        return cls(runtime_id, kind, tuple(mounts), command, entry, shim,
                   raw["descriptorSchema"], raw["adapterId"], raw["targetProfile"],
                   raw["stateComputerContractVersion"])


@dataclass(frozen=True)
class ControlPolicy:
    id: str
    roots: dict[str, ApprovedRoot]
    build_plans: dict[str, BuildPlan]
    tools: dict[str, ToolPlan]
    runtimes: dict[str, RuntimePlan]
    limits: ControlLimits
    agent_profile_ids: tuple[str, ...] = ()

    @classmethod
    def parse(cls, value: Any, *, allow_source_view: bool = False) -> "ControlPolicy":
        raw = _object(value, {"id", "roots", "buildPlans", "tools", "runtimes", "limits"}, "policy")
        roots = _unique([ApprovedRoot.parse(item, allow_source_view=allow_source_view)
                         for item in _array(raw["roots"], "roots", nonempty=True)], "root")
        builds = _unique([BuildPlan.parse(item) for item in _array(raw["buildPlans"], "buildPlans")], "build plan")
        tools = _unique([ToolPlan.parse(item) for item in _array(raw["tools"], "tools")], "tool")
        runtimes = _unique([RuntimePlan.parse(item) for item in _array(raw["runtimes"], "runtimes", nonempty=True)], "runtime")
        return cls(_id(raw["id"], "policy id"), roots, builds, tools, runtimes, ControlLimits.parse(raw["limits"]))


class PolicyCatalog:
    """Immutable ID catalog selected by control requests."""

    def __init__(self, policies: dict[str, ControlPolicy], agent_profiles=None):
        self._policies = policies
        self.agent_profiles = {} if agent_profiles is None else agent_profiles

    @classmethod
    def from_document(cls, value: Any) -> "PolicyCatalog":
        if type(value) is dict and value.get("schema") == "mirrorgate.control-policy/v2":
            from dataclasses import replace
            from .agent_policy import AgentProfile
            raw = _object(value, {"schema", "policies", "agentProfiles"}, "policy catalog v2")
            profiles = _unique([AgentProfile.parse(item) for item in _array(raw["agentProfiles"], "agentProfiles")], "agent profile")
            parsed = []
            for item in _array(raw["policies"], "policies", nonempty=True):
                item = _object(item, {"id", "roots", "buildPlans", "tools", "runtimes", "limits", "agentProfileIds"}, "policy v2")
                ids = _array(item["agentProfileIds"], "agentProfileIds")
                if any(type(key) is not str or key not in profiles for key in ids) or len(ids) != len(set(ids)):
                    raise AdmissionError("policy agent profile references must be unique approved IDs")
                base = {key: val for key, val in item.items() if key != "agentProfileIds"}
                parsed.append(replace(ControlPolicy.parse(base, allow_source_view=True),
                                      agent_profile_ids=tuple(ids)))
            return cls(_unique(parsed, "policy"), profiles)
        raw = _object(value, {"schema", "policies"}, "policy catalog")
        if raw["schema"] != CATALOG_SCHEMA:
            raise AdmissionError("unsupported control policy schema")
        policies = _unique([ControlPolicy.parse(item) for item in _array(raw["policies"], "policies", nonempty=True)], "policy")
        return cls(policies)

    @classmethod
    def from_file(cls, path: str | Path) -> "PolicyCatalog":
        try:
            text = Path(path).read_text(encoding="utf-8")
            def pairs(items):
                result = {}
                for key, value in items:
                    if key in result:
                        raise AdmissionError("duplicate control policy field")
                    result[key] = value
                return result
            value = json.loads(text, object_pairs_hook=pairs,
                               parse_constant=lambda _x: (_ for _ in ()).throw(AdmissionError("nonfinite policy number")))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise AdmissionError("control policy file is not strict UTF-8 JSON") from exc
        return cls.from_document(value)

    def agent_profile(self, policy_id: str, profile_id: str):
        policy = self.select(policy_id)
        if type(profile_id) is not str or profile_id not in policy.agent_profile_ids:
            raise AdmissionError("agent profile is not approved by this policy")
        return self.agent_profiles[profile_id]

    def select(self, policy_id: str) -> ControlPolicy:
        _id(policy_id, "policy id")
        try:
            return self._policies[policy_id]
        except KeyError as exc:
            raise AdmissionError("requested policy is not approved") from exc


def example_policy_document(*, submission_root: str | Path, node_shim_root: str | Path,
                            node_runtime_root: str | Path | None = None,
                            principal_uid: int | None = None,
                            adapter_entry: str = "adapter.mjs",
                            policy_id: str = "test.node",
                            adapter_id: str = "mirrorgate/node-v1",
                            target_profile: str = "node-v1",
                            state_computer_contract_version: str = "mirrors.state-computer/v1") -> dict[str, Any]:
    """Build the shared runnable Node policy fixture used by native SDK tests."""
    runtime_root = Path(node_runtime_root or os.environ.get("MIRRORGATE_NODE_RUNTIME_ROOT", "/usr/local"))
    uid = os.getuid() if principal_uid is None else principal_uid
    adapter_entry = checked_relative_path(adapter_entry, "adapter entry")
    limits = {
        "sessionWallMs": 600_000, "executionWallMs": 30_000,
        "commandCpuSeconds": 20, "addressSpaceBytes": 4 * 1024**3,
        "uidProcesses": 4096, "openFiles": 128, "fileBytes": 64 * 1024**2,
        "stdoutBytes": 4 * 1024**2, "stderrBytes": 1024**2,
        "snapshotFiles": 10_000, "snapshotBytes": 512 * 1024**2,
        "tmpBytes": 64 * 1024**2, "scratchBytes": 256 * 1024**2,
    }
    return {
        "schema": CATALOG_SCHEMA,
        "policies": [{
            "id": policy_id,
            "roots": [{"id": "submission", "path": str(Path(submission_root).resolve()),
                       "kinds": ["prebuilt", "source"], "allowedUids": [uid]}],
            "buildPlans": [{"id": "copy", "command": ["/usr/bin/cp", "-a", "/source/.", "/output/"],
                            "cwd": ".", "artifactPath": "."}],
            "tools": [{"id": "python", "command": ["/usr/bin/python3"], "argumentMode": "append"}],
            "runtimes": [{
                "id": "node-v1", "kind": "node",
                "runtimeMounts": [{"source": "/usr", "destination": "/usr"},
                                  {"source": str(runtime_root.resolve()), "destination": "/runtime/node"}],
                "command": ["/runtime/node/bin/node",
                            "/runtime/mirrorgate-node-shim/runtimes/node/worker.mjs",
                            "--manifest", "/runtime/mirrorgate-manifest/port.json",
                            "--adapter", "/artifact/" + adapter_entry],
                "artifactEntry": adapter_entry,
                "descriptorSchema": "mirrors.model-interface-descriptor/v1",
                "adapterId": adapter_id,
                "targetProfile": target_profile,
                "stateComputerContractVersion": state_computer_contract_version,
                "nodeShim": {"root": str(Path(node_shim_root).resolve()),
                             "workerPath": "runtimes/node/worker.mjs",
                             "protocolPath": "sdk/node/protocol.mjs"},
            }],
            "limits": limits,
        }],
    }


def example_rust_policy_document(*, submission_root: str | Path,
                                 principal_uid: int | None = None,
                                 artifact_entry: str = "worker",
                                 faulty: bool = False,
                                 policy_id: str | None = None,
                                 adapter_id: str = "mirrorgate/rust-v1",
                                 target_profile: str = "rust-v1",
                                 state_computer_contract_version: str = "mirrors.state-computer/v1") -> dict[str, Any]:
    """Build the shared runnable prebuilt Rust worker policy fixture."""
    uid = os.getuid() if principal_uid is None else principal_uid
    artifact_entry = checked_relative_path(artifact_entry, "Rust artifact entry")
    limits = {
        "sessionWallMs": 600_000, "executionWallMs": 30_000,
        "commandCpuSeconds": 20, "addressSpaceBytes": 4 * 1024**3,
        "uidProcesses": 4096, "openFiles": 128, "fileBytes": 64 * 1024**2,
        "stdoutBytes": 4 * 1024**2, "stderrBytes": 1024**2,
        "snapshotFiles": 10_000, "snapshotBytes": 512 * 1024**2,
        "tmpBytes": 64 * 1024**2, "scratchBytes": 256 * 1024**2,
    }
    return {
        "schema": CATALOG_SCHEMA,
        "policies": [{
            "id": policy_id or ("test.rust-faulty" if faulty else "test.rust"),
            "roots": [{"id": "submission", "path": str(Path(submission_root).resolve()),
                       "kinds": ["prebuilt"], "allowedUids": [uid]}],
            "buildPlans": [], "tools": [],
            "runtimes": [{
                "id": "rust-v1", "kind": "rust",
                "runtimeMounts": [{"source": "/usr", "destination": "/usr"}],
                "command": (["/artifact/" + artifact_entry,
                             "--manifest", "/runtime/mirrorgate-manifest/port.json"]
                            + (["--faulty"] if faulty else [])),
                "artifactEntry": artifact_entry,
                "descriptorSchema": "mirrors.model-interface-descriptor/v1",
                "adapterId": adapter_id,
                "targetProfile": target_profile,
                "stateComputerContractVersion": state_computer_contract_version,
            }],
            "limits": limits,
        }],
    }


def example_shared_policy_document(*, submission_root: str | Path,
                                   node_shim_root: str | Path,
                                   node_runtime_root: str | Path | None = None,
                                   principal_uid: int | None = None,
                                   node_adapter_entry: str = "adapter.mjs",
                                   rust_artifact_entry: str = "worker",
                                   include_faulty_rust: bool = False) -> dict[str, Any]:
    """Build one catalog containing native-client Node and Rust test policies."""
    node = example_policy_document(
        submission_root=submission_root, node_shim_root=node_shim_root,
        node_runtime_root=node_runtime_root, principal_uid=principal_uid,
        adapter_entry=node_adapter_entry)
    rust = example_rust_policy_document(
        submission_root=submission_root, principal_uid=principal_uid,
        artifact_entry=rust_artifact_entry)
    policies = node["policies"] + rust["policies"]
    if include_faulty_rust:
        policies += example_rust_policy_document(
            submission_root=submission_root, principal_uid=principal_uid,
            artifact_entry=rust_artifact_entry, faulty=True)["policies"]
    return {"schema": CATALOG_SCHEMA, "policies": policies}
