"""Private managed worker endpoint and bounded worker-v1 relay."""

from __future__ import annotations

import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import stat
import struct
import threading
import time
from typing import Any, Callable

from .protocol import MAX_FRAME_BYTES, ProtocolError, parse_frame, validate_request, validate_response
from .sandbox import GateSession, SandboxProcess


ATTACH_MAX_BYTES = 4096


class BrokerError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _strict_attach(frame: bytes) -> dict[str, Any]:
    if len(frame) > ATTACH_MAX_BYTES + 1 or not frame.endswith(b"\n") or b"\n" in frame[:-1] or b"\r" in frame:
        raise BrokerError("ATTACHMENT_FAILED", "invalid attachment framing")
    try:
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise BrokerError("ATTACHMENT_FAILED", "duplicate attachment field")
                result[key] = value
            return result
        value = json.loads(frame[:-1].decode("utf-8", errors="strict"), object_pairs_hook=pairs,
                           parse_float=lambda _x: (_ for _ in ()).throw(BrokerError("ATTACHMENT_FAILED", "attachment numbers must be integral")),
                           parse_constant=lambda _x: (_ for _ in ()).throw(BrokerError("ATTACHMENT_FAILED", "invalid attachment number")))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise BrokerError("ATTACHMENT_FAILED", "invalid attachment JSON") from exc
    if type(value) is not dict or set(value) != {"v", "kind", "sessionId", "workerId", "attachmentToken"}:
        raise BrokerError("ATTACHMENT_FAILED", "attachment fields do not match contract")
    if type(value["v"]) is not int or value["v"] != 1 or value["kind"] != "attach":
        raise BrokerError("ATTACHMENT_FAILED", "unsupported attachment contract")
    if any(type(value[name]) is not str for name in ("sessionId", "workerId", "attachmentToken")):
        raise BrokerError("ATTACHMENT_FAILED", "attachment handles must be strings")
    if (re.fullmatch(r"[0-9a-f]{32}", value["sessionId"]) is None
            or re.fullmatch(r"[0-9a-f]{32}", value["workerId"]) is None
            or re.fullmatch(r"[0-9a-f]{64}", value["attachmentToken"]) is None):
        raise BrokerError("ATTACHMENT_FAILED", "attachment handles have invalid encoding")
    return value


