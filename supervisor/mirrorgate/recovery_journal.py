"""Crash-consistent private ownership journal for offline Gate recovery."""
from __future__ import annotations

from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import stat
import threading
from typing import Any, Callable

from .policy import AdmissionError


SCHEMA = "mirrorgate.recovery-journal/v1"
MAX_RECORD_BYTES = 64 * 1024
MAX_RECORDS = 4096
MAX_STRING = 512
KINDS = frozenset(("filesystem", "process", "cgroup", "retained_source"))
PHASES = frozenset(("allocation_intent", "durable_owned", "active",
                    "cleanup_intent", "reclaimed", "retained_by_policy",
                    "ambiguous", "cleanup_failed"))
TRANSITIONS = {
    "allocation_intent": frozenset(("durable_owned", "retained_by_policy",
                                     "cleanup_intent", "ambiguous")),
    "durable_owned": frozenset(("active", "cleanup_intent", "retained_by_policy",
                                 "ambiguous")),
    "active": frozenset(("cleanup_intent", "retained_by_policy", "ambiguous")),
    "cleanup_intent": frozenset(("reclaimed", "cleanup_failed", "ambiguous")),
    "cleanup_failed": frozenset(("cleanup_intent", "ambiguous")),
    "retained_by_policy": frozenset(("cleanup_intent", "ambiguous")),
    "ambiguous": frozenset(),
    "reclaimed": frozenset(),
}
TOP_FIELDS = frozenset(("schema", "sequence", "controllerInstance", "bootId",
                        "principalUid", "sessionId", "resourceId", "kind",
                        "phase", "stage", "identity", "retainedRecoverable",
                        "observations", "stateRoot", "cleanupTarget", "checksum"))
ROOT_IDENTITY_FIELDS = frozenset(("device", "inode", "uid"))
IDENTITY_FIELDS = {
    "filesystem": frozenset(("relativePath", "device", "inode", "mode", "ctimeNs",
                              "ownershipToken")),
    "retained_source": frozenset(("relativePath", "device", "inode", "mode", "ctimeNs",
                                   "ownershipToken")),
    "process": frozenset(("pid", "startTime", "bootId", "cgroup")),
    "cgroup": frozenset(("relativePath", "device", "inode", "mode")),
}
OBSERVATION_FIELDS = frozenset(("attemptId", "status", "reasonCode"))
OBSERVATION_STATUSES = frozenset(("unconfirmed", "recovered", "failed", "ambiguous"))


class JournalError(AdmissionError):
    pass


class JournalBusy(JournalError):
    pass


def _synchronized(method):
    def locked(self, *args, **kwargs):
        with self._mutex:
            return method(self, *args, **kwargs)
    return locked


@dataclass(frozen=True)
class InvalidRecord:
    name: str
    reason: str


@dataclass(frozen=True)
class JournalSnapshot:
    records: tuple[dict[str, Any], ...]
    invalid: tuple[InvalidRecord, ...]


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise JournalError("duplicate JSON field")
        result[key] = value
    return result


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"),
                      sort_keys=True).encode("ascii")


def _text(value: Any, label: str, *, maximum: int = MAX_STRING) -> str:
    if type(value) is not str or not value or len(value.encode("utf-8")) > maximum:
        raise JournalError(f"invalid {label}")
    return value


def _opaque(value: Any, label: str) -> str:
    text = _text(value, label, maximum=128)
    if text[0] == "." or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
                             for ch in text):
        raise JournalError(f"invalid {label}")
    return text


def checked_relative_path(value: Any) -> str:
    text = _text(value, "relative path")
    raw_parts = text.split("/")
    if text.startswith("/") or any(part in ("", ".", "..") for part in raw_parts):
        raise JournalError("invalid relative path")
    path = PurePosixPath(*raw_parts)
    return path.as_posix()


