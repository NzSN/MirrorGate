"""Administrative launch CLI. Never expose these flags as agent tool inputs."""
import argparse
import os
import select
import signal
import sys
import threading

from .policy import AdmissionError, Limits, RuntimeMount, ToolRequest, TrustedConfig, system_runtime_mounts
from .sandbox import GateSession


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
    control.add_argument("--allowed-uid", type=int, default=os.geteuid(), help="UID admitted by an attached Unix server")
    args = parser.parse_args(argv)
    if args.operation == "control":
        try:
            from .control_server import serve_stream, serve_unix
            from .preparation import ControlBackend
            backend = ControlBackend(args.policy_file)
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