class WorkerFlow:
    """Observe worker-v1 correlation and enforce closing without translating it."""

    def __init__(self, event: Callable[[str, dict[str, Any]], None]):
        self._event = event
        self.last_id = 0
        self.requests: dict[int, dict[str, Any]] = {}
        self.ordinary_pending: int | None = None
        self.cancel_pending: int | None = None
        self.lifecycle = "awaitHello"
        self.closing = False
        self.cancelled_ever = False
        self.dispose_sent = False
        self.cooperative_failure: str | None = None
        self.lock = threading.RLock()

    def cleanup_mode(self) -> str:
        with self.lock:
            if (self.ordinary_pending is None and self.cancel_pending is None
                    and not self.cancelled_ever and not self.dispose_sent
                    and self.lifecycle in ("created", "ready")):
                return "dispose-then-terminate"
            return "terminate-only"

    def begin_closing(self) -> str:
        with self.lock:
            self.closing = True
            return self.cleanup_mode()

    def client_frame(self, frame: bytes) -> None:
        request = validate_request(parse_frame(frame))
        with self.lock:
            request_id = request["id"]
            op = request["op"]
            if request_id <= self.last_id:
                raise ProtocolError("SCHEMA", "request IDs must increase")
            self.last_id = request_id
            if self.closing:
                if op == "cancel":
                    if self.ordinary_pending != request["requestId"] or self.cancel_pending is not None:
                        raise ProtocolError("LIFECYCLE", "closing permits only cancellation of the pending call")
                elif op == "dispose":
                    if self.cleanup_mode() != "dispose-then-terminate":
                        raise ProtocolError("LIFECYCLE", "worker is not quiescent for cooperative disposal")
                else:
                    raise ProtocolError("LIFECYCLE", "worker is closing")
            if op == "cancel":
                if self.ordinary_pending != request["requestId"] or self.cancel_pending is not None:
                    raise ProtocolError("SCHEMA", "invalid worker cancellation")
                self.cancel_pending = request_id
                self.cancelled_ever = True
            else:
                if self.ordinary_pending is not None:
                    raise ProtocolError("SCHEMA", "worker request pipelining is forbidden")
                if op == "hello" and self.lifecycle != "awaitHello":
                    raise ProtocolError("LIFECYCLE", "unexpected worker hello")
                if op == "create" and self.lifecycle != "awaitCreate":
                    raise ProtocolError("LIFECYCLE", "create requires a successful hello")
                if op not in ("hello", "create") and self.lifecycle not in ("created", "ready"):
                    raise ProtocolError("LIFECYCLE", "worker is not ready")
                if op == "dispose":
                    if self.dispose_sent:
                        raise ProtocolError("LIFECYCLE", "dispose is at most once")
                    self.dispose_sent = True
                self.ordinary_pending = request_id
            self.requests[request_id] = request

    def worker_frame(self, frame: bytes) -> None:
        response = validate_response(parse_frame(frame))
        with self.lock:
            request_id = response["id"]
            request = self.requests.get(request_id)
            if request is None:
                raise ProtocolError("SCHEMA", "uncorrelated worker response")
            if request_id == self.cancel_pending:
                if self.ordinary_pending is not None:
                    raise ProtocolError("SCHEMA", "cancel response preceded cancelled operation response")
                self.cancel_pending = None
            elif request_id == self.ordinary_pending:
                self.ordinary_pending = None
            else:
                raise ProtocolError("SCHEMA", "worker response order is invalid")
            del self.requests[request_id]
            op = request["op"]
            if op == "hello":
                if not response["ok"]:
                    raise ProtocolError("HANDSHAKE", "worker rejected hello")
                result = response["result"]
                if (type(result) is not dict or set(result) != {"interfaceDigest", "runtime"}
                        or result["interfaceDigest"] != request["interfaceDigest"]
                        or result["runtime"] != request["runtime"]):
                    raise ProtocolError("HANDSHAKE", "worker hello identity mismatch")
                self.lifecycle = "awaitCreate"
            elif op == "create":
                if not response["ok"] or response["result"] is not None:
                    raise ProtocolError("HANDSHAKE", "worker create failed")
                self.lifecycle = "created"
                self._event("worker.ready", {})
            elif op == "dispose":
                if response["ok"]:
                    if response["result"] is not None:
                        raise ProtocolError("SCHEMA", "dispose result must be null")
                    self.lifecycle = "disposed"
                else:
                    self.lifecycle = "poisoned"
                    message = response.get("error", {}).get("message", "worker dispose failed")
                    self.cooperative_failure = str(message)[:1024]
            elif not response["ok"]:
                self.lifecycle = "poisoned"
            else:
                self.lifecycle = "ready"


