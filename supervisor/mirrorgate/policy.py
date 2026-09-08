"""Trusted configuration is separate from untrusted tool requests."""
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
import math
import os
import stat


class AdmissionError(ValueError):
    """Requested isolation could not be admitted; never run without it."""


def checked_directory(path: str | Path) -> Path:
    """Reject symlinks in every component, including the supplied root."""
    raw = Path(path)
    if ".." in raw.parts:
        raise AdmissionError("parent traversal is forbidden")
    absolute = Path(os.path.abspath(raw))
    current = Path("/")
    for part in absolute.parts[1:]:
        current /= part
        try:
            info = current.lstat()
        except (OSError, UnicodeError) as exc:
            raise AdmissionError("approved directory is unavailable") from exc
        if not stat.S_ISDIR(info.st_mode):
            raise AdmissionError("approved directory must not contain symlinks or special files")
    return absolute


@dataclass(frozen=True)
class RuntimeMount:
    source: str | Path
    destination: str

    def checked(self) -> "RuntimeMount":
        source = checked_directory(self.source)
        try:
            destination_size = len(self.destination.encode("utf-8")) if type(self.destination) is str else 0
        except UnicodeError as exc:
            raise AdmissionError("runtime destination must contain Unicode scalars") from exc
        if type(self.destination) is not str or "\0" in self.destination or destination_size > 1024:
            raise AdmissionError("runtime destination must be a bounded path")
        dest = PurePosixPath(self.destination)
        if str(dest) != self.destination or ".." in dest.parts:
            raise AdmissionError("runtime destination must be canonical")
        if self.destination != "/usr" and not (
            len(dest.parts) == 3 and dest.parts[1] == "runtime"
            and dest.parts[2] not in (".", "..")
        ):
            raise AdmissionError("runtime mounts must target /usr or /runtime/NAME")
        if source in (Path("/"), Path("/home"), Path("/etc"), Path("/proc"), Path("/dev"), Path("/sys"), Path("/run"), Path("/tmp")):
            raise AdmissionError("broad host or management roots are not runtime trees")
        return RuntimeMount(source, self.destination)


def system_runtime_mounts() -> tuple[RuntimeMount, ...]:
    """Operator approval asserts /usr is a public, trusted runtime tree."""
    return (RuntimeMount("/usr", "/usr"),)


