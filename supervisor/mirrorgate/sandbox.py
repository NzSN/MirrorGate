"""Linux namespace launch and bounded transport; no worker/model interpretation."""
from dataclasses import asdict, dataclass
import ctypes
import json
import os
from pathlib import Path, PurePosixPath
import queue
import resource
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time

from .artifacts import _open_directory, freeze_tree, remove_snapshot
from .policy import AdmissionError, Limits, ToolRequest, TrustedConfig


@dataclass(frozen=True)
class RunResult:
    returncode: int
    reason: str
    stdout: bytes
    stderr: bytes
    duration_seconds: float


class SandboxProcess:
    """One bounded process tree. Readers drain bytes, with b'' marking EOF."""
    def __init__(self, process: subprocess.Popen, limits: Limits):
        self.process = process
        self.limits = limits
        self.started = time.monotonic()
        self.reason = "exited"
        self.returncode: int | None = None
        self._stdout: queue.Queue = queue.Queue()
        self._stderr: queue.Queue = queue.Queue()
        self._done = threading.Event()
        self._lock = threading.Lock()
        self._input_lock = threading.Lock()
        self._eof_at: float | None = None
        self._thread = threading.Thread(target=self._monitor, daemon=True, name="mirrorgate-monitor")
        self._thread.start()

    def _terminate(self, reason: str) -> None:
        with self._lock:
            if self.reason == "exited":
                self.reason = reason
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def cancel(self) -> None:
        self._terminate("cancelled")

    def write(self, data: bytes) -> None:
        if not isinstance(data, bytes):
            raise TypeError("sandbox input must be bytes")
        if len(data) > 1024**2:
            raise ValueError("a single transport write is limited to 1 MiB")
        with self._input_lock:
            if self._done.is_set() or self.process.stdin is None or self.process.stdin.closed:
                raise BrokenPipeError("sandbox input is closed")
            remaining = memoryview(data)
            while remaining:
                written = self.process.stdin.write(remaining)
                if not written:
                    raise BrokenPipeError("sandbox input stopped accepting bytes")
                remaining = remaining[written:]
            self.process.stdin.flush()

    def close_stdin(self, *, terminate_after_grace: bool = True) -> None:
        with self._input_lock:
            if self.process.stdin is not None and not self.process.stdin.closed:
                try:
                    self.process.stdin.close()
                except BrokenPipeError:
                    pass
                if terminate_after_grace:
                    self._eof_at = time.monotonic()

    def read_stdout(self, timeout: float | None = None) -> bytes:
        return self._stdout.get(timeout=timeout)

    def read_stderr(self, timeout: float | None = None) -> bytes:
        return self._stderr.get(timeout=timeout)

    def wait(self, timeout: float | None = None) -> int:
        if not self._done.wait(timeout):
            raise TimeoutError("sandbox has not exited")
        assert self.returncode is not None
        return self.returncode

    def _monitor(self) -> None:
        counts = {"stdout": 0, "stderr": 0}
        streams = {"stdout": self._stdout, "stderr": self._stderr}
        selector = selectors.DefaultSelector()
        assert self.process.stdout is not None and self.process.stderr is not None
        for name, pipe in (("stdout", self.process.stdout), ("stderr", self.process.stderr)):
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, name)
        try:
            while selector.get_map() or self.process.poll() is None:
                now = time.monotonic()
                if now - self.started >= self.limits.wall_seconds:
                    self._terminate("wall_timeout")
                if self._eof_at is not None and now - self._eof_at >= self.limits.eof_grace_seconds and self.process.poll() is None:
                    self._terminate("stdin_eof")
                for key, _ in selector.select(0.02):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    name = key.data
                    limit = getattr(self.limits, name + "_bytes")
                    remaining = max(0, limit - counts[name])
                    if chunk[:remaining]:
                        streams[name].put(chunk[:remaining])
                    counts[name] += len(chunk)
                    if counts[name] > limit:
                        self._terminate(name + "_limit")
            self.returncode = self.process.wait()
            if self.reason == "exited" and self.returncode != 0:
                self.reason = "failed"
        except BaseException:
            self._terminate("supervisor_error")
            self.returncode = self.process.wait()
        finally:
            selector.close()
            self.close_stdin(terminate_after_grace=False)
            self._stdout.put(b"")
            self._stderr.put(b"")
            self._done.set()


