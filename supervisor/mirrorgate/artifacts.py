"""Submission snapshots with fd-relative traversal and deterministic identity."""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile

from .policy import AdmissionError, checked_directory


@dataclass(frozen=True)
class FrozenArtifact:
    path: Path
    digest: str
    manifest: tuple[dict, ...]


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
