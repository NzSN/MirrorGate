"""Submission snapshots with fd-relative traversal and deterministic identity."""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import tempfile
import threading
import time
from typing import Hashable

from .policy import AdmissionError, checked_directory


@dataclass(frozen=True)
class FrozenArtifact:
    path: Path
    digest: str
    manifest: tuple[dict, ...]


class FrozenLease:
    """Owner-bound, fd-pinned access to a supervisor-created snapshot.

    Construction is intentionally private to :class:`FrozenStore`.  Consumers
    can duplicate the pinned directory descriptor after proving the same owner;
    they cannot substitute a caller-constructed ``FrozenArtifact``.
    """

    __slots__ = ("_store", "_lease_id", "_owner", "_artifact", "_fd", "_closed")

    def __init__(self, store: "FrozenStore", lease_id: str, owner: Hashable,
                 artifact: FrozenArtifact, fd: int):
        self._store = store
        self._lease_id = lease_id
        self._owner = owner
        self._artifact = artifact
        self._fd = fd
        self._closed = False

    @property
    def lease_id(self) -> str:
        return self._lease_id

    @property
    def digest(self) -> str:
        return self._artifact.digest

    @property
    def manifest(self) -> tuple[dict, ...]:
        return self._artifact.manifest

    def duplicate_fd(self, owner: Hashable) -> int:
        with self._store._lock:
            self._check(owner)
            duplicated = os.dup(self._fd)
            os.set_inheritable(duplicated, False)
            return duplicated

    def _mount_path(self, owner: Hashable) -> Path:
        """Internal mount path; public control records must never expose it."""
        with self._store._lock:
            self._check(owner)
            return self._artifact.path

    def _check(self, owner: Hashable) -> None:
        if self._closed or self._store._leases.get(self._lease_id) is not self:
            raise AdmissionError("frozen artifact lease is closed")
        if owner != self._owner:
            raise AdmissionError("frozen artifact lease owner mismatch")
        opened = os.fstat(self._fd)
        current = os.stat(self._artifact.path, follow_symlinks=False)
        if not stat.S_ISDIR(current.st_mode) or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise AdmissionError("frozen artifact lease identity changed")

    def close(self, owner: Hashable) -> None:
        self._store.release(self, owner)


class FrozenStore:
    """Own snapshots for one control backend and release them deterministically."""

    def __init__(self, parent: str | Path | None = None):
        self._owned = (Path(tempfile.mkdtemp(prefix="mirrorgate-control-"))
                       if parent is None else checked_directory(parent))
        self._remove_owned = parent is None
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._leases: dict[str, FrozenLease] = {}
        self._pending_removals: dict[Path, str | None] = {}
        self._inflight = 0
        self._closed = False

    def freeze(self, owner: Hashable, source: str | Path, *, max_files: int = 10_000,
               max_bytes: int = 512 * 1024**2) -> FrozenLease:
        with self._condition:
            if self._closed:
                raise AdmissionError("frozen artifact store is closed")
            self._inflight += 1
        artifact = None
        fd = None
        try:
            artifact = freeze_path(source, self._owned, max_files=max_files, max_bytes=max_bytes)
            try:
                fd = _open_directory(artifact.path)
            except BaseException:
                remove_snapshot(artifact.path)
                raise
            closed_during_snapshot = False
            with self._lock:
                if self._closed:
                    os.close(fd)
                    fd = None
                    self._pending_removals.setdefault(artifact.path, None)
                    closed_during_snapshot = True
                else:
                    lease_id = secrets.token_hex(16)
                    while lease_id in self._leases:
                        lease_id = secrets.token_hex(16)
                    lease = FrozenLease(self, lease_id, owner, artifact, fd)
                    fd = None
                    self._leases[lease_id] = lease
            if closed_during_snapshot:
                try:
                    remove_snapshot(artifact.path)
                except BaseException as exc:
                    with self._lock:
                        self._pending_removals[artifact.path] = str(exc)[:1024]
                    raise AdmissionError("frozen artifact store closed and partial removal failed") from exc
                else:
                    with self._lock:
                        self._pending_removals.pop(artifact.path, None)
                raise AdmissionError("frozen artifact store closed during snapshot")
            return lease
        finally:
            if fd is not None:
                os.close(fd)
            with self._condition:
                self._inflight -= 1
                self._condition.notify_all()

    def release(self, lease: FrozenLease, owner: Hashable) -> None:
        with self._lock:
            if owner != lease._owner:
                raise AdmissionError("frozen artifact lease owner mismatch")
            path = lease._artifact.path
            if not lease._closed:
                lease._check(owner)
                del self._leases[lease._lease_id]
                lease._closed = True
                os.close(lease._fd)
                self._pending_removals[path] = None
            elif path not in self._pending_removals:
                return
        try:
            remove_snapshot(lease._artifact.path)
        except BaseException as exc:
            with self._lock:
                self._pending_removals[path] = str(exc)[:1024]
            raise AdmissionError("frozen artifact snapshot removal failed") from exc
        else:
            with self._lock:
                self._pending_removals.pop(path, None)

    @property
    def pending_removals(self) -> tuple[Path, ...]:
        with self._lock:
            return tuple(self._pending_removals)

    def close(self, *, timeout: float = 5.0) -> tuple[str, ...]:
        deadline = time.monotonic() + max(0, timeout)
        failures = []
        with self._condition:
            self._closed = True
            while self._inflight and time.monotonic() < deadline:
                self._condition.wait(deadline - time.monotonic())
            if self._inflight:
                failures.append("snapshot copy did not quiesce before store cleanup deadline")
            leases = list(self._leases.values())
            self._leases.clear()
            for lease in leases:
                lease._closed = True
                os.close(lease._fd)
                self._pending_removals.setdefault(lease._artifact.path, None)
            paths = list(self._pending_removals)
        for path in paths:
            try:
                remove_snapshot(path)
            except BaseException as exc:
                with self._lock:
                    self._pending_removals[path] = str(exc)[:1024]
                failures.append(f"snapshot removal failed: {exc}")
            else:
                with self._lock:
                    self._pending_removals.pop(path, None)
        with self._lock:
            pending = bool(self._pending_removals)
            inflight = bool(self._inflight)
        if self._remove_owned and not pending and not inflight:
            try:
                remove_snapshot(self._owned)
            except BaseException as exc:
                failures.append(f"snapshot store removal failed: {exc}")
        return tuple(failures)