@dataclass(frozen=True)
class Limits:
    wall_seconds: float = 30
    cpu_seconds: int = 20
    address_space_bytes: int = 4 * 1024**3
    uid_processes: int = 4096
    open_files: int = 128
    file_bytes: int = 64 * 1024**2
    stdout_bytes: int = 4 * 1024**2
    stderr_bytes: int = 1024**2
    tmp_bytes: int = 64 * 1024**2
    scratch_bytes: int = 256 * 1024**2
    eof_grace_seconds: float = 0.5
    aggregate_memory_bytes: int | None = None
    aggregate_cpu_seconds: int | None = None
    aggregate_processes: int | None = None
    aggregate_disk_bytes: int | None = None

    def validate(self) -> None:
        for name in ("aggregate_memory_bytes", "aggregate_cpu_seconds", "aggregate_processes", "aggregate_disk_bytes"):
            if getattr(self, name) is not None:
                raise AdmissionError(f"bubblewrap backend cannot enforce {name}")
        for name in ("wall_seconds", "eof_grace_seconds"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise AdmissionError(f"{name} must be finite and positive")
        for name in ("cpu_seconds", "address_space_bytes", "uid_processes", "open_files", "file_bytes", "stdout_bytes", "stderr_bytes", "tmp_bytes", "scratch_bytes"):
            value = getattr(self, name)
            if type(value) is not int or value <= 0 or value > 2**60:
                raise AdmissionError(f"{name} must be a positive bounded integer")
        if self.open_files < 32:
            raise AdmissionError("open_files must allow supervisor namespace setup (at least 32)")


@dataclass(frozen=True)
class ToolRequest:
    argv: tuple[str, ...]
    cwd: str = "."

    def validate(self) -> "ToolRequest":
        if not isinstance(self.argv, (tuple, list)) or not self.argv or len(self.argv) > 256:
            raise AdmissionError("argv must contain between 1 and 256 arguments")
        if any(type(arg) is not str or not arg or "\0" in arg for arg in self.argv):
            raise AdmissionError("arguments must be nonempty strings without NUL")
        try:
            argument_bytes = sum(len(arg.encode("utf-8")) for arg in self.argv)
        except UnicodeError as exc:
            raise AdmissionError("arguments must contain Unicode scalars") from exc
        if argument_bytes > 65535:
            raise AdmissionError("arguments exceed the 64 KiB request bound")
        try:
            cwd_bytes = len(self.cwd.encode("utf-8")) if type(self.cwd) is str else 0
        except UnicodeError as exc:
            raise AdmissionError("cwd must contain Unicode scalars") from exc
        if type(self.cwd) is not str or "\0" in self.cwd or cwd_bytes > 1024:
            raise AdmissionError("cwd must be a relative directory")
        cwd = PurePosixPath(self.cwd)
        if cwd.is_absolute() or ".." in cwd.parts or str(cwd) != self.cwd:
            raise AdmissionError("cwd must be canonical and relative to the submission")
        return ToolRequest(tuple(self.argv), self.cwd)

    @classmethod
    def from_dict(cls, value: dict) -> "ToolRequest":
        if type(value) is not dict or set(value) - {"argv", "cwd"} or "argv" not in value:
            raise AdmissionError("tool requests accept only argv and cwd")
        return cls(value["argv"], value.get("cwd", ".")).validate()


@dataclass(frozen=True)
class TrustedConfig:
    profile: str
    workspace: str | Path
    output: str | Path | None = None
    runtime_mounts: tuple[RuntimeMount, ...] = field(default_factory=system_runtime_mounts)
    limits: Limits = field(default_factory=Limits)
    network: str = "isolated"
    backend: str = "linux-bubblewrap-v1"

    def checked(self) -> "TrustedConfig":
        if self.profile not in ("authoring", "build", "execution"):
            raise AdmissionError("unknown sandbox profile")
        if self.backend != "linux-bubblewrap-v1" or self.network != "isolated":
            raise AdmissionError("unsupported backend or networking capability")
        self.limits.validate()
        workspace = checked_directory(self.workspace)
        if workspace in (Path("/"), Path("/home"), Path("/usr"), Path("/etc"), Path("/tmp"), Path("/proc"), Path("/dev"), Path("/sys"), Path("/run")):
            raise AdmissionError("workspace must be a dedicated public submission tree")
        output = checked_directory(self.output) if self.output is not None else None
        if self.profile != "build" and output is not None:
            raise AdmissionError("only build can request an output mount")
        if output is not None and (output == workspace or output in workspace.parents or workspace in output.parents):
            raise AdmissionError("build output must be separate from submitted source")
        mounts = tuple(mount.checked() for mount in self.runtime_mounts)
        if not mounts or len({mount.destination for mount in mounts}) != len(mounts):
            raise AdmissionError("runtime mounts must have unique destinations")
        if "/usr" not in {mount.destination for mount in mounts}:
            raise AdmissionError("this backend requires an approved /usr with Python 3 bootstrap")
        for mount in mounts:
            source = Path(mount.source)
            if source == workspace or source in workspace.parents or workspace in source.parents:
                raise AdmissionError("runtime and submission roots must not overlap")
            if output is not None and (source == output or source in output.parents or output in source.parents):
                raise AdmissionError("runtime and build output roots must not overlap")
        if output is not None and any(output.iterdir()):
            raise AdmissionError("build output must be empty and supervisor-owned")
        return TrustedConfig(self.profile, workspace, output, mounts, self.limits, self.network, self.backend)