def filesystem_identity(root: Path, path: Path) -> dict[str, Any]:
    try:
        relative = path.relative_to(root).as_posix()
    except ValueError as exc:
        raise JournalError("resource is outside the state root") from exc
    relative = checked_relative_path(relative)
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode):
        raise JournalError("recoverable filesystem resource must be a directory")
    attribute = "user.mirrorgate.identity"
    try:
        token = os.getxattr(path, attribute, follow_symlinks=False).decode("ascii")
    except OSError:
        token = secrets.token_hex(32)
        original_mode = stat.S_IMODE(info.st_mode)
        try:
            if not original_mode & stat.S_IWUSR:
                os.chmod(path, original_mode | stat.S_IWUSR, follow_symlinks=False)
            os.setxattr(path, attribute, token.encode("ascii"), follow_symlinks=False)
        except OSError as exc:
            raise JournalError("filesystem ownership token is unavailable") from exc
        finally:
            if stat.S_IMODE(os.stat(path, follow_symlinks=False).st_mode) != original_mode:
                os.chmod(path, original_mode, follow_symlinks=False)
        info = os.stat(path, follow_symlinks=False)
    if len(token) != 64 or any(ch not in "0123456789abcdef" for ch in token):
        raise JournalError("filesystem ownership token is invalid")
    return {"relativePath": relative, "device": info.st_dev, "inode": info.st_ino,
            "mode": stat.S_IFMT(info.st_mode), "ctimeNs": info.st_ctime_ns,
            "ownershipToken": token}


def host_boot_id() -> str:
    path = Path("/proc/sys/kernel/random/boot_id")
    try:
        value = path.read_text(encoding="ascii").strip().lower()
    except OSError as exc:
        raise JournalError("host boot identity is unavailable") from exc
    if len(value) != 36 or any(ch not in "0123456789abcdef-" for ch in value):
        raise JournalError("host boot identity is invalid")
    return value


def validate_state_root(path: str | Path, *, uid: int | None = None) -> tuple[Path, int]:
    root = Path(path)
    if not root.is_absolute():
        raise JournalError("state root must be absolute")
    expected_uid = os.geteuid() if uid is None else uid
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open("/", flags)
    try:
        for part in root.parts[1:]:
            nxt = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = nxt
    except OSError as exc:
        os.close(fd)
        raise JournalError("state root cannot be pinned") from exc
    info = os.fstat(fd)
    if info.st_uid != expected_uid or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(fd)
        raise JournalError("state root must be owned by the serving UID with mode 0700")
    return root, fd


def _validate_identity(kind: str, phase: str, value: Any) -> dict[str, Any]:
    if type(value) is not dict:
        raise JournalError("identity must be an object")
    allowed = IDENTITY_FIELDS[kind]
    if set(value) - allowed:
        raise JournalError("identity contains unknown fields")
    if phase in ("allocation_intent", "ambiguous") and not value:
        return {}
    if set(value) != allowed:
        raise JournalError("identity fields are incomplete")
    result = dict(value)
    if kind in ("filesystem", "retained_source"):
        result["relativePath"] = checked_relative_path(result["relativePath"])
        for name in ("device", "inode", "mode", "ctimeNs"):
            if type(result[name]) is not int or result[name] < 0:
                raise JournalError("filesystem identity is invalid")
        token = _opaque(result["ownershipToken"], "filesystem ownership token")
        if len(token) != 64 or any(ch not in "0123456789abcdef" for ch in token):
            raise JournalError("filesystem ownership token is invalid")
    elif kind == "cgroup":
        result["relativePath"] = checked_relative_path(result["relativePath"])
        for name in ("device", "inode", "mode"):
            if type(result[name]) is not int or result[name] < 0:
                raise JournalError("cgroup identity is invalid")
    else:
        if type(result["pid"]) is not int or result["pid"] <= 0:
            raise JournalError("process PID observation is invalid")
        _text(result["startTime"], "process start time")
        _text(result["bootId"], "process boot identity")
        _text(result["cgroup"], "process cgroup", maximum=1024)
    return result