class WorkerReservation:
    """One owner-bound endpoint.  Construction registers every partial resource."""

    def __init__(self, *, owner: Any, principal_uid: int, session_id: str, worker_id: str,
                 admission: Any, endpoint_parent: Path, attachment_timeout_ms: int,
                 launch_guard: Callable[[Any, str, Any], bool],
                 launch: Callable[[], tuple[GateSession, SandboxProcess]],
                 on_event: Callable[[str, dict[str, Any]], None],
                 graceful_stop_ms: int, teardown_timeout_ms: int):
        self.owner = owner
        self.session_id = session_id
        self.worker_id = worker_id
        self.admission = admission
        self.attachment_token = secrets.token_hex(32)
        self._expires_at = time.monotonic() + attachment_timeout_ms / 1000
        self._launch_guard = launch_guard
        self._launch = launch
        self._event = on_event
        self._graceful_stop = graceful_stop_ms / 1000
        self._teardown_timeout = teardown_timeout_ms / 1000
        self._lock = threading.RLock()
        self._teardown_lock = threading.Lock()
        self._close_result: tuple[bool, tuple[str, ...]] | None = None
        self._closed = threading.Event()
        self._closing = False
        self._cleanup_mode: str | None = None
        self._closing_reason: str | None = None
        self._failure: str | None = None
        self._exit_event_sent = False
        self._connection: socket.socket | None = None
        self._gate: GateSession | None = None
        self._process: SandboxProcess | None = None
        self._flow = WorkerFlow(on_event)
        self._threads: list[threading.Thread] = []

        endpoint_parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if stat.S_IMODE(endpoint_parent.stat().st_mode) != 0o700:
            raise BrokerError("ATTACHMENT_FAILED", "worker endpoint directory must have mode 0700")
        self._directory = endpoint_parent / ("worker-" + secrets.token_hex(8))
        self._directory.mkdir(mode=0o700)
        self.endpoint_path = str(self._directory / "port.sock")
        self._listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self._listener.bind(self.endpoint_path)
            os.chmod(self.endpoint_path, 0o600)
            self._listener.listen(1)
            self._listener.settimeout(max(0.001, attachment_timeout_ms / 1000))
        except BaseException:
            self._listener.close()
            shutil.rmtree(self._directory, ignore_errors=True)
            raise
        self._accept_thread = threading.Thread(target=self._accept, daemon=True,
                                               name="mirrorgate-worker-attach")
        self._accept_thread.start()

    @property
    def attachment_timeout_ms(self) -> int:
        return max(0, int((self._expires_at - time.monotonic()) * 1000))

    @property
    def failure(self) -> str | None:
        return self._failure

    def cleanup_mode(self) -> str:
        with self._lock:
            if self._process is None:
                return "terminate-only"
            return self._flow.cleanup_mode()

    def arm_closing(self, *, reason: str) -> str:
        """Atomically block ordinary RPC before control acknowledges release."""
        with self._lock:
            if self._cleanup_mode is None:
                self._closing = True
                self._closing_reason = reason
                self._cleanup_mode = (self._flow.begin_closing() if self._process is not None
                                      else "terminate-only")
                self._event("worker.closing", {"reason": reason,
                                               "cleanupMode": self._cleanup_mode})
            return self._cleanup_mode

    def _receive_attach(self, connection: socket.socket) -> bytes:
        data = bytearray()
        while b"\n" not in data:
            if time.monotonic() >= self._expires_at:
                raise BrokerError("ATTACHMENT_FAILED", "worker attachment expired")
            chunk = connection.recv(min(1024, ATTACH_MAX_BYTES + 1 - len(data)))
            if not chunk:
                raise BrokerError("ATTACHMENT_FAILED", "worker attachment ended before a frame")
            data.extend(chunk)
            if len(data) > ATTACH_MAX_BYTES:
                raise BrokerError("ATTACHMENT_FAILED", "worker attachment exceeds 4 KiB")
        split = data.index(0x0A) + 1
        if split != len(data):
            raise BrokerError("ATTACHMENT_FAILED", "worker bytes cannot precede attachment acknowledgement")
        return bytes(data)

    def _accept(self) -> None:
        try:
            connection = None
            while connection is None:
                with self._lock:
                    if self._closing:
                        return
                remaining = self._expires_at - time.monotonic()
                if remaining <= 0:
                    raise BrokerError("ATTACHMENT_FAILED", "worker attachment expired")
                self._listener.settimeout(remaining)
                candidate, _ = self._listener.accept()
                try:
                    candidate.settimeout(remaining)
                    credentials = candidate.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
                    _pid, uid, _gid = struct.unpack("3i", credentials)
                    if uid != self.owner.principal_uid or uid != os.getuid():
                        raise BrokerError("ATTACHMENT_FAILED", "worker attachment principal mismatch")
                    attach = _strict_attach(self._receive_attach(candidate))
                    if (attach["sessionId"] != self.session_id or attach["workerId"] != self.worker_id
                            or not hmac.compare_digest(attach["attachmentToken"], self.attachment_token)):
                        raise BrokerError("ATTACHMENT_FAILED", "worker attachment authority is invalid")
                    if time.monotonic() >= self._expires_at:
                        raise BrokerError("ATTACHMENT_FAILED", "worker attachment expired")
                    connection = candidate
                except BrokerError:
                    # A forged/stale attempt cannot consume another owner's
                    # one-use reservation.  Keep accepting until the deadline.
                    candidate.close()
                    continue
            if not self._launch_guard(self.owner, self.worker_id, self.admission):
                connection.close()
                raise BrokerError("ATTACHMENT_FAILED", "worker launch is no longer authorized")
            with self._lock:
                if self._closing:
                    connection.close()
                    return
            # Store both objects before emitting or acknowledging any event.
            gate, process = self._launch()
            with self._lock:
                if self._closing:
                    process.cancel()
                    gate.close()
                    connection.close()
                    return
                self._connection = connection
                self._gate = gate
                self._process = process
            self._event("worker.started", {})
            acknowledgement = json.dumps({"v": 1, "kind": "attached", "sessionId": self.session_id,
                                          "workerId": self.worker_id}, separators=(",", ":")).encode() + b"\n"
            connection.settimeout(1)
            connection.sendall(acknowledgement)
            connection.settimeout(None)
            for target, name in ((self._client_to_worker, "client-relay"),
                                 (self._worker_to_client, "worker-relay"),
                                 (self._drain_stderr, "stderr-drain")):
                thread = threading.Thread(target=target, daemon=True, name="mirrorgate-" + name)
                self._threads.append(thread)
                thread.start()
        except socket.timeout:
            self._fail("worker attachment deadline exceeded", reason="worker-failure")
        except BaseException as exc:
            self._fail(str(exc), reason="worker-failure")
        finally:
            self._listener.close()

    @staticmethod
    def _frames(buffer: bytearray, chunk: bytes) -> list[bytes]:
        buffer.extend(chunk)
        if len(buffer) > MAX_FRAME_BYTES + 1 and b"\n" not in buffer:
            raise ProtocolError("LIMIT", "unterminated worker frame exceeds limit")
        frames = []
        while b"\n" in buffer:
            split = buffer.index(0x0A) + 1
            if split > MAX_FRAME_BYTES + 1:
                raise ProtocolError("LIMIT", "worker frame exceeds limit")
            frames.append(bytes(buffer[:split]))
            del buffer[:split]
        return frames

    def _client_to_worker(self) -> None:
        buffer = bytearray()
        try:
            assert self._connection is not None and self._process is not None
            while chunk := self._connection.recv(65_536):
                for frame in self._frames(buffer, chunk):
                    self._flow.client_frame(frame)
                    self._process.write(frame)
            if buffer:
                raise ProtocolError("FRAME", "unterminated worker request")
            self._fail("worker client disconnected", reason="client-failure")
        except BaseException as exc:
            self._fail(str(exc), reason="worker-failure")

    def _worker_to_client(self) -> None:
        buffer = bytearray()
        try:
            assert self._connection is not None and self._process is not None
            while chunk := self._process.read_stdout():
                for frame in self._frames(buffer, chunk):
                    self._flow.worker_frame(frame)
                    self._connection.sendall(frame)
            if buffer:
                raise ProtocolError("FRAME", "unterminated worker response")
            with self._lock:
                self._exit_event_sent = True
            reason = self._closing_reason
            if reason is None:
                reason = ("normal" if self._process.reason == "exited" else
                          "deadline" if self._process.reason == "wall_timeout" else
                          "worker-failure")
            data = {"reason": reason}
            if self._process.returncode is not None:
                data["returncode"] = self._process.returncode
            self._event("worker.exited", data)
            self._closed.set()
        except BaseException as exc:
            self._fail(str(exc), reason="worker-failure")

    def _drain_stderr(self) -> None:
        try:
            assert self._process is not None
            while self._process.read_stderr():
                pass
        except BaseException as exc:
            self._fail(str(exc), reason="worker-failure")

    def _fail(self, message: str, *, reason: str) -> None:
        with self._lock:
            if self._failure is None:
                self._failure = message[:1024]
            self._closing = True
            self._flow.begin_closing()
            process = self._process
            connection = self._connection
            emit_exit = not self._exit_event_sent
            self._exit_event_sent = True
        if connection is not None:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()
        if process is not None and process.returncode is None:
            process.cancel()
        if emit_exit:
            data = {"reason": reason}
            if process is not None and process.returncode is not None:
                data["returncode"] = process.returncode
            self._event("worker.exited", data)
        self._closed.set()

    def close(self, *, reason: str, cleanup_mode: str | None = None,
              deadline: float | None = None) -> tuple[bool, tuple[str, ...]]:
        deadline = min(deadline, time.monotonic() + self._teardown_timeout) if deadline is not None else time.monotonic() + self._teardown_timeout
        if not self._teardown_lock.acquire(timeout=max(0, deadline - time.monotonic())):
            return False, ("worker cleanup did not serialize before deadline",)
        try:
            if self._close_result is not None:
                return self._close_result
            result = self._close_locked(reason=reason, cleanup_mode=cleanup_mode, deadline=deadline)
            self._close_result = result
            return result
        finally:
            self._teardown_lock.release()

    def _close_locked(self, *, reason: str, cleanup_mode: str | None,
                      deadline: float) -> tuple[bool, tuple[str, ...]]:
        with self._lock:
            mode = cleanup_mode or self._cleanup_mode
        if mode is None:
            mode = self.arm_closing(reason=reason)
        with self._lock:
            process = self._process
            connection = self._connection
        physical_failures: list[str] = []
        if process is not None and process.returncode is None:
            if mode == "dispose-then-terminate":
                self._closed.wait(min(self._graceful_stop, max(0, deadline - time.monotonic())))
            if process.returncode is None:
                process.terminate()
                try:
                    process.wait(timeout=min(0.25, max(0.001, deadline - time.monotonic())))
                except TimeoutError:
                    process.cancel()
                    try:
                        process.wait(timeout=max(0.001, deadline - time.monotonic()))
                    except TimeoutError:
                        physical_failures.append("worker process did not terminate before cleanup deadline")
        if connection is not None:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()
        try:
            self._listener.close()
        except OSError as exc:
            physical_failures.append(f"listener close failed: {exc}")
        if self._accept_thread is not threading.current_thread():
            self._accept_thread.join(timeout=max(0, deadline - time.monotonic()))
            if self._accept_thread.is_alive():
                physical_failures.append("worker attachment or launch did not quiesce before cleanup deadline")
        if self._gate is not None:
            try:
                self._gate.close(timeout=max(0, deadline - time.monotonic()))
            except BaseException as exc:
                physical_failures.append(f"sandbox cleanup failed: {exc}")
        # The dispose reply can arrive during the cooperative wait.  Read it
        # only after the worker channel/process has quiesced and retain it even
        # when every physical resource was removed successfully.
        cooperative_failures: list[str] = []
        with self._flow.lock:
            if self._flow.cooperative_failure is not None:
                cooperative_failures.append("cooperative dispose failed: " + self._flow.cooperative_failure)
        try:
            if Path(self.endpoint_path).exists():
                Path(self.endpoint_path).unlink()
            self._directory.rmdir()
        except OSError as exc:
            physical_failures.append(f"endpoint cleanup failed: {exc}")
        self._closed.set()
        return not physical_failures, tuple(physical_failures + cooperative_failures)
