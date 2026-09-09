"""One hosted runtime's Linux subreaper. Never install process-wide Gate state.

This trusted child owns every runtime descendant, including double-fork/setsid
children. It publishes a private authenticated receipt only after waitpid proves
that no owned child remains. The parent treats a missing receipt as unconfirmed.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def children(pid):
    result = set()
    try:
        tasks = list((Path('/proc') / str(pid) / 'task').iterdir())
    except OSError:
        return result
    for task in tasks:
        try:
            result.update(int(item) for item in (task / 'children').read_text().split())
        except OSError:
            pass
    return result


def descendants():
    found = set()
    pending = list(children(os.getpid()))
    while pending:
        pid = pending.pop()
        if pid in found:
            continue
        found.add(pid)
        pending.extend(children(pid))
    return found


def signal_owned(pid, sig):
    """Pin the signal target and recheck ancestry so PID reuse cannot hit a peer."""
    try:
        fd = os.pidfd_open(pid, 0)
    except ProcessLookupError:
        return
    try:
        current = pid
        seen = set()
        while current != os.getpid():
            if current <= 1 or current in seen:
                return
            seen.add(current)
            try:
                fields = (Path('/proc') / str(current) / 'stat').read_text().rsplit(')', 1)[1].split()
                current = int(fields[1])
            except (OSError, IndexError, ValueError):
                return
        try:
            signal.pidfd_send_signal(fd, sig)
        except ProcessLookupError:
            pass
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt', required=True)
    parser.add_argument('--token', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        raise SystemExit(125)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise SystemExit(125)
    stopping = None
    def stop(_signal, _frame):
        nonlocal stopping
        if stopping is None:
            stopping = time.monotonic()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    leader = subprocess.Popen(command, stdin=sys.stdin.buffer, stdout=sys.stdout.buffer,
                              stderr=sys.stderr.buffer, close_fds=True)
    leader_code = None
    complete = False
    while True:
        no_children = False
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                no_children = True
                break
            if pid == 0:
                break
            if pid == leader.pid:
                leader_code = os.waitstatus_to_exitcode(status)
                leader.returncode = leader_code
                if stopping is None:
                    stopping = time.monotonic()
        if no_children:
            complete = True
            break
        if stopping is not None:
            elapsed = time.monotonic() - stopping
            if elapsed >= 4:
                break
            sig = signal.SIGTERM if elapsed < 1 else signal.SIGKILL
            for pid in descendants():
                signal_owned(pid, sig)
        time.sleep(.01)
    # On failure leave a failed receipt rather than claim any escaped child is gone.
    record = {'token': args.token, 'complete': complete,
              'teardownStarted': stopping if stopping is not None else time.monotonic(),
              'leaderCode': leader_code}
    fd = os.open(args.receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(record, stream)
    if not complete:
        raise SystemExit(125)
    raise SystemExit(leader_code if leader_code is not None and leader_code >= 0 else 1)


if __name__ == '__main__':
    main()