def validate_record(value: Any, *, expected_name: str | None = None) -> dict[str, Any]:
    if type(value) is not dict or set(value) != TOP_FIELDS:
        raise JournalError("record fields are not closed")
    if value["schema"] != SCHEMA:
        raise JournalError("unsupported journal version")
    if type(value["sequence"]) is not int or value["sequence"] <= 0:
        raise JournalError("invalid record sequence")
    _opaque(value["controllerInstance"], "controller instance")
    _text(value["bootId"], "bootId")
    _opaque(value["sessionId"], "session ID")
    _opaque(value["resourceId"], "resource ID")
    _opaque(value["stage"], "stage")
    if expected_name is not None and value["resourceId"] + ".json" != expected_name:
        raise JournalError("record filename does not match resource identity")
    if type(value["principalUid"]) is not int or value["principalUid"] < 0:
        raise JournalError("invalid principal UID")
    kind = value["kind"]
    phase = value["phase"]
    if type(kind) is not str or type(phase) is not str or kind not in KINDS or phase not in PHASES:
        raise JournalError("invalid resource kind or phase")
    identity = _validate_identity(kind, phase, value["identity"])
    if type(value["retainedRecoverable"]) is not bool:
        raise JournalError("invalid retained policy")
    root_identity = value["stateRoot"]
    if type(root_identity) is not dict or set(root_identity) != ROOT_IDENTITY_FIELDS:
        raise JournalError("invalid state-root identity")
    for name in ROOT_IDENTITY_FIELDS:
        if type(root_identity[name]) is not int or root_identity[name] < 0:
            raise JournalError("invalid state-root identity")
    cleanup_target = value["cleanupTarget"]
    if cleanup_target is not None:
        cleanup_target = checked_relative_path(cleanup_target)
        if not cleanup_target.startswith("quarantine/reclaim-"):
            raise JournalError("cleanup target is outside quarantine")
    if kind == "retained_source" and phase in ("cleanup_intent", "cleanup_failed", "reclaimed") and not value["retainedRecoverable"]:
        raise JournalError("retained source cleanup lacks explicit policy")
    observations = value["observations"]
    if type(observations) is not list or len(observations) > 64:
        raise JournalError("invalid observation list")
    checked_observations = []
    for observation in observations:
        if type(observation) is not dict or set(observation) != OBSERVATION_FIELDS:
            raise JournalError("observation fields are not closed")
        if observation["status"] not in OBSERVATION_STATUSES:
            raise JournalError("invalid observation status")
        _text(observation["attemptId"], "recovery attempt")
        reason = observation["reasonCode"]
        if reason is not None:
            _text(reason, "reason code", maximum=128)
        checked_observations.append(dict(observation))
    checksum = value["checksum"]
    if type(checksum) is not str or len(checksum) != 64 or any(ch not in "0123456789abcdef" for ch in checksum):
        raise JournalError("invalid checksum")
    payload = {key: item for key, item in value.items() if key != "checksum"}
    if not secrets.compare_digest(hashlib.sha256(_canonical(payload)).hexdigest(), checksum):
        raise JournalError("record checksum mismatch")
    result = dict(value)
    result["identity"] = identity
    result["cleanupTarget"] = cleanup_target
    result["observations"] = checked_observations
    return result


def encode_record(payload: dict[str, Any]) -> bytes:
    body = dict(payload)
    body["checksum"] = hashlib.sha256(_canonical(body)).hexdigest()
    validate_record(body)
    encoded = _canonical(body) + b"\n"
    if len(encoded) > MAX_RECORD_BYTES:
        raise JournalError("record exceeds byte limit")
    return encoded


def _bounded_json(value: Any, *, depth: int = 0, budget: list[int] | None = None) -> None:
    if budget is None:
        budget = [0]
    budget[0] += 1
    if depth > 10 or budget[0] > 2048:
        raise JournalError("journal JSON exceeds structural bounds")
    if value is None or type(value) is bool:
        return
    if type(value) is int:
        if abs(value) > 2**63 - 1:
            raise JournalError("journal integer exceeds bounds")
        return
    if type(value) is str:
        if len(value.encode("utf-8")) > 4096:
            raise JournalError("journal string exceeds bounds")
        return
    if type(value) is list:
        for item in value:
            _bounded_json(item, depth=depth + 1, budget=budget)
        return
    if type(value) is dict:
        for key, item in value.items():
            _bounded_json(key, depth=depth + 1, budget=budget)
            _bounded_json(item, depth=depth + 1, budget=budget)
        return
    raise JournalError("journal JSON type is unsupported")