def _open_directory(path: Path) -> int:
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in path.parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def _identity(info: os.stat_result) -> tuple:
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def freeze_tree(source: str | Path, owned_parent: str | Path, *, max_files: int = 10000, max_bytes: int = 512 * 1024**2) -> FrozenArtifact:
    """The caller owns parent; neither source nor its author can write it."""
    source_path = checked_directory(source)
    parent = checked_directory(owned_parent)
    if source_path == parent or source_path in parent.parents or parent in source_path.parents:
        raise AdmissionError("snapshot parent must be separate from the source tree")
    destination = Path(tempfile.mkdtemp(prefix="artifact-", dir=parent))
    entries: list[dict] = []
    total = 0
    def names_in(fd: int) -> list[str]:
        names = []
        with os.scandir(fd) as iterator:
            for entry in iterator:
                names.append(entry.name)
                if len(names) > max_files:
                    raise AdmissionError("artifact directory has too many entries")
        return sorted(names)
    def copy_dir(fd: int, out: Path, relative: str, depth: int = 0) -> None:
        nonlocal total
        if depth > 64:
            raise AdmissionError("artifact directory nesting exceeds 64 levels")
        before = os.fstat(fd)
        names = names_in(fd)
        for name in names:
            if name in (".", "..") or "/" in name or "\0" in name:
                raise AdmissionError("invalid artifact name")
            try:
                name.encode("utf-8", errors="strict")
            except UnicodeError as exc:
                raise AdmissionError("artifact names must be UTF-8") from exc
            if len(entries) >= max_files:
                raise AdmissionError("artifact has too many entries")
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            rel = f"{relative}/{name}" if relative else name
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                try:
                    if _identity(info) != _identity(os.fstat(child)):
                        raise AdmissionError("artifact directory changed during snapshot")
                    target = out / name
                    target.mkdir(mode=0o700)
                    entries.append({"path": rel, "kind": "directory"})
                    copy_dir(child, target, rel, depth + 1)
                    target.chmod(0o500)
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                item = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
                try:
                    opened = os.fstat(item)
                    if _identity(info) != _identity(opened) or not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                        raise AdmissionError("artifact file changed during snapshot")
                    if opened.st_size + total > max_bytes:
                        raise AdmissionError("artifact exceeds snapshot byte limit")
                    digest = hashlib.sha256()
                    size = 0
                    with (out / name).open("xb") as target:
                        while chunk := os.read(item, 65536):
                            size += len(chunk)
                            total += len(chunk)
                            if total > max_bytes:
                                raise AdmissionError("artifact exceeds snapshot byte limit")
                            target.write(chunk)
                            digest.update(chunk)
                    if _identity(opened) != _identity(os.fstat(item)) or size != opened.st_size:
                        raise AdmissionError("artifact file changed during copying")
                    # Some filesystems have coarser timestamp resolution than
                    # consecutive writes. Re-read the pinned file to catch a
                    # same-size overwrite even when stat fields are unchanged.
                    os.lseek(item, 0, os.SEEK_SET)
                    verified = hashlib.sha256()
                    verified_size = 0
                    while chunk := os.read(item, 65536):
                        verified_size += len(chunk)
                        if verified_size > opened.st_size:
                            raise AdmissionError("artifact changed during verification")
                        verified.update(chunk)
                    if verified.digest() != digest.digest() or _identity(opened) != _identity(os.fstat(item)):
                        raise AdmissionError("artifact changed during verification")
                    executable = bool(opened.st_mode & 0o111)
                    (out / name).chmod(0o500 if executable else 0o400)
                    entries.append({"path": rel, "kind": "file", "size": size, "sha256": digest.hexdigest(), "executable": executable})
                finally:
                    os.close(item)
            else:
                raise AdmissionError("artifacts contain regular unlinked files and directories only")
        if _identity(before) != _identity(os.fstat(fd)) or names != names_in(fd):
            raise AdmissionError("artifact directory changed during copying")
    fd = None
    try:
        fd = _open_directory(source_path)
        copy_dir(fd, destination, "")
        encoded = json.dumps(entries, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        destination.chmod(0o500)
        return FrozenArtifact(destination, hashlib.sha256(encoded).hexdigest(), tuple(entries))
    except (OSError, ValueError) as exc:
        remove_snapshot(destination)
        if isinstance(exc, AdmissionError):
            raise
        raise AdmissionError("artifact could not be safely snapshotted") from exc
    finally:
        if fd is not None:
            os.close(fd)


def freeze_path(source: str | Path, owned_parent: str | Path, *, max_files: int = 10_000,
                max_bytes: int = 512 * 1024**2) -> FrozenArtifact:
    """Freeze a regular file or directory into a directory-shaped artifact."""
    raw = Path(source)
    if raw.name in ("", ".", "..") or ".." in raw.parts:
        raise AdmissionError("artifact path is invalid")
    try:
        info = raw.lstat()
    except OSError as exc:
        raise AdmissionError("artifact input is unavailable") from exc
    if stat.S_ISDIR(info.st_mode):
        return freeze_tree(raw, owned_parent, max_files=max_files, max_bytes=max_bytes)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise AdmissionError("artifact input must be a regular unlinked file or directory")

    parent = checked_directory(raw.parent)
    staging = Path(tempfile.mkdtemp(prefix="single-input-", dir=checked_directory(owned_parent)))
    try:
        source_fd = _open_directory(parent)
        try:
            item = os.open(raw.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                           dir_fd=source_fd)
            try:
                opened = os.fstat(item)
                if _identity(info) != _identity(opened) or not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                    raise AdmissionError("artifact file changed before snapshot")
                if opened.st_size > max_bytes:
                    raise AdmissionError("artifact exceeds snapshot byte limit")
                target = staging / raw.name
                digest = hashlib.sha256()
                size = 0
                with target.open("xb") as output:
                    while chunk := os.read(item, 65_536):
                        size += len(chunk)
                        if size > max_bytes:
                            raise AdmissionError("artifact exceeds snapshot byte limit")
                        output.write(chunk)
                        digest.update(chunk)
                if size != opened.st_size or _identity(opened) != _identity(os.fstat(item)):
                    raise AdmissionError("artifact file changed during snapshot")
                os.lseek(item, 0, os.SEEK_SET)
                verify = hashlib.sha256()
                while chunk := os.read(item, 65_536):
                    verify.update(chunk)
                if verify.digest() != digest.digest() or _identity(opened) != _identity(os.fstat(item)):
                    raise AdmissionError("artifact file changed during verification")
                target.chmod(0o700 if opened.st_mode & 0o111 else 0o600)
            finally:
                os.close(item)
        finally:
            os.close(source_fd)
        artifact = freeze_tree(staging, owned_parent, max_files=max_files, max_bytes=max_bytes)
        return artifact
    finally:
        remove_snapshot(staging)


def remove_snapshot(path: Path) -> None:
    """Remove only supervisor-owned trees, including read-only snapshots."""
    if not path.exists():
        return
    for root, dirs, _ in os.walk(path, followlinks=False):
        os.chmod(root, 0o700)
        for name in dirs:
            child = Path(root) / name
            if not child.is_symlink():
                child.chmod(0o700)
    shutil.rmtree(path)
