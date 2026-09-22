"""Descriptor-pinned optional cgroup-v2 aggregate quota backend."""
from __future__ import annotations
from dataclasses import dataclass
import ctypes, os, secrets, stat, time
from pathlib import Path
from typing import Any
from .policy import AdmissionError

CGROUP2_SUPER_MAGIC = 0x63677270
REQUIRED_CONTROLLERS = frozenset(("cpu", "memory", "pids"))
REQUIRED_CHILD_FILES = frozenset(
    ("cgroup.procs", "cgroup.events", "cgroup.kill", "cpu.max", "cpu.stat",
     "memory.max", "memory.current", "memory.events", "pids.max",
     "pids.current", "pids.events"))


@dataclass(frozen=True)
class AggregateLimits:
    pids_max: int
    memory_max: int
    cpu_quota_us: int
    cpu_period_us: int


class _StatFs(ctypes.Structure):
    _fields_ = [("f_type", ctypes.c_long), ("rest", ctypes.c_byte * 248)]


def _is_cgroup2_fd(fd: int) -> bool:
    value = _StatFs()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.fstatfs(fd, ctypes.byref(value)) != 0:
        raise OSError(ctypes.get_errno(), "fstatfs failed")
    return value.f_type == CGROUP2_SUPER_MAGIC


def _read_at(fd: int, name: str, maximum: int = 65536) -> str:
    item = os.open(name,
                   os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOFOLLOW,
                   dir_fd=fd)
    try:
        info = os.fstat(item)
        if not stat.S_ISREG(info.st_mode):
            raise AdmissionError("cgroup controller is not regular")
        data = os.read(item, maximum + 1)
        if len(data) > maximum:
            raise AdmissionError("cgroup controller exceeds bound")
        return data.decode("ascii").strip()
    finally:
        os.close(item)


def _write_at(fd: int, name: str, value: str) -> None:
    item = os.open(name,
                   os.O_WRONLY | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOFOLLOW,
                   dir_fd=fd)
    try:
        if not stat.S_ISREG(os.fstat(item).st_mode):
            raise AdmissionError("cgroup controller is not regular")
        data = (value + "\n").encode("ascii")
        written = os.write(item, data)
        if written != len(data):
            raise AdmissionError("short cgroup controller write")
    finally:
        os.close(item)


class CgroupDelegation:

    def __init__(self, parent: str | Path, *, require_cgroupfs: bool = True):
        self.path = Path(parent)
        self.fd = -1
        if not self.path.is_absolute():
            raise AdmissionError("cgroup parent must be absolute")
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
        fd = os.open("/", flags)
        try:
            for part in self.path.parts[1:]:
                nxt = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = nxt
            info = os.fstat(fd)
            if info.st_uid != os.geteuid(
            ) or require_cgroupfs and not _is_cgroup2_fd(fd):
                raise AdmissionError(
                    "cgroup parent is not a serving-UID cgroup-v2 delegation")
            controllers = frozenset(_read_at(fd, "cgroup.controllers").split())
            enabled = frozenset(
                x.lstrip("+")
                for x in _read_at(fd, "cgroup.subtree_control").split())
            if not REQUIRED_CONTROLLERS <= controllers or not REQUIRED_CONTROLLERS <= enabled:
                raise AdmissionError(
                    "delegated cgroup lacks enabled cpu/memory/pids controllers"
                )
            self.fd = fd
            self.identity = (info.st_dev, info.st_ino)
        except BaseException:
            os.close(fd)
            raise

    def _validate(self):
        info = os.fstat(self.fd)
        if (info.st_dev, info.st_ino) != self.identity:
            raise AdmissionError("delegation identity changed")

    def probe(self) -> None:
        child = self.create("probe",
                            AggregateLimits(1, 16 * 1024 * 1024, 1000, 100000))
        child.cleanup(timeout=.2)

    def create(self, session_id: str, limits: AggregateLimits):
        self._validate()
        if not session_id or any(
                c not in
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
                for c in session_id):
            raise AdmissionError("invalid cgroup session identity")
        name = "mirrorgate-" + secrets.token_hex(16)
        os.mkdir(name, 0o700, dir_fd=self.fd)
        try:
            child_fd = os.open(name,
                               os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
                               | os.O_NOFOLLOW,
                               dir_fd=self.fd)
            missing = [
                n for n in REQUIRED_CHILD_FILES if not _exists_at(child_fd, n)
            ]
            if missing:
                raise AdmissionError(
                    "delegated child lacks required controllers")
            _write_at(child_fd, "pids.max", str(limits.pids_max))
            _write_at(child_fd, "memory.max", str(limits.memory_max))
            _write_at(child_fd, "cpu.max",
                      f"{limits.cpu_quota_us} {limits.cpu_period_us}")
            expected = {
                "pids.max": str(limits.pids_max),
                "memory.max": str(limits.memory_max),
                "cpu.max": f"{limits.cpu_quota_us} {limits.cpu_period_us}",
            }
            for controller, value in expected.items():
                if _read_at(child_fd, controller) != value:
                    raise AdmissionError(
                        "kernel did not apply the requested aggregate limit")
            return CgroupSession(self, name, session_id, limits, child_fd)
        except BaseException:
            try:
                os.rmdir(name, dir_fd=self.fd)
            except OSError:
                pass
            raise

    def close(self):
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1


def _exists_at(fd, name):
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False


class CgroupSession:

    def __init__(self, delegation, name, session_id, limits, fd):
        self.delegation = delegation
        self.name = name
        self.session_id = session_id
        self.limits = limits
        self.fd = fd
        info = os.fstat(fd)
        self.identity = (info.st_dev, info.st_ino)
        self.path = delegation.path / name
        self._cleanup_observations = None

    def _validate(self):
        info = os.fstat(self.fd)
        current = os.stat(self.name,
                          dir_fd=self.delegation.fd,
                          follow_symlinks=False)
        if (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino) or (
                info.st_dev, info.st_ino) != self.identity:
            raise AdmissionError("cgroup session identity changed")

    def join(self, pid):
        self._validate()
        _write_at(self.fd, "cgroup.procs", str(pid))

    def observe(self) -> dict[str, Any]:
        self._validate()
        return {
            n: (_read_at(self.fd, n) if _exists_at(self.fd, n) else None)
            for n in ("pids.current", "pids.events", "memory.current",
                      "memory.peak", "memory.events", "cpu.stat",
                      "cgroup.events")
        }

    def settings(self) -> dict[str, str | None]:
        """Return the closed aggregate-limit settings used by recovery receipts."""
        self._validate()
        return {
            name: (_read_at(self.fd, name) if _exists_at(self.fd, name) else None)
            for name in ("pids.max", "memory.max", "memory.swap.max", "cpu.max")
        }

    def cleanup(self, *, timeout=5.0):
        if self.fd < 0: return dict(self._cleanup_observations or {})
        self._validate()
        _write_at(self.fd, "cgroup.kill", "1")
        deadline = time.monotonic() + max(0, timeout)
        while time.monotonic() < deadline:
            events = _read_at(self.fd, "cgroup.events")
            if any(line.split() == ["populated", "0"]
                   for line in events.splitlines()):
                result = self.observe()
                os.rmdir(self.name, dir_fd=self.delegation.fd)
                os.close(self.fd)
                self.fd = -1
                self._cleanup_observations = dict(result)
                return result
            time.sleep(.02)
        raise AdmissionError(
            "cgroup population did not become empty before deadline")