class RecoveryJournal:
    """Exclusive controller/recoverer lease plus atomic record publication."""

    def __init__(self, state_root: str | Path, *, role: str,
                 fault: Callable[[str], None] | None = None,
                 initialize: bool = True):
        if role not in ("controller", "recoverer"):
            raise JournalError("invalid journal role")
        self.root, self.root_fd = validate_state_root(state_root)
        self.role = role
        self.fault = fault
        self.controller_instance = secrets.token_hex(16)
        self.boot_id = host_boot_id()
        self.principal_uid = os.geteuid()
        root_info = os.fstat(self.root_fd)
        self.state_root_identity = {"device": root_info.st_dev,
                                    "inode": root_info.st_ino,
                                    "uid": root_info.st_uid}
        self._closed = False
        self._mutex = threading.RLock()
        self._lock_fd = -1
        self.journal_fd = -1
        self.quarantine_fd = -1
        self.resources_fd = -1
        self.journal_dir = self.root / "journal"
        self.quarantine_dir = self.root / "quarantine"
        self.resources_dir = self.root / "resources"
        try:
            lock_flags = os.O_RDWR | os.O_CLOEXEC | os.O_NONBLOCK
            if initialize:
                lock_flags |= os.O_CREAT
            if hasattr(os, "O_NOFOLLOW"):
                lock_flags |= os.O_NOFOLLOW
            self._lock_fd = os.open("owner.lock", lock_flags, 0o600, dir_fd=self.root_fd)
            lock_info = os.fstat(self._lock_fd)
            if (not stat.S_ISREG(lock_info.st_mode)
                    or lock_info.st_uid != self.principal_uid
                    or stat.S_IMODE(lock_info.st_mode) != 0o600):
                raise JournalError("state-root lock mode is invalid")
            fcntl.flock(self._lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if initialize:
                for name in ("journal", "quarantine", "resources"):
                    try:
                        os.mkdir(name, mode=0o700, dir_fd=self.root_fd)
                    except FileExistsError:
                        pass
                os.fsync(self.root_fd)
            child_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
            if hasattr(os, "O_NOFOLLOW"):
                child_flags |= os.O_NOFOLLOW
            self.journal_fd = os.open("journal", child_flags, dir_fd=self.root_fd)
            self.quarantine_fd = os.open("quarantine", child_flags, dir_fd=self.root_fd)
            self.resources_fd = os.open("resources", child_flags, dir_fd=self.root_fd)
            for fd in (self.journal_fd, self.quarantine_fd, self.resources_fd):
                info = os.fstat(fd)
                if info.st_uid != self.principal_uid or stat.S_IMODE(info.st_mode) != 0o700:
                    raise JournalError("state-root child mode is invalid")
        except BlockingIOError as exc:
            self.close()
            raise JournalBusy("state root already has a live owner or recoverer") from exc
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        with self._mutex:
            if self._closed:
                return
            self._closed = True
            if self._lock_fd >= 0:
                try:
                    fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
                finally:
                    os.close(self._lock_fd)
                    self._lock_fd = -1
            for name in ("journal_fd", "quarantine_fd", "resources_fd"):
                fd = getattr(self, name)
                if fd >= 0:
                    os.close(fd)
                    setattr(self, name, -1)
            os.close(self.root_fd)

    def __enter__(self) -> "RecoveryJournal":
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()

    def _cut(self, name: str) -> None:
        if self.fault is not None:
            self.fault(name)

    def read(self, resource_id: str) -> dict[str, Any]:
        with self._mutex:
            _opaque(resource_id, "resource ID")
            name = resource_id + ".json"
            try:
                data = _read_regular_at(self.journal_fd, name)
            except OSError as exc:
                raise JournalError("journal record is unavailable") from exc
            return _decode_record(data, name)

    def inspect(self) -> JournalSnapshot:
        with self._mutex:
            return _inspect_journal_fd(self.journal_fd)

    def quarantine_invalid(self, invalid: tuple[InvalidRecord, ...]) -> None:
        """Move malformed records aside without interpreting their contents."""
        with self._mutex:
            journal_fd = os.dup(self.journal_fd)
            quarantine_fd = os.dup(self.quarantine_fd)
            try:
                for item in invalid:
                    name = item.name
                    if not name or "/" in name or name in (".", ".."):
                        continue
                    destination = "invalid-" + secrets.token_hex(16)
                    try:
                        info = os.stat(name, dir_fd=journal_fd, follow_symlinks=False)
                        if not stat.S_ISREG(info.st_mode):
                            continue
                        os.rename(name, destination, src_dir_fd=journal_fd,
                                  dst_dir_fd=quarantine_fd)
                    except FileNotFoundError:
                        continue
                os.fsync(journal_fd)
                os.fsync(quarantine_fd)
            finally:
                os.close(quarantine_fd)
                os.close(journal_fd)

    @_synchronized
    def claim_intent(self, *, session_id: str, resource_id: str, kind: str,
                     stage: str, retained_recoverable: bool = False) -> dict[str, Any]:
        _opaque(session_id, "session ID")
        _opaque(resource_id, "resource ID")
        _opaque(stage, "stage")
        if kind not in KINDS or type(retained_recoverable) is not bool:
            raise JournalError("invalid resource claim")
        snapshot = self.inspect()
        if snapshot.invalid:
            raise JournalError("invalid journal record blocks allocation")
        if len(snapshot.records) >= MAX_RECORDS:
            raise JournalError("journal record count exceeds limit")
        name = resource_id + ".json"
        try:
            os.stat(name, dir_fd=self.journal_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise JournalError("duplicate resource ID")
        record = {
            "schema": SCHEMA, "sequence": 1,
            "controllerInstance": self.controller_instance,
            "bootId": self.boot_id, "principalUid": self.principal_uid,
            "sessionId": session_id, "resourceId": resource_id,
            "kind": kind, "phase": "allocation_intent", "stage": stage,
            "identity": {}, "retainedRecoverable": retained_recoverable,
            "observations": [], "stateRoot": dict(self.state_root_identity),
            "cleanupTarget": None,
        }
        self._publish(record, create=True)
        return self.read(resource_id)

    @_synchronized
    def transition(self, resource_id: str, phase: str, *,
                   identity: dict[str, Any] | None = None,
                   retained_recoverable: bool | None = None,
                   observation: dict[str, Any] | None = None,
                   cleanup_target: str | None = None) -> dict[str, Any]:
        current = self.read(resource_id)
        if phase not in TRANSITIONS[current["phase"]]:
            raise JournalError("invalid journal transition")
        updated = {key: value for key, value in current.items() if key != "checksum"}
        updated["sequence"] += 1
        updated["phase"] = phase
        if identity is not None:
            updated["identity"] = dict(identity)
        if retained_recoverable is not None:
            updated["retainedRecoverable"] = retained_recoverable
        if observation is not None:
            updated["observations"] = [*updated["observations"], dict(observation)]
        if cleanup_target is not None:
            updated["cleanupTarget"] = checked_relative_path(cleanup_target)
        self._publish(updated, create=False)
        return self.read(resource_id)

    @_synchronized
    def set_cleanup_target(self, resource_id: str, cleanup_target: str) -> dict[str, Any]:
        current = self.read(resource_id)
        if current["phase"] != "cleanup_intent" or current["cleanupTarget"] is not None:
            raise JournalError("cleanup target can only be fixed once during cleanup intent")
        updated = {key: value for key, value in current.items() if key != "checksum"}
        updated["sequence"] += 1
        updated["cleanupTarget"] = checked_relative_path(cleanup_target)
        self._publish(updated, create=False)
        return self.read(resource_id)

    @_synchronized
    def begin_cleanup(self, resource_id: str) -> dict[str, Any]:
        current = self.read(resource_id)
        if current["phase"] in ("cleanup_intent", "reclaimed", "ambiguous"):
            return current
        if "cleanup_intent" not in TRANSITIONS[current["phase"]]:
            raise JournalError("resource cannot enter cleanup")
        return self.transition(resource_id, "cleanup_intent")

    @_synchronized
    def finish_cleanup(self, resource_id: str, *, complete: bool) -> dict[str, Any]:
        current = self.read(resource_id)
        if current["phase"] in ("reclaimed", "ambiguous"):
            return current
        target = "reclaimed" if complete else "cleanup_failed"
        if current["phase"] == target:
            return current
        if current["phase"] != "cleanup_intent":
            raise JournalError("cleanup result lacks durable intent")
        return self.transition(resource_id, target)

    @_synchronized
    def _publish(self, payload: dict[str, Any], *, create: bool) -> None:
        if self._closed:
            raise JournalError("journal lease is closed")
        encoded = encode_record(payload)
        final = payload["resourceId"] + ".json"
        if create:
            try:
                os.stat(final, dir_fd=self.journal_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise JournalError("duplicate resource ID")
        temp = ".tmp-" + secrets.token_hex(16)
        fd = -1
        try:
            self._cut("before-open")
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC,
                         0o600, dir_fd=self.journal_fd)
            self._cut("after-open")
            offset = 0
            while offset < len(encoded):
                count = os.write(fd, encoded[offset:])
                if count <= 0:
                    raise JournalError("short journal write")
                offset += count
                self._cut("after-write")
            os.fsync(fd)
            self._cut("after-file-sync")
            os.close(fd)
            fd = -1
            os.replace(temp, final, src_dir_fd=self.journal_fd,
                       dst_dir_fd=self.journal_fd)
            self._cut("after-rename")
            os.fsync(self.journal_fd)
            self._cut("after-directory-sync")
        finally:
            if fd >= 0:
                os.close(fd)
            try:
                os.unlink(temp, dir_fd=self.journal_fd)
            except FileNotFoundError:
                pass


def _read_regular_at(directory_fd: int, name: str) -> bytes:
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(name, flags, dir_fd=directory_fd)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_RECORD_BYTES:
            raise JournalError("journal entry is not a bounded regular file")
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, min(65536, MAX_RECORD_BYTES + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_RECORD_BYTES:
                raise JournalError("journal record exceeds byte limit")
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


def _decode_record(data: bytes, name: str) -> dict[str, Any]:
    if not data or len(data) > MAX_RECORD_BYTES or not data.endswith(b"\n"):
        raise JournalError("journal record is truncated or oversized")
    try:
        value = json.loads(data, object_pairs_hook=_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, JournalError, RecursionError) as exc:
        raise JournalError("journal record is malformed") from exc
    _bounded_json(value)
    return validate_record(value, expected_name=name)


def _inspect_journal_fd(journal_fd: int) -> JournalSnapshot:
    names = []
    with os.scandir(journal_fd) as entries:
        for entry in entries:
            names.append(entry.name)
            if len(names) > MAX_RECORDS:
                raise JournalError("journal record count exceeds limit")
    names.sort()
    records = []
    invalid = []
    seen = set()
    for name in names:
        if name.startswith(".tmp-"):
            invalid.append(InvalidRecord(name, "incomplete_publication"))
            continue
        if not name.endswith(".json") or len(name) > MAX_STRING + 5:
            invalid.append(InvalidRecord(name[:MAX_STRING], "invalid_filename"))
            continue
        try:
            record = _decode_record(_read_regular_at(journal_fd, name), name)
            if record["resourceId"] in seen:
                raise JournalError("duplicate resource ID")
            seen.add(record["resourceId"])
            records.append(record)
        except (OSError, JournalError) as exc:
            invalid.append(InvalidRecord(name, str(exc)[:128]))
    return JournalSnapshot(tuple(records), tuple(invalid))


def inspect_records(state_root: str | Path) -> JournalSnapshot:
    _root, root_fd = validate_state_root(state_root)
    journal_fd = -1
    try:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            journal_fd = os.open("journal", flags, dir_fd=root_fd)
        except OSError as exc:
            raise JournalError("state root journal is unavailable") from exc
        return _inspect_journal_fd(journal_fd)
    finally:
        if journal_fd >= 0:
            os.close(journal_fd)
        os.close(root_fd)
