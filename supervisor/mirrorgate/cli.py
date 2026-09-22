"""Administrative launch CLI. Never expose these flags as agent tool inputs."""
import argparse
import json
import os
import select
import signal
import stat
import sys
import threading
from pathlib import Path

from .policy import AdmissionError, Limits, RuntimeMount, ToolRequest, TrustedConfig, system_runtime_mounts
from .sandbox import GateSession


def _write_private_receipt(path_value, receipt) -> None:
    path = Path(path_value)
    if (not path.is_absolute() or ".." in path.parts
            or path.name in ("", ".", "..")):
        raise AdmissionError("recovery receipt path must be an absolute new file")
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        directory_flags |= os.O_NOFOLLOW
    parent_fd = os.open("/", directory_flags)
    try:
        for part in path.parent.parts[1:]:
            next_fd = os.open(part, directory_flags, dir_fd=parent_fd)
            os.close(parent_fd)
            parent_fd = next_fd
        parent = os.fstat(parent_fd)
        if (parent.st_uid != os.geteuid()
                or stat.S_IMODE(parent.st_mode) != 0o700):
            raise AdmissionError(
                "recovery receipt directory must be owner-only mode 0700")
        encoded = (json.dumps(receipt, sort_keys=True, separators=(",", ":"),
                              ensure_ascii=True) + "\n").encode("ascii")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(path.name, flags, 0o600, dir_fd=parent_fd)
        complete = False
        try:
            view = memoryview(encoded)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise OSError("short recovery receipt write")
                view = view[count:]
            os.fsync(fd)
            created = os.fstat(fd)
            if (not stat.S_ISREG(created.st_mode)
                    or created.st_uid != os.geteuid()
                    or stat.S_IMODE(created.st_mode) != 0o600):
                raise AdmissionError("recovery receipt is not owner-only mode 0600")
            complete = True
        finally:
            os.close(fd)
            if not complete:
                try:
                    os.unlink(path.name, dir_fd=parent_fd)
                except OSError:
                    pass
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="operation", required=True)
    run = subparsers.add_parser("run", aliases=["exec"], help="trusted controller: launch isolated command")
    run.add_argument("--profile", required=True, choices=("authoring", "build", "execution"))
    run.add_argument("--workspace", required=True)
    run.add_argument("--output")
    run.add_argument("--cwd", default=".")
    run.add_argument("--runtime-root", action="append", default=[], metavar="HOST:/runtime/NAME")
    run.add_argument("--wall-seconds", type=float, default=30)
    run.add_argument("--cpu-seconds", type=int, default=20)
    run.add_argument("--uid-processes", type=int, default=4096)
    run.add_argument("--address-space-bytes", type=int, default=4 * 1024**3)
    run.add_argument("--stdout-bytes", type=int, default=4 * 1024**2)
    run.add_argument("--stderr-bytes", type=int, default=1024**2)
    run.add_argument("--eof-grace-seconds", type=float, default=0.5)
    run.add_argument("command", nargs=argparse.REMAINDER)
    control = subparsers.add_parser("control", help="serve negotiated orchestration control v1/v2")
    mode = control.add_mutually_exclusive_group(required=True)
    mode.add_argument("--stdio", action="store_true", help="serve one owned stdin/stdout connection")
    mode.add_argument("--unix-socket", metavar="PATH", help="serve attached filesystem Unix connections")
    control.add_argument("--policy-file", required=True, help="operator-owned control policy catalog")
    control.add_argument("--state-root", help="operator-created mode-0700 durable recovery root")
    control.add_argument("--cgroup-parent", help="operator-delegated disposable cgroup-v2 parent")
    control.add_argument("--allowed-uid", type=int, default=os.geteuid(), help="UID admitted by an attached Unix server")
    recovery = subparsers.add_parser("recovery", help="offline trusted recovery administration")
    recovery.add_argument("action", choices=("inspect", "reclaim"))
    recovery.add_argument("--state-root", required=True)
    recovery.add_argument("--cgroup-parent")
    recovery.add_argument("--run-ref")
    recovery.add_argument("--envelope-sha256")
    recovery.add_argument("--original-behavior", choices=("passed","failed","inconclusive","not_run"))
    recovery.add_argument("--original-cleanup", choices=("confirmed","failed","unconfirmed","not_applicable"))
    recovery.add_argument("--receipt", help="exclusive mode-0600 private recovery receipt output")
    args = parser.parse_args(argv)
    if args.operation == "control":
        try:
            from .control_server import serve_stream, serve_unix
            from .preparation import ControlBackend
            backend = ControlBackend(args.policy_file, state_root=args.state_root,
                                     cgroup_parent=args.cgroup_parent)
            try:
                if args.stdio:
                    serve_stream(sys.stdin.buffer, sys.stdout.buffer, backend,
                                 principal_uid=os.geteuid(), connection_mode="stdio")
                else:
                    serve_unix(args.unix_socket, backend, allowed_uid=args.allowed_uid)
            finally:
                backend.close()
            return 0
        except (AdmissionError, OSError, ValueError) as exc:
            print(f"mirrorgate: control admission rejected: {exc}", file=sys.stderr)
            return 125
    if args.operation == "recovery":
        try:
            from .recovery import inspect, reclaim
            reclaim_only = (args.cgroup_parent, args.run_ref, args.envelope_sha256,
                            args.original_behavior, args.original_cleanup,
                            args.receipt)
            if args.action == "inspect" and any(reclaim_only):
                raise AdmissionError("reclaim-only arguments cannot be used with inspect")
            original=None
            if any((args.run_ref,args.envelope_sha256,args.original_behavior,args.original_cleanup)):
                if not all((args.run_ref,args.envelope_sha256,args.original_behavior,args.original_cleanup)):
                    raise AdmissionError("original run linkage requires all fields")
                original={"runRef":{"schemaVersion":"mirrors.evidence-envelope/v1.0","runId":args.run_ref,"envelopeSha256":args.envelope_sha256,"projectionKind":"private"},"behavior":args.original_behavior,"cleanup":args.original_cleanup}
            result = inspect(args.state_root) if args.action == "inspect" else reclaim(
                args.state_root, cgroup_parent=args.cgroup_parent, original=original)
            if args.receipt is not None:
                _write_private_receipt(args.receipt, result["receipt"])
            sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
            return 0
        except (AdmissionError, OSError, ValueError) as exc:
            print(f"mirrorgate: recovery rejected: {exc}", file=sys.stderr)
            return 125
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    try:
        mounts = list(system_runtime_mounts())
        for item in args.runtime_root:
            if ":" not in item:
                raise AdmissionError("runtime-root must contain HOST:/runtime/NAME")
            source, destination = item.rsplit(":", 1)
            mounts.append(RuntimeMount(source, destination))
        limits = Limits(wall_seconds=args.wall_seconds, cpu_seconds=args.cpu_seconds, uid_processes=args.uid_processes, address_space_bytes=args.address_space_bytes, stdout_bytes=args.stdout_bytes, stderr_bytes=args.stderr_bytes, eof_grace_seconds=args.eof_grace_seconds)
        config = TrustedConfig(args.profile, args.workspace, args.output, tuple(mounts), limits)
        with GateSession(config) as session:
            handle = session.start(ToolRequest(tuple(command), args.cwd))
            old_handlers = {}
            for signum in (signal.SIGINT, signal.SIGTERM):
                old_handlers[signum] = signal.signal(signum, lambda *_: handle.cancel())
            def input_pump():
                try:
                    while chunk := os.read(sys.stdin.fileno(), 65536):
                        handle.write(chunk)
                except (BrokenPipeError, OSError):
                    pass
                finally:
                    handle.close_stdin(terminate_after_grace=args.profile == "execution")
            output_stop = threading.Event()
            output_blocked = threading.Event()
            def output_pump(reader, destination):
                try:
                    while chunk := reader():
                        remaining = memoryview(chunk)
                        while remaining:
                            if output_stop.is_set():
                                output_blocked.set()
                                return
                            try:
                                count = os.write(destination, remaining)
                                remaining = remaining[count:]
                            except BlockingIOError:
                                select.select([], [destination], [], 0.05)
                except (BrokenPipeError, OSError):
                    handle.cancel()
            stdout_fd, stderr_fd = sys.stdout.fileno(), sys.stderr.fileno()
            prior_blocking = {fd: os.get_blocking(fd) for fd in (stdout_fd, stderr_fd)}
            for fd in prior_blocking:
                os.set_blocking(fd, False)
            readers = [threading.Thread(target=output_pump, args=(handle.read_stdout, stdout_fd), daemon=True), threading.Thread(target=output_pump, args=(handle.read_stderr, stderr_fd), daemon=True)]
            for thread in readers:
                thread.start()
            threading.Thread(target=input_pump, daemon=True).start()
            code = handle.wait()
            for thread in readers:
                thread.join(timeout=1)
            output_stop.set()
            for thread in readers:
                thread.join(timeout=.2)
            for signum, handler in old_handlers.items():
                signal.signal(signum, handler)
            for fd, blocking in prior_blocking.items():
                os.set_blocking(fd, blocking)
            if output_blocked.is_set():
                return 125
            if handle.reason not in ("exited", "failed"):
                print(f"mirrorgate: {handle.reason}", file=sys.stderr)
                return 124 if handle.reason == "wall_timeout" else 125
            return code if 0 <= code <= 255 else 125
    except (AdmissionError, OSError, ValueError) as exc:
        print(f"mirrorgate: admission rejected: {exc}", file=sys.stderr)
        return 125


if __name__ == "__main__":
    raise SystemExit(main())
