"""Private one-run broker. Requests can only operate on pre-bound callbacks."""
from __future__ import annotations
import json
import os
from pathlib import Path
import secrets
import socket
import struct
import threading
from typing import Any, Callable

MAX_FRAME = 1048576


def strict_json(data: bytes) -> Any:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate field")
            result[key] = value
        return result
    value = json.loads(data.decode("utf-8"), object_pairs_hook=pairs,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid number")))
    nodes = [value]
    count = 0
    def visit(item, depth):
        nonlocal count
        count += 1
        if depth > 32 or count > 20000:
            raise ValueError("JSON structure exceeds limit")
        if isinstance(item, dict):
            for child in item.values():
                visit(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                visit(child, depth + 1)
    visit(value, 0)
    return value


def tool_definitions():
    return [
        {"name": "public_contract", "description": "Read all approved implementation requirements and public files.",
         "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
        {"name": "gate_exec", "description": "Execute an approved tool inside the fixed restricted authoring workspace. All source access and tests use this operation.",
         "inputSchema": {"type": "object", "properties": {"toolId": {"type": "string"},
             "args": {"type": "array", "items": {"type": "string"}, "maxItems": 128}},
             "required": ["toolId", "args"], "additionalProperties": False}},
        {"name": "submit", "description": "Irrevocably seal and submit source. Further authoring is denied.",
         "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    ]


class AuthoringBroker:
    def __init__(self, root: Path, *, contract: dict[str, Any], execute: Callable,
                 submit: Callable, tool_ids: tuple[str, ...]):
        self.path = root / "broker.sock"
        self.token = secrets.token_hex(32)
        # Canonical owned copy; caller mutation never changes disclosed context.
        self.contract = strict_json(json.dumps(contract, ensure_ascii=True).encode())
        self.contract["tools"] = list(tool_ids)
        self.execute = execute
        self.submit = submit
        self.tool_ids = frozenset(tool_ids)
        self.closed = threading.Event()
        self.submitted = threading.Event()
        self.lock = threading.RLock()
        self.tool_active = False
        self.submitting = False
        self.submission = None
        self.submit_done = threading.Event()
        self.connections = set()
        self.threads = set()
        self.slots = threading.BoundedSemaphore(4)
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.socket.bind(str(self.path))
            self.path.chmod(0o600)
            self.socket.listen(4)
            self.socket.settimeout(.1)
        except BaseException:
            self.socket.close()
            self.path.unlink(missing_ok=True)
            raise
        self.thread = threading.Thread(target=self._serve, daemon=True, name="gate-author-broker")
        self.thread.start()

    def dispatch(self, request):
        if type(request) is not dict or type(request.get("id")) is not int or not 1 <= request["id"] <= 2**53-1:
            raise ValueError("invalid request")
        op = request.get("op")
        fields = {"id", "token", "op", "toolId", "args"} if op == "exec" else {"id", "token", "op"}
        if set(request) != fields or not isinstance(request.get("token"), str) or not secrets.compare_digest(request["token"], self.token):
            raise ValueError("invalid owner")
        with self.lock:
            if self.closed.is_set():
                raise ValueError("broker closed")
            if op == "submit" and self.submission is not None:
                return {"submitted": True}  # private hashes/handles remain in control plane
            join_submission = op == "submit" and self.submitting
            if (self.submitting and not join_submission) or self.submission is not None:
                raise ValueError("authoring revoked")
            if op == "contract":
                return {"contract": self.contract}
            if op == "submit":
                self.submitting = True
            elif op == "exec":
                args = request["args"]
                if (request["toolId"] not in self.tool_ids or type(args) is not list or len(args) > 128
                        or any(type(arg) is not str or not arg or "\0" in arg for arg in args)
                        or sum(len(arg.encode("utf-8")) for arg in args) > 60000 or self.tool_active):
                    raise ValueError("tool denied")
                self.tool_active = True
            else:
                raise ValueError("unknown operation")
        if op == "submit":
            if join_submission:
                if not self.submit_done.wait(90) or self.submission is None:
                    raise ValueError("submission unavailable")
                return {"submitted": True}
            # Callback stops active tool and commits under the authoritative session lock.
            try:
                result = self.submit()
                with self.lock:
                    self.submission = result
                    self.submitted.set()
                return {"submitted": True}
            finally:
                self.submit_done.set()
        try:
            result = self.execute(request["toolId"], request["args"])
            encoded = json.dumps(result, ensure_ascii=True).encode()
            if len(encoded) > MAX_FRAME - 256:
                raise ValueError("tool result exceeds limit")
            return result
        finally:
            with self.lock:
                self.tool_active = False

    def _serve(self):
        while not self.closed.is_set():
            try:
                connection, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            if not self.slots.acquire(blocking=False):
                connection.close()
                continue
            with self.lock:
                # close() may have begun after accept but before registration.
                # Never create an untracked connection after its cleanup snapshot.
                if self.closed.is_set():
                    connection.close()
                    self.slots.release()
                    return
                self.connections.add(connection)
                thread = threading.Thread(target=self._connection, args=(connection,), daemon=True)
                self.threads.add(thread)
                try:
                    # Registration and startup are atomic with close's snapshot:
                    # joining an admitted but not-yet-started thread is invalid.
                    thread.start()
                except BaseException:
                    self.connections.discard(connection)
                    self.threads.discard(thread)
                    connection.close()
                    self.slots.release()
                    raise

    def _connection(self, connection):
        ident = None
        try:
            connection.settimeout(2)
            _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.getuid():
                raise ValueError("foreign principal")
            with connection.makefile("rb") as stream:
                raw = stream.readline(MAX_FRAME + 1)
                if not raw.endswith(b"\n") or len(raw) > MAX_FRAME:
                    raise ValueError("invalid frame")
                request = strict_json(raw)
                if type(request) is dict and type(request.get("id")) is int:
                    ident = request["id"]
                result = {"id": ident, "ok": True, **self.dispatch(request)}
        except Exception:
            result = {"id": ident, "ok": False, "error": "authoring request denied"}
        try:
            encoded = json.dumps(result, ensure_ascii=False).encode("utf-8") + b"\n"
            if len(encoded) > MAX_FRAME:
                encoded = json.dumps({"id": ident, "ok": False, "error": "authoring output limit"}).encode() + b"\n"
            connection.sendall(encoded)
        except OSError:
            pass
        finally:
            connection.close()
            with self.lock:
                self.connections.discard(connection)
                self.threads.discard(threading.current_thread())
            self.slots.release()

    def close(self, timeout=5.0) -> bool:
        import time
        self.closed.set()
        self.submit_done.set()  # unblock duplicate submit joiners on owner shutdown
        self.socket.close()
        deadline = time.monotonic() + timeout
        with self.lock:
            for connection in tuple(self.connections):
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            threads = tuple(self.threads)
        self.thread.join(max(0, deadline - time.monotonic()))
        for thread in threads:
            thread.join(max(0, deadline - time.monotonic()))
        self.path.unlink(missing_ok=True)
        return not self.thread.is_alive() and not any(thread.is_alive() for thread in threads)
