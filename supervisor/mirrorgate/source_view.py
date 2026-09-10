"""Filtered source views: strict selectors and descriptor-pinned materialization.

A source view copies an explicit include manifest from a pinned repository root
into an exclusively created session directory beneath the operator-approved
workspace root. Only ordinary directories and single-link regular files cross
the boundary. The materialized view is the sole writable authoring workspace
and the sole input to source freezing; the
original repository is never mounted.

The version-1 selector has no glob, negation, exclude, or optional-path syntax.
Omitted paths are absent by default, so they cannot be reached through a
renamed mount point, a preexisting symlink, or an absolute host pathname.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
from typing import Any

from .artifacts import remove_snapshot
from .policy import AdmissionError, checked_directory


SOURCE_VIEW_SCHEMA = "mirrorgate.source-view/v1"
SELECTOR_DOMAIN = b"mirrorgate.source-view-selector/v1"
MAX_INCLUDE_PATHS = 1_024
MAX_SELECTOR_BYTES = 65_535
MAX_RELATIVE_PATH_BYTES = 1_024
MAX_DIRECTORY_DEPTH = 64
SUPERVISOR_DIRECTORY_MODE = 0o700
_READ_CHUNK = 65_536

__all__ = [
    "SOURCE_VIEW_SCHEMA",
    "SourceViewCleanupError",
    "SourceViewMaterialization",
    "SourceViewPolicy",
    "materialize_source_view",
]


class SourceViewCleanupError(AdmissionError):
    """A partially published view could not be removed during rollback."""

    def __init__(self, path: Path):
        super().__init__("source view rollback failed")
        self.path = path


@dataclass(frozen=True)
class SourceViewPolicy:
    """A frozen, operator-owned include manifest and workspace for one root."""

    schema: str
    workspace_root: Path
    workspace_identity: tuple[int, int]
    include_paths: tuple[str, ...]
    selector_sha256: str

    @classmethod
    def parse(cls, value: Any) -> "SourceViewPolicy":
        if type(value) is not dict or set(value) != {"schema", "workspaceRoot", "includePaths"}:
            raise AdmissionError("source view fields do not match the frozen schema")
        if value["schema"] != SOURCE_VIEW_SCHEMA:
            raise AdmissionError("source view schema is not approved")
        include_paths = _normalized_include_paths(value["includePaths"])
        workspace_root, workspace_identity = _checked_workspace_root(value["workspaceRoot"])
        return cls(SOURCE_VIEW_SCHEMA, workspace_root, workspace_identity, include_paths,
                   selector_sha256(include_paths))

    def validated(self) -> "SourceViewPolicy":
        if type(self) is not SourceViewPolicy or self.schema != SOURCE_VIEW_SCHEMA:
            raise AdmissionError("source view policy is not a validated selector")
        if not isinstance(self.workspace_root, Path):
            raise AdmissionError("source view workspace root must be a directory path")
        if type(self.workspace_identity) is not tuple or len(self.workspace_identity) != 2 or any(
                type(item) is not int or item < 0 for item in self.workspace_identity):
            raise AdmissionError("source view workspace identity is malformed")
        if type(self.include_paths) is not tuple:
            raise AdmissionError("source view include paths must be an immutable tuple")
        for path in self.include_paths:
            _checked_include_path(path)
        checked = _checked_include_set(self.include_paths)
        if checked != self.include_paths:
            raise AdmissionError("source view include paths must be sorted and unique")
        if self.selector_sha256 != selector_sha256(checked):
            raise AdmissionError("source view selector digest is inconsistent")
        _recheck_workspace_root(self.workspace_root, self.workspace_identity)
        return self


@dataclass(frozen=True)
class SourceViewMaterialization:
    """Immutable identity of the bytes initially published into authoring."""

    path: Path
    selected_manifest_sha256: str
    manifest: tuple[dict, ...]


def selector_sha256(include_paths: tuple[str, ...] | list[str]) -> str:
    """Deterministic identity of the sorted include manifest."""
    canonical = json.dumps({"includePaths": list(include_paths)}, sort_keys=True,
                           separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    digest = hashlib.sha256()
    digest.update(SELECTOR_DOMAIN)
    digest.update(b"\x00")
    digest.update(canonical)
    return digest.hexdigest()


def materialize_source_view(source: str | Path, destination: str | Path,
                            policy: SourceViewPolicy, *, max_files: int,
                            max_bytes: int) -> SourceViewMaterialization:
    """Copy ``policy.include_paths`` into an exclusively created session destination."""
    if type(policy) is not SourceViewPolicy:
        raise AdmissionError("source view policy is not a validated selector")
    policy = policy.validated()
    for label, value in (("max_files", max_files), ("max_bytes", max_bytes)):
        if type(value) is not int or value <= 0 or value > 2**60:
            raise AdmissionError(f"{label} must be a positive bounded integer")

    try:
        published = Path(destination)
    except TypeError as exc:
        raise AdmissionError("source view destination must be a directory path") from exc
    workspace_root = policy.workspace_root
    if (not published.is_absolute() or published.parent != workspace_root
            or published.name in ("", ".", "..")):
        raise AdmissionError("source view destination is outside the approved workspace")

    source_path = checked_directory(source)
    if source_path == workspace_root or workspace_root in source_path.parents:
        raise AdmissionError("source view source root overlaps the approved workspace")
    for include in policy.include_paths:
        selected = source_path / PurePosixPath(include)
        if (selected == workspace_root or selected in workspace_root.parents
                or workspace_root in selected.parents):
            raise AdmissionError("source view selected path overlaps the workspace root")
    _recheck_workspace_root(workspace_root, policy.workspace_identity)

    root_fd, root_identity = _open_source_root(source_path)
    try:
        workspace_fd = _open_workspace_root(workspace_root, policy.workspace_identity)
    except BaseException:
        os.close(root_fd)
        raise
    destination_fd: int | None = None
    destination_identity: tuple[int, int] | None = None
    try:
        destination_fd, destination_identity = _create_destination(
            workspace_fd, published.name)
        state = _CopyState(max_files=max_files, max_bytes=max_bytes,
                           workspace_identity=policy.workspace_identity)
        for include in sorted(policy.include_paths, key=lambda path: tuple(path.split("/"))):
            _materialize_include(root_fd, destination_fd, include, state)
        if _identity(os.fstat(root_fd)) != root_identity:
            raise AdmissionError("source view input changed during materialization")
        _recheck_source_root(source_path, root_identity)
        _recheck_workspace_root(workspace_root, policy.workspace_identity)
        _recheck_destination_contents(destination_fd, "", state)
        _recheck_destination(workspace_fd, published.name, destination_identity)
    except BaseException:
        if destination_fd is not None and destination_identity is not None:
            try:
                _remove_pinned_destination(
                    workspace_fd, workspace_root, destination_identity)
            except BaseException as cleanup:
                raise SourceViewCleanupError(published) from cleanup
        raise
    finally:
        if destination_fd is not None:
            os.close(destination_fd)
        os.close(workspace_fd)
        os.close(root_fd)

    manifest = tuple(state.manifest)
    return SourceViewMaterialization(published, _manifest_sha256(manifest), manifest)


def _checked_workspace_root(value: Any) -> tuple[Path, tuple[int, int]]:
    if type(value) is not str or not value or "\0" in value or not value.startswith("/"):
        raise AdmissionError("source view workspaceRoot must be an absolute directory path")
    path = checked_directory(value)
    try:
        info = path.lstat()
    except (OSError, UnicodeError) as exc:
        raise AdmissionError("source view workspaceRoot is unavailable") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise AdmissionError("source view workspaceRoot must be an ordinary directory")
    if info.st_uid != os.geteuid():
        raise AdmissionError("source view workspaceRoot must be owned by the supervisor")
    if stat.S_IMODE(info.st_mode) != SUPERVISOR_DIRECTORY_MODE:
        raise AdmissionError("source view workspaceRoot must be mode 0700")
    return path, (info.st_dev, info.st_ino)


def _recheck_workspace_root(path: Path, identity: tuple[int, int]) -> None:
    try:
        info = path.lstat()
    except (OSError, UnicodeError) as exc:
        raise AdmissionError("source view workspaceRoot changed during materialization") from exc
    if (stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode)
            or (info.st_dev, info.st_ino) != tuple(identity)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != SUPERVISOR_DIRECTORY_MODE):
        raise AdmissionError("source view workspaceRoot changed during materialization")


def _checked_include_path(value: Any) -> str:
    try:
        encoded = value.encode("utf-8") if type(value) is str else b""
    except UnicodeError as exc:
        raise AdmissionError("source view include path must contain Unicode scalars") from exc
    if type(value) is not str or "\0" in value or len(encoded) > MAX_RELATIVE_PATH_BYTES:
        raise AdmissionError("source view include path must be a bounded UTF-8 relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or str(path) != value or value in ("", "."):
        raise AdmissionError("source view include path must be canonical and relative")
    return value


def _checked_include_set(include_paths: tuple[str, ...]) -> tuple[str, ...]:
    paths = tuple(sorted(include_paths))
    known = set(paths)
    for path in paths:
        parts = path.split("/")
        for index in range(1, len(parts)):
            if "/".join(parts[:index]) in known:
                raise AdmissionError("source view include paths must not overlap")
    return paths


def _normalized_include_paths(value: Any) -> tuple[str, ...]:
    if type(value) is not list or not value:
        raise AdmissionError("source view includePaths must be a nonempty array")
    if len(value) > MAX_INCLUDE_PATHS:
        raise AdmissionError("source view includePaths exceeds the path count limit")
    paths = []
    total = 0
    for item in value:
        path = _checked_include_path(item)
        total += len(path.encode("utf-8"))
        paths.append(path)
    if total > MAX_SELECTOR_BYTES:
        raise AdmissionError("source view includePaths exceeds the selector byte limit")
    normalized = _checked_include_set(tuple(paths))
    if len(set(normalized)) != len(normalized) or len(normalized) != len(paths):
        raise AdmissionError("source view includePaths must not contain duplicates")
    return normalized


def _identity(info: os.stat_result) -> tuple:
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def _open_source_root(path: Path) -> tuple[int, tuple]:
    try:
        info = path.lstat()
    except OSError as exc:
        raise AdmissionError("source view root is unavailable") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise AdmissionError("source view root must be an ordinary directory")
    try:
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    except OSError as exc:
        raise AdmissionError("source view root is unavailable") from exc
    try:
        for part in path.parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                          dir_fd=fd)
            os.close(fd)
            fd = nxt
        opened = os.fstat(fd)
        if _identity(info) != _identity(opened):
            raise AdmissionError("source view root changed during materialization")
    except BaseException:
        os.close(fd)
        raise
    return fd, _identity(opened)


def _recheck_source_root(path: Path, identity: tuple) -> None:
    try:
        info = path.lstat()
    except OSError as exc:
        raise AdmissionError("source view root changed during materialization") from exc
    if (stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode)
            or (info.st_dev, info.st_ino) != identity[:2]):
        raise AdmissionError("source view root changed during materialization")


def _listed_names(fd: int, bound: int) -> list[str]:
    names = []
    with os.scandir(fd) as iterator:
        for entry in iterator:
            names.append(entry.name)
            if len(names) > bound:
                raise AdmissionError("source view directory has too many entries")
    return sorted(names)


def _checked_name(name: str) -> str:
    if name in ("", ".", "..") or "/" in name or "\0" in name:
        raise AdmissionError("source view input name is invalid")
    try:
        if len(name.encode("utf-8", errors="strict")) > 255:
            raise AdmissionError("source view input name exceeds the name bound")
    except UnicodeError as exc:
        raise AdmissionError("source view input names must be UTF-8") from exc
    return name


def _open_workspace_root(path: Path, identity: tuple[int, int]) -> int:
    fd, opened = _open_source_root(path)
    if opened[:2] != identity:
        os.close(fd)
        raise AdmissionError("source view workspaceRoot changed during materialization")
    return fd


def _create_destination(workspace_fd: int, name: str) -> tuple[int, tuple[int, int]]:
    try:
        os.mkdir(name, SUPERVISOR_DIRECTORY_MODE, dir_fd=workspace_fd)
    except FileExistsError as exc:
        raise AdmissionError("source view destination collides with an existing entry") from exc
    except OSError as exc:
        raise AdmissionError("source view destination could not be published") from exc
    fd = None
    try:
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                     dir_fd=workspace_fd)
        info = os.fstat(fd)
        os.fchmod(fd, SUPERVISOR_DIRECTORY_MODE)
    except OSError as exc:
        if fd is not None:
            os.close(fd)
        try:
            os.rmdir(name, dir_fd=workspace_fd)
        except OSError:
            pass
        raise AdmissionError("source view destination could not be published") from exc
    return fd, (info.st_dev, info.st_ino)


def _recheck_destination(workspace_fd: int, name: str,
                         identity: tuple[int, int]) -> None:
    try:
        info = os.stat(name, dir_fd=workspace_fd, follow_symlinks=False)
    except OSError as exc:
        raise AdmissionError("source view destination changed during materialization") from exc
    if (not stat.S_ISDIR(info.st_mode)
            or stat.S_IMODE(info.st_mode) != SUPERVISOR_DIRECTORY_MODE
            or (info.st_dev, info.st_ino) != identity):
        raise AdmissionError("source view destination changed during materialization")


def _remove_pinned_destination(workspace_fd: int, workspace_root: Path,
                               identity: tuple[int, int]) -> None:
    found = None
    with os.scandir(workspace_fd) as entries:
        for entry in entries:
            info = os.stat(entry.name, dir_fd=workspace_fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == identity:
                found = workspace_root / entry.name
                break
    if found is None:
        raise AdmissionError("source view destination identity is no longer reachable")
    remove_snapshot(found)


def _recheck_destination_contents(fd: int, relative: str,
                                  state: _CopyState) -> None:
    info = os.fstat(fd)
    if (not stat.S_ISDIR(info.st_mode)
            or stat.S_IMODE(info.st_mode) != SUPERVISOR_DIRECTORY_MODE):
        raise AdmissionError("source view destination changed during materialization")
    names = _listed_names(fd, state.max_files)
    if names != sorted(state.children.get(relative, set())):
        raise AdmissionError("source view destination changed during materialization")
    for name in names:
        child_relative = f"{relative}/{name}" if relative else name
        directory_identity = state.directories.get(child_relative)
        if directory_identity is not None:
            child = _open_destination_directory(fd, name, directory_identity)
            try:
                _recheck_destination_contents(child, child_relative, state)
            finally:
                os.close(child)
            continue
        expected = state.files.get(child_relative)
        if expected is None:
            raise AdmissionError("source view destination changed during materialization")
        try:
            item = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                           dir_fd=fd)
        except OSError as exc:
            raise AdmissionError("source view destination changed during materialization") from exc
        try:
            info = os.fstat(item)
            identity = (info.st_dev, info.st_ino, info.st_size,
                        stat.S_IMODE(info.st_mode))
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or identity != expected[:4]):
                raise AdmissionError("source view destination changed during materialization")
            digest = hashlib.sha256()
            while chunk := _read(item, _READ_CHUNK):
                digest.update(chunk)
            if digest.hexdigest() != expected[4]:
                raise AdmissionError("source view destination changed during materialization")
        finally:
            os.close(item)


def _open_directory_component(fd: int, name: str, state: _CopyState) -> int:
    try:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
    except OSError as exc:
        raise AdmissionError("source view include path is unavailable") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise AdmissionError("source view include path components must be ordinary directories")
    if (info.st_dev, info.st_ino) == state.workspace_identity:
        raise AdmissionError("source view selected path contains the workspace root")
    try:
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                        dir_fd=fd)
    except OSError as exc:
        raise AdmissionError("source view include path components must be ordinary directories") from exc
    if _identity(info) != _identity(os.fstat(child)):
        os.close(child)
        raise AdmissionError("source view input changed during materialization")
    return child


def _read(fd: int, size: int) -> bytes:
    return os.read(fd, size)


class _CopyState:
    __slots__ = ("max_files", "max_bytes", "workspace_identity", "entries", "bytes",
                 "manifest", "directories", "files", "children")

    def __init__(self, *, max_files: int, max_bytes: int,
                 workspace_identity: tuple[int, int]):
        self.max_files = max_files
        self.max_bytes = max_bytes
        self.workspace_identity = workspace_identity
        self.entries = 0
        self.bytes = 0
        self.manifest: list[dict] = []
        self.directories: dict[str, tuple[int, int]] = {}
        self.files: dict[str, tuple[int, int, int, int, str]] = {}
        self.children: dict[str, set[str]] = {}

    def reserve_entry(self) -> None:
        if self.entries >= self.max_files:
            raise AdmissionError("source view exceeds the snapshot file bound")
        self.entries += 1

    def add_bytes(self, size: int) -> None:
        self.bytes += size
        if self.bytes > self.max_bytes:
            raise AdmissionError("source view exceeds the snapshot byte bound")

    def record_child(self, relative: str) -> None:
        parent, _, name = relative.rpartition("/")
        self.children.setdefault(parent, set()).add(name)


def _materialize_include(root_fd: int, destination_fd: int, include: str,
                         state: _CopyState) -> None:
    parts = include.split("/")
    source_fds: list[int] = []
    destination_fds: list[int] = []
    try:
        source_fd = root_fd
        output_fd = destination_fd
        relative = ""
        for index, part in enumerate(parts):
            name = _checked_name(part)
            relative = f"{relative}/{name}" if relative else name
            if index + 1 < len(parts):
                if index + 1 > MAX_DIRECTORY_DEPTH:
                    raise AdmissionError("source view exceeds the directory depth bound")
                source_child = _open_directory_component(source_fd, name, state)
                source_fds.append(source_child)
                output_child = _ensure_directory(output_fd, name, relative, state)
                destination_fds.append(output_child)
                source_fd = source_child
                output_fd = output_child
                continue
            try:
                info = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
            except OSError as exc:
                raise AdmissionError("source view include path is unavailable") from exc
            if stat.S_ISLNK(info.st_mode):
                raise AdmissionError("source view inputs must not contain links")
            if stat.S_ISDIR(info.st_mode):
                source_child = _open_directory_component(source_fd, name, state)
                source_fds.append(source_child)
                output_child = _create_directory(output_fd, name, relative, state)
                destination_fds.append(output_child)
                _copy_directory(source_child, output_child, relative, len(parts), state)
            elif stat.S_ISREG(info.st_mode):
                if info.st_nlink != 1:
                    raise AdmissionError("source view inputs must not contain hard links")
                _copy_file(source_fd, name, output_fd, relative, info, state)
            else:
                raise AdmissionError("source view inputs must be ordinary files and directories")
    finally:
        for fd in reversed(destination_fds):
            os.close(fd)
        for fd in reversed(source_fds):
            os.close(fd)


def _copy_directory(fd: int, destination_fd: int, relative: str, depth: int,
                    state: _CopyState) -> None:
    if depth > MAX_DIRECTORY_DEPTH:
        raise AdmissionError("source view exceeds the directory depth bound")
    before = os.fstat(fd)
    names = _listed_names(fd, state.max_files)
    for name in names:
        name = _checked_name(name)
        child_relative = f"{relative}/{name}" if relative else name
        if len(child_relative.encode("utf-8")) > MAX_RELATIVE_PATH_BYTES:
            raise AdmissionError("source view exceeds the path length bound")
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISLNK(info.st_mode):
            raise AdmissionError("source view inputs must not contain links")
        if stat.S_ISDIR(info.st_mode):
            child = _open_directory_component(fd, name, state)
            output_child = None
            try:
                output_child = _create_directory(
                    destination_fd, name, child_relative, state)
                _copy_directory(child, output_child, child_relative, depth + 1, state)
            finally:
                if output_child is not None:
                    os.close(output_child)
                os.close(child)
        elif stat.S_ISREG(info.st_mode):
            if info.st_nlink != 1:
                raise AdmissionError("source view inputs must not contain hard links")
            _copy_file(fd, name, destination_fd, child_relative, info, state)
        else:
            raise AdmissionError("source view inputs must be ordinary files and directories")
    if _identity(before) != _identity(os.fstat(fd)) or names != _listed_names(fd, state.max_files):
        raise AdmissionError("source view input changed during materialization")


def _ensure_directory(parent_fd: int, name: str, relative: str,
                      state: _CopyState) -> int:
    identity = state.directories.get(relative)
    if identity is not None:
        return _open_destination_directory(parent_fd, name, identity)
    return _create_directory(parent_fd, name, relative, state)


def _open_destination_directory(parent_fd: int, name: str,
                                identity: tuple[int, int]) -> int:
    try:
        info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                        dir_fd=parent_fd)
    except OSError as exc:
        raise AdmissionError("source view destination directory changed") from exc
    opened = os.fstat(child)
    if (not stat.S_ISDIR(info.st_mode)
            or stat.S_IMODE(info.st_mode) != SUPERVISOR_DIRECTORY_MODE
            or (info.st_dev, info.st_ino) != identity
            or not stat.S_ISDIR(opened.st_mode)
            or stat.S_IMODE(opened.st_mode) != SUPERVISOR_DIRECTORY_MODE
            or (opened.st_dev, opened.st_ino) != identity):
        os.close(child)
        raise AdmissionError("source view destination directory changed")
    return child


def _create_directory(parent_fd: int, name: str, relative: str,
                      state: _CopyState) -> int:
    state.reserve_entry()
    try:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
    except FileExistsError as exc:
        raise AdmissionError("source view destination collides with an existing entry") from exc
    except OSError as exc:
        raise AdmissionError("source view destination entry could not be created") from exc
    child = None
    try:
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                        dir_fd=parent_fd)
        os.fchmod(child, 0o700)
    except OSError as exc:
        if child is not None:
            os.close(child)
        try:
            os.rmdir(name, dir_fd=parent_fd)
        except OSError:
            pass
        raise AdmissionError("source view destination entry could not be created") from exc
    info = os.fstat(child)
    state.directories[relative] = (info.st_dev, info.st_ino)
    state.record_child(relative)
    state.manifest.append({"path": relative, "kind": "directory"})
    return child


def _copy_file(fd: int, name: str, destination_fd: int, relative: str,
               info: os.stat_result, state: _CopyState) -> None:
    handle = None
    try:
        item = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                       dir_fd=fd)
    except OSError as exc:
        raise AdmissionError("source view input is unavailable") from exc
    try:
        opened = os.fstat(item)
        if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                or _identity(info) != _identity(opened)):
            raise AdmissionError("source view input changed during materialization")
        if opened.st_size + state.bytes > state.max_bytes:
            raise AdmissionError("source view exceeds the snapshot byte bound")
        state.reserve_entry()
        try:
            handle = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL
                             | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600,
                             dir_fd=destination_fd)
        except FileExistsError as exc:
            raise AdmissionError("source view destination collides with an existing entry") from exc
        except OSError as exc:
            raise AdmissionError("source view destination entry could not be created") from exc
        executable = bool(opened.st_mode & 0o111)
        digest = hashlib.sha256()
        size = 0
        written = None
        with os.fdopen(handle, "wb", closefd=False) as output:
            while chunk := _read(item, _READ_CHUNK):
                size += len(chunk)
                state.add_bytes(len(chunk))
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fchmod(output.fileno(), 0o700 if executable else 0o600)
            written = os.fstat(output.fileno())
        if _identity(opened) != _identity(os.fstat(item)) or size != opened.st_size:
            raise AdmissionError("source view input changed during materialization")
        os.lseek(item, 0, os.SEEK_SET)
        verified = hashlib.sha256()
        verified_size = 0
        while chunk := _read(item, _READ_CHUNK):
            verified_size += len(chunk)
            verified.update(chunk)
        if (verified_size != size or verified.digest() != digest.digest()
                or _identity(opened) != _identity(os.fstat(item))):
            raise AdmissionError("source view input changed during materialization")
        assert written is not None
        os.lseek(handle, 0, os.SEEK_SET)
        output_digest = hashlib.sha256()
        output_size = 0
        while chunk := _read(handle, _READ_CHUNK):
            output_size += len(chunk)
            output_digest.update(chunk)
        current = os.fstat(handle)
        if (output_size != size or output_digest.digest() != digest.digest()
                or (written.st_dev, written.st_ino) !=
                   (current.st_dev, current.st_ino)):
            raise AdmissionError("source view destination changed during materialization")
        state.files[relative] = (
            written.st_dev, written.st_ino, size,
            0o700 if executable else 0o600, digest.hexdigest())
        state.record_child(relative)
        state.manifest.append({"path": relative, "kind": "file", "size": size,
                               "sha256": digest.hexdigest(), "executable": executable})
    finally:
        if handle is not None:
            try:
                os.close(handle)
            except OSError:
                pass
        os.close(item)


def _manifest_sha256(manifest: tuple[dict, ...]) -> str:
    encoded = json.dumps(list(manifest), sort_keys=True, separators=(",", ":"),
                         ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
