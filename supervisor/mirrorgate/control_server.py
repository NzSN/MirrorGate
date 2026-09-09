"""Bounded stdio and credential-checked filesystem Unix serving for negotiated control v1/v2."""
from __future__ import annotations

import os
from pathlib import Path
import queue
import select
import socket
import stat
import struct
import threading
import time

from .control_protocol import MAX_FRAME_BYTES, ControlProtocolError, encode_control_frame, parse_control_frame, validate_request
from .orchestration import OrchestrationController

MAX_PENDING_OUTPUT = 4 * 1024 * 1024


class _Output:
    def __init__(self, writer, stop):
        self.writer, self.stop = writer, stop
        self.queue = queue.Queue(); self.lock = threading.Lock(); self.pending = 0
        try:
            self.fd = writer.fileno(); self.was_blocking = os.get_blocking(self.fd); os.set_blocking(self.fd, False)
        except Exception:
            self.fd = None; self.was_blocking = None
        self.thread = threading.Thread(target=self._run, daemon=True, name="mirrorgate-control-writer")
        self.thread.start()

    def send(self, message):
        data = encode_control_frame(message)
        with self.lock:
            if self.stop.is_set(): return False
            if self.pending + len(data) > MAX_PENDING_OUTPUT:
                self.stop.set(); return False
            self.pending += len(data)
        self.queue.put(data); return True

    def _run(self):
        try:
            while True:
                data = self.queue.get()
                if data is None: return
                sent=0; view=memoryview(data)
                while view and not self.stop.is_set():
                    if self.fd is None:
                        count=self.writer.write(view)
                        if count is None: count=len(view)
                        self.writer.flush()
                    else:
                        _,writable,_=select.select([],[self.fd],[],.05)
                        if not writable: continue
                        try: count=os.write(self.fd,view)
                        except BlockingIOError: continue
                    if not count: raise BrokenPipeError("control output stopped accepting bytes")
                    sent+=count;view=view[count:]
                with self.lock: self.pending -= len(data)
                if self.stop.is_set():
                    while True:
                        try:
                            dropped=self.queue.get_nowait()
                            if dropped is None:return
                            with self.lock:self.pending-=len(dropped)
                        except queue.Empty:return
        except (BrokenPipeError, OSError, ValueError):
            self.stop.set()

    def close(self, timeout=1.0):
        deadline=time.monotonic()+timeout
        self.queue.put(None); self.thread.join(max(0,min(timeout*.8,deadline-time.monotonic())))
        if self.thread.is_alive():
            self.stop.set();self.thread.join(max(0,deadline-time.monotonic()))
        if self.fd is not None and self.was_blocking is not None:
            try:os.set_blocking(self.fd,self.was_blocking)
            except OSError:pass


def serve_stream(reader, writer, backend, *, principal_uid: int, connection_mode: str,
                 connection_id: str | None = None, frame_timeout: float = 5.0) -> None:
    """Serve one owned connection until EOF or a terminal protocol violation."""
    stop = threading.Event(); output = _Output(writer, stop)
    controller = OrchestrationController(backend, connection_id=connection_id or os.urandom(16).hex(),
                                         principal_uid=principal_uid, connection_mode=connection_mode,
                                         emit=output.send)
    try:
        first = True; hello_deadline = time.monotonic() + frame_timeout; partial_at = None; buffer = bytearray()
        try: fd = reader.fileno()
        except Exception: fd = None
        while not stop.is_set():
            if fd is None:
                data = reader.readline(MAX_FRAME_BYTES + 2)
                if not data: break
            else:
                if b"\n" not in buffer:
                    now=time.monotonic()
                    if (first and now >= hello_deadline) or (partial_at is not None and now-partial_at >= frame_timeout): break
                    ready,_,_=select.select([fd],[],[],min(.1,max(0,hello_deadline-now)) if first else .1)
                    if not ready: continue
                    chunk=os.read(fd,65536)
                    if not chunk: break
                    if partial_at is None: partial_at=time.monotonic()
                    buffer.extend(chunk)
                    if len(buffer)>MAX_FRAME_BYTES+1 and b"\n" not in buffer[:MAX_FRAME_BYTES+1]: break
                    continue
                split=buffer.index(0x0a)+1; data=bytes(buffer[:split]); del buffer[:split]; partial_at=time.monotonic() if buffer else None
            if len(data) > MAX_FRAME_BYTES + 1 or not data.endswith(b"\n"): break
            current_op=None
            try:
                request = controller.validate_request(parse_control_frame(data))
                current_op=request["op"]
                response = controller.dispatch(request)
            except ControlProtocolError as exc:
                if exc.fatal: break
                # A valid envelope should normally be handled by dispatch. Keep
                # correlation if argument validation rejected it before dispatch.
                parsed_id = None
                try:
                    raw = parse_control_frame(data); parsed_id = raw.get("id");current_op=raw.get("op")
                except ControlProtocolError:
                    break
                if type(parsed_id) is not int or parsed_id < 1: break
                response = controller.reject_arguments(raw, exc)
            if not output.send(response): break
            controller.after_response()
            if current_op == "hello" and not response["ok"]: break
            first = False
    finally:
        controller.close(); output.close()


def _secure_parent(path: Path, uid: int):
    if not path.is_absolute() or path.name in ("", ".", ".."):
        raise ValueError("control socket path must be an absolute file path")
    current = Path(path.anchor)
    for part in path.parent.parts[1:]:
        current /= part
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode): raise ValueError("control socket path has a symlink component")
    info = os.stat(path.parent, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("control socket directory must be owned by the serving UID with mode 0700")
    if path.exists() or path.is_symlink(): raise ValueError("control socket path already exists")


def serve_unix(path: str | Path, backend, *, allowed_uid: int | None = None, max_connections=16) -> None:
    """Serve attached clients on a secure filesystem socket until interrupted."""
    uid = os.geteuid() if allowed_uid is None else allowed_uid
    socket_path = Path(path); _secure_parent(socket_path, os.geteuid())
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    threads: set[threading.Thread] = set(); connections: set[socket.socket] = set(); lock = threading.Lock()
    try:
        listener.bind(str(socket_path)); os.chmod(socket_path, 0o600); listener.listen(max_connections)
        while True:
            connection, _ = listener.accept()
            peer_pid, peer_uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
            if peer_uid != uid:
                connection.close(); continue
            with lock:
                threads = {thread for thread in threads if thread.is_alive()}
                if len(threads) >= max_connections:
                    connection.close(); continue
                connections.add(connection)
            def run(conn=connection, principal=peer_uid, identity=f"unix-{peer_pid}-{os.urandom(8).hex()}"):
                try:
                    with conn, conn.makefile("rb", buffering=0) as reader, conn.makefile("wb", buffering=0) as writer:
                        serve_stream(reader, writer, backend, principal_uid=principal, connection_mode="unix", connection_id=identity)
                finally:
                    with lock: connections.discard(conn)
            thread = threading.Thread(target=run, daemon=True, name="mirrorgate-control-connection")
            with lock: threads.add(thread)
            thread.start()
    finally:
        listener.close()
        with lock: active_connections=list(connections)
        for connection in active_connections:
            try:connection.shutdown(socket.SHUT_RDWR)
            except OSError:pass
            connection.close()
        try: socket_path.unlink()
        except FileNotFoundError: pass
        with lock: live = list(threads)
        deadline=time.monotonic()+5
        for thread in live: thread.join(max(0,deadline-time.monotonic()))