class GateSession:
    """Trusted controller constructs this once; agent tools only call run/start."""
    def __init__(self, config: TrustedConfig):
        self.config = config.checked()
        if sys.platform != "linux":
            raise AdmissionError("linux-bubblewrap-v1 requires Linux")
        if os.geteuid() == 0:
            raise AdmissionError("linux-bubblewrap-v1 requires an unprivileged host user")
        bwrap = Path("/usr/bin/bwrap")
        if not bwrap.is_file() or not os.access(bwrap, os.X_OK):
            raise AdmissionError("bubblewrap is unavailable; refusing unsandboxed execution")
        if bwrap.stat().st_mode & stat.S_ISUID:
            raise AdmissionError("this profile requires non-setuid bubblewrap")
        version = subprocess.run([str(bwrap), "--version"], capture_output=True, text=True, timeout=5, env={"PATH": "/usr/bin:/bin"}, close_fds=True)
        try:
            numbers = tuple(int(x) for x in version.stdout.strip().split()[-1].split("."))
        except (ValueError, IndexError) as exc:
            raise AdmissionError("cannot establish bubblewrap version") from exc
        if version.returncode != 0 or numbers < (0, 9, 0):
            raise AdmissionError("bubblewrap 0.9.0 or newer is required")
        self._owned = Path(tempfile.mkdtemp(prefix="mirrorgate-"))
        self._session_lock = threading.RLock()
        self._processes: list[SandboxProcess] = []
        self._fds: list[int] = []
        self._closed = False
        self.artifact = None
        self.output = None
        try:
            if self.config.profile == "authoring":
                # Scan the initial source, rejecting pre-existing sockets/links.
                inspected = freeze_tree(self.config.workspace, self._owned)
                remove_snapshot(inspected.path)
                self.workspace = Path(self.config.workspace)
            else:
                self.artifact = freeze_tree(self.config.workspace, self._owned)
                self.workspace = self.artifact.path
            self.workspace_fd = _open_directory(self.workspace)
            self._fds.append(self.workspace_fd)
            self.runtime_fds = []
            for mount in self.config.runtime_mounts:
                fd = _open_directory(Path(mount.source))
                self._fds.append(fd)
                self.runtime_fds.append((fd, mount.destination))
            if self.config.profile == "build":
                self.output = Path(self.config.output) if self.config.output else self._owned / "output"
                self.output.mkdir(mode=0o700, exist_ok=True)
                self.output_fd = _open_directory(self.output)
                self._fds.append(self.output_fd)
            writable_fds = []
            if self.config.profile == "authoring":
                writable_fds.append(self.workspace_fd)
            if self.config.profile == "build":
                writable_fds.append(self.output_fd)
            # Compare pinned roots too: distinct path spellings can refer to
            # the same directory through an operator-created mount alias.
            runtime_identities = {(os.fstat(fd).st_dev, os.fstat(fd).st_ino) for fd, _ in self.runtime_fds}
            for fd in writable_fds:
                identity = (os.fstat(fd).st_dev, os.fstat(fd).st_ino)
                if identity in runtime_identities:
                    raise AdmissionError("writable mount aliases an approved runtime root")
        except BaseException:
            self.close()
            raise

    @property
    def mount_path(self) -> str:
        return {"authoring": "/workspace", "build": "/source", "execution": "/artifact"}[self.config.profile]

    def command(self, request: ToolRequest) -> list[str]:
        """Build trusted backend argv; submission arguments follow an explicit --."""
        request = request.validate()
        limits = self.config.limits
        argv = ["/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-net", "--unshare-uts", "--disable-userns", "--assert-userns-disabled", "--cap-drop", "ALL", "--clearenv", "--new-session", "--die-with-parent", "--as-pid-1", "--hostname", "mirrorgate"]
        for fd, destination in self.runtime_fds:
            argv.extend(["--ro-bind", f"/proc/self/fd/{fd}", destination])
        for source, destination in (("usr/bin", "/bin"), ("usr/sbin", "/sbin"), ("usr/lib", "/lib"), ("usr/lib64", "/lib64")):
            argv.extend(["--symlink", source, destination])
        argv.extend(["--proc", "/proc", "--dev", "/dev", "--size", str(16 * 1024**2), "--tmpfs", "/dev/shm", "--size", str(limits.tmp_bytes), "--tmpfs", "/tmp", "--size", str(limits.scratch_bytes), "--tmpfs", "/scratch", "--dir", "/scratch/home"])
        argv.extend(["--bind" if self.config.profile == "authoring" else "--ro-bind", f"/proc/self/fd/{self.workspace_fd}", self.mount_path])
        if self.config.profile == "build":
            argv.extend(["--bind", f"/proc/self/fd/{self.output_fd}", "/output"])
        for key, value in (("PATH", "/usr/local/bin:/usr/bin:/bin"), ("HOME", "/scratch/home"), ("TMPDIR", "/tmp"), ("LANG", "C.UTF-8"), ("LC_ALL", "C.UTF-8"), ("PYTHONDONTWRITEBYTECODE", "1")):
            argv.extend(["--setenv", key, value])
        cwd = str(PurePosixPath(self.mount_path) / request.cwd)
        # bubblewrap preserves inherited mount source fds. They refer to host
        # directories, so close them in trusted bootstrap code BEFORE executing
        # any submission. Python isolated mode excludes artifact imports.
        bootstrap = (
            "import os,sys; "
            "fds=[int(x) for x in os.listdir('/proc/self/fd') if x.isdigit() and int(x)>2]; "
            "[(os.close(fd) if os.path.exists('/proc/self/fd/'+str(fd)) else None) for fd in fds]; "
            "os.execvpe(sys.argv[1],sys.argv[1:],os.environ)"
        )
        argv.extend(["--chdir", cwd, "--remount-ro", "/", "--", "/usr/bin/python3", "-I", "-S", "-c", bootstrap, *request.argv])
        return argv

    def start(self, request: ToolRequest) -> SandboxProcess:
        with self._session_lock:
            return self._start(request)

    def _start(self, request: ToolRequest) -> SandboxProcess:
        if self._closed:
            raise AdmissionError("session is closed")
        if any(process.returncode is None for process in self._processes):
            raise AdmissionError("a session permits one active command at a time")
        self._processes = []
        # The helper sets limits in a fresh Python process; no unsafe preexec_fn
        # is run in the multithreaded evaluator.
        argv = [sys.executable, "-m", "mirrorgate.sandbox", "--child", json.dumps(asdict(self.config.limits)), *self.command(request)]
        package_root = str(Path(__file__).resolve().parents[1])
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONPATH": package_root, "LANG": "C.UTF-8"}
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, close_fds=True, pass_fds=tuple(self._fds), start_new_session=True, bufsize=0)
        handle = SandboxProcess(proc, self.config.limits)
        self._processes.append(handle)
        return handle

    def run(self, request: ToolRequest, *, input: bytes = b"") -> RunResult:
        handle = self.start(request)
        def send() -> None:
            try:
                for offset in range(0, len(input), 65536):
                    handle.write(input[offset:offset + 65536])
            except (BrokenPipeError, OSError):
                pass
            finally:
                # A batch request is complete input, not an abandoned live RPC
                # channel. It can continue until normal exit or its wall limit.
                handle.close_stdin(terminate_after_grace=False)
        sender = threading.Thread(target=send, daemon=True)
        sender.start()
        stdout = bytearray()
        stderr = bytearray()
        while chunk := handle.read_stdout():
            stdout.extend(chunk)
        while chunk := handle.read_stderr():
            stderr.extend(chunk)
        code = handle.wait()
        sender.join(timeout=1)
        return RunResult(code, handle.reason, bytes(stdout), bytes(stderr), time.monotonic() - handle.started)

    def close(self) -> None:
        with self._session_lock:
            self._close()

    def _close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for handle in self._processes:
            if handle.returncode is None:
                handle.cancel()
            handle.wait(timeout=5)
        for fd in self._fds:
            os.close(fd)
        self._fds.clear()
        remove_snapshot(self._owned)

    def __enter__(self) -> "GateSession":
        return self

    def __exit__(self, *_args) -> None:
        self.close()


def _child() -> None:
    limits = Limits(**json.loads(sys.argv[2]))
    limits.validate()
    for kind, value in ((resource.RLIMIT_CPU, limits.cpu_seconds), (resource.RLIMIT_AS, limits.address_space_bytes), (resource.RLIMIT_NPROC, limits.uid_processes), (resource.RLIMIT_NOFILE, limits.open_files), (resource.RLIMIT_FSIZE, limits.file_bytes), (resource.RLIMIT_CORE, 0)):
        resource.setrlimit(kind, (value, value))
    libc = ctypes.CDLL(None, use_errno=True)
    # PR_SET_NO_NEW_PRIVS and PR_SET_PDEATHSIG. Close the race with parent exit.
    parent = os.getppid()
    if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "cannot establish launch restrictions")
    if os.getppid() != parent or parent == 1:
        os._exit(125)
    os.umask(0o077)
    os.execve(sys.argv[3], sys.argv[3:], {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})


if __name__ == "__main__":
    if len(sys.argv) > 3 and sys.argv[1] == "--child":
        _child()
    else:
        raise SystemExit("internal launch helper; use mirrorgate.cli")
