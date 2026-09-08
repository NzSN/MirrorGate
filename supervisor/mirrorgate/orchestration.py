"""Connection-owned orchestration state machine for control protocol v1."""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
import hashlib
import secrets
import threading
import time
from typing import Any, Callable

from .control_protocol import ControlProtocolError, canonical_base64
from .protocol import _parse_json, validate_manifest


@dataclass
class OperationRecord:
    operation_id: int
    status: str = "pending"
    result: Any = None
    error: dict | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    advertised: bool = True
    notified: bool = False

    def public(self) -> dict:
        value = {"operationId": self.operation_id, "status": self.status}
        if self.status == "succeeded": value["result"] = self.result
        if self.status == "failed": value["error"] = self.error
        return value


@dataclass
class SessionState:
    session_id: str
    owner: Any
    backend_state: Any
    policy_id: str
    submission: dict
    runtime: str
    manifest_json: str
    manifest: dict
    manifest_hash: str
    phase: str
    lock: threading.RLock = field(default_factory=threading.RLock)
    operations: OrderedDict[int, OperationRecord] = field(default_factory=OrderedDict)
    next_operation_id: int = 1
    active_ordinary: int | None = None
    cleanup_operation: int | None = None
    prepared: dict | None = None
    admission: Any = None
    authorization_id: str | None = None
    authorization_used: bool = False
    worker_id: str | None = None
    reservation: Any = None
    output_chunks: dict = field(default_factory=dict)
    resources: dict = field(default_factory=lambda: {"authoringProcesses": 0, "buildProcesses": 0, "workers": 0, "snapshots": 0})
    cleanup: dict = field(default_factory=lambda: {"status": "notStarted", "remainingResources": []})
    model_revision_id: str | None = None
    outcome_summary: dict | None = None
    closing_reason: str | None = None
    closed_event_sent: bool = False


class OrchestrationController:
    """One controller per connection. Blocking backend work runs on owned threads."""
    def __init__(self, backend: Any, *, connection_id: str, principal_uid: int,
                 connection_mode: str, emit: Callable[[dict], None], max_completed=128):
        self.backend, self.connection_id, self.principal_uid = backend, connection_id, principal_uid
        self.connection_mode, self._emit_callback = connection_mode, emit
        self.instance_id = getattr(backend, "instance_id", secrets.token_hex(16))
        self.max_completed = max_completed
        self._sessions: dict[str, SessionState] = {}
        self._lock = threading.RLock()
        self._event_lock = threading.Lock()
        self._seq = 0
        self._last_request_id = 0
        self._hello = False
        self._closed = False
        self._threads: set[threading.Thread] = set()
        self._pending_starts: list[threading.Thread] = []
        self._pending_events: list[dict] = []
        self._dispatch_thread: int | None = None

    @staticmethod
    def _success(request_id, result):
        return {"v": 1, "kind": "response", "id": request_id, "ok": True, "result": result}

    @staticmethod
    def _failure(request_id, error):
        return {"v": 1, "kind": "response", "id": request_id, "ok": False, "error": error}

    def _error(self, request_id, code, stage, message, operation_id=None):
        message = str(message).encode("utf-8", "replace")[:1024].decode("utf-8", "ignore")
        error = {"code": code, "stage": stage, "message": message}
        if operation_id is not None: error["operationId"] = operation_id
        return self._failure(request_id, error)

    def _event(self, session_id: str, name: str, data: dict) -> None:
        with self._event_lock:
            with self._lock:
                if self._closed and name != "session.closed": return
                self._seq += 1
                event = {"v": 1, "kind": "event", "seq": self._seq, "sessionId": session_id, "event": name, "data": data}
                if self._dispatch_thread is not None:
                    self._pending_events.append(event)
                    return
            self._emit_callback(event)

    def _owner(self, session_id):
        try:
            from .preparation import BackendOwner
            return BackendOwner(self.connection_id, self.principal_uid, session_id)
        except ImportError:
            return {"connection_id": self.connection_id, "principal_uid": self.principal_uid, "session_id": session_id}

    def _session(self, handle: Any) -> SessionState:
        with self._lock:
            state = self._sessions.get(handle)
        if state is None: raise ControlProtocolError("HANDLE_INVALID", "policy", "invalid handle")
        return state

    def dispatch(self, request: dict) -> dict:
        request_id, op, args = request["id"], request["op"], request["args"]
        with self._lock:
            if self._closed: return self._error(request_id, "CANCELLED", "cleanup", "connection is closing")
            if request_id <= self._last_request_id: raise ControlProtocolError("ARGUMENT_INVALID", "bootstrap", "request IDs must strictly increase", fatal=True)
            self._last_request_id = request_id
            if not self._hello and not (request_id == 1 and op == "hello"):
                raise ControlProtocolError("VERSION_UNSUPPORTED", "bootstrap", "first request must be hello with ID 1", fatal=True)
            if self._hello and op == "hello": raise ControlProtocolError("VERSION_UNSUPPORTED", "bootstrap", "hello may occur only once", fatal=True)
        self._dispatch_thread = threading.get_ident()
        try:
            if op == "hello": return self._hello_request(request_id, args)
            method = getattr(self, "_op_" + op.replace(".", "_"))
            return self._success(request_id, method(args))
        except ControlProtocolError as exc:
            if exc.fatal: raise
            return self._error(request_id, exc.code, exc.stage, exc.message)
        except Exception as exc:
            code = getattr(exc, "code", "POLICY_DENIED")
            stage = getattr(exc, "stage", "policy")
            return self._error(request_id, code, stage, str(exc))

    def reject_arguments(self, envelope: dict, error: ControlProtocolError) -> dict:
        """Consume the ID of a correlatable envelope rejected before dispatch."""
        request_id, op = envelope.get("id"), envelope.get("op")
        with self._lock:
            if type(request_id) is not int or request_id <= self._last_request_id:
                raise ControlProtocolError("ARGUMENT_INVALID", "bootstrap", "request IDs must strictly increase", fatal=True)
            if not self._hello and not (request_id == 1 and op == "hello"):
                raise ControlProtocolError("VERSION_UNSUPPORTED", "bootstrap", "first request must be hello with ID 1", fatal=True)
            self._last_request_id = request_id
        return self._error(request_id, error.code, error.stage, error.message)

    def _hello_request(self, request_id, args):
        if 1 not in args["controlVersions"]: raise ControlProtocolError("VERSION_UNSUPPORTED", "bootstrap", "control v1 is required")
        capabilities = list(self.backend.capability_reports(self.connection_mode))
        by_id = {item["id"]: item for item in capabilities}
        missing = [name for name in args["requiredCapabilities"] if not by_id.get(name, {}).get("available", False)]
        if missing: raise ControlProtocolError("CAPABILITY_UNAVAILABLE", "bootstrap", "required capability unavailable: " + missing[0])
        limits = {"maxFrameBytes": 1_048_576, "maxJsonDepth": 128, "maxJsonNodes": 16_384,
                  "maxPendingOutputBytes": 4_194_304, "maxSessionsPerConnection": 4,
                  "maxInflightRequestsPerConnection": 16, "maxCompletedOperationsPerSession": self.max_completed,
                  "helloTimeoutMs": 5000, "requestAckTimeoutMs": 5000, "workerAttachmentTimeoutMs": 5000,
                  "sessionWallMs": 600_000, "gracefulStopMs": 1000, "teardownMs": 5000}
        with self._lock: self._hello = True
        return self._success(request_id, {"controlVersion": 1, "instanceId": self.instance_id, "capabilities": capabilities, "limits": limits})

    def _op_session_open(self, args):
        with self._lock:
            active = sum(state.phase not in ("closed","cleanupFailed") for state in self._sessions.values())
            if active >= 4: raise ControlProtocolError("LIMIT_EXCEEDED", "policy", "session limit exceeded")
        manifest_bytes = args["manifestJson"].encode("utf-8")
        try: manifest = validate_manifest(_parse_json(manifest_bytes))
        except Exception as exc: raise ControlProtocolError("ARGUMENT_INVALID", "policy", "invalid public manifest") from exc
        session_id = secrets.token_hex(16); owner = self._owner(session_id)
        holder = {}
        expired = threading.Event()
        def deadline(_backend_state=None):
            expired.set()
            state = holder.get("state")
            if state is not None: self._internal_cleanup(state, "deadline")
        backend_state = self.backend.open_session(owner=owner, policy_id=args["policyId"], submission=args["submission"], runtime=args["runtime"], manifest_bytes=manifest_bytes, tightened_limits=args.get("limits"), on_deadline=deadline)
        digest = hashlib.sha256(b"mirrorgate.public-manifest/v1\0" + manifest_bytes).hexdigest()
        phase = "authoring" if args["submission"].get("kind") == "source" and args["submission"].get("authoring") else "open"
        state = SessionState(session_id, owner, backend_state, args["policyId"], args["submission"], args["runtime"], args["manifestJson"], manifest, digest, phase, model_revision_id=args.get("modelRevisionId"))
        with self._lock:
            if self._closed:
                threading.Thread(target=self.backend.cleanup_session, args=(backend_state,), kwargs={"reason":"client-failure", "cancel_event":threading.Event()}, daemon=True).start()
                raise ControlProtocolError("CANCELLED", "cleanup", "connection closed during session allocation")
            self._sessions[session_id] = state
            holder["state"] = state
        if expired.is_set():
            self._internal_cleanup(state, "deadline")
        return {"sessionId": session_id}

    def _new_operation(self, state, *, ordinary=False) -> OperationRecord:
        with state.lock:
            if state.phase in ("closing", "closed", "cleanupFailed"): raise ControlProtocolError("STATE_INVALID", "cleanup", "session is closing or closed")
            if ordinary and state.active_ordinary is not None: raise ControlProtocolError("STATE_INVALID", "authoring", "ordinary operation already active")
            op = OperationRecord(state.next_operation_id); state.next_operation_id += 1
            state.operations[op.operation_id] = op
            if ordinary: state.active_ordinary = op.operation_id
            return op

    def _spawn(self, state, operation, target, *, cleanup_on_failure=True):
        def run():
            try:
                result = target(operation.cancel)
                with state.lock:
                    operation.status, operation.result = "succeeded", result
                    if state.active_ordinary == operation.operation_id: state.active_ordinary = None
                self._finish_event(state, operation)
                if state.cleanup_operation == operation.operation_id and state.phase in ("closed","cleanupFailed"):
                    self._session_closed_event(state)
            except Exception as exc:
                error = self._exception_error(exc, operation.operation_id)
                with state.lock:
                    operation.status, operation.error = "failed", error
                    if state.active_ordinary == operation.operation_id: state.active_ordinary = None
                self._finish_event(state, operation)
                if state.cleanup_operation == operation.operation_id and state.phase in ("closed","cleanupFailed"):
                    self._session_closed_event(state)
                if cleanup_on_failure: self._failure_cleanup(state, operation, error)
            finally:
                self._evict(state)
                with self._lock: self._threads.discard(threading.current_thread())
        thread = threading.Thread(target=run, daemon=True, name=f"mirrorgate-control-{operation.operation_id}")
        with self._lock:
            self._threads.add(thread)
            deferred = self._dispatch_thread == threading.get_ident()
            if deferred: self._pending_starts.append(thread)
        if not deferred: thread.start()

    def after_response(self):
        """Start work only after the caller has queued the accepted response."""
        # Assigning event sequence numbers and enqueueing them form one order,
        # including events deferred behind a response from any producer thread.
        with self._event_lock:
            with self._lock:
                threads, self._pending_starts = self._pending_starts, []
                events, self._pending_events = self._pending_events, []
                self._dispatch_thread = None
            for event in events: self._emit_callback(event)
        for thread in threads: thread.start()

    def _exception_error(self, exc, operation_id):
        code, stage = getattr(exc, "code", "PREPARATION_FAILED"), getattr(exc, "stage", "prepare")
        if code not in ("POLICY_DENIED", "LIMIT_EXCEEDED", "PREPARATION_FAILED", "BUILD_FAILED", "BACKEND_ADMISSION_FAILED", "ATTACHMENT_FAILED", "WORKER_PROTOCOL_FAILED", "WORKER_EXITED", "CANCELLED", "DEADLINE_EXCEEDED", "CLEANUP_FAILED"): code = "PREPARATION_FAILED"
        return {"code": code, "stage": stage, "message": str(exc).encode("utf-8", "replace")[:1024].decode("utf-8", "ignore"), "operationId": operation_id}

    def _finish_event(self, state, operation):
        with state.lock:
            if not operation.advertised or operation.notified: return
            operation.notified=True;data=operation.public()
        self._event(state.session_id, "operation.finished", data)

    def _session_closed_event(self,state):
        with state.lock:
            if state.closed_event_sent:return
            state.closed_event_sent=True
            data={"phase":state.phase,"cleanupStatus":state.cleanup["status"],"remainingResources":list(state.cleanup["remainingResources"])}
        self._event(state.session_id,"session.closed",data)

    def _evict(self, state):
        with state.lock:
            complete = [key for key, item in state.operations.items() if item.status != "pending"]
            while len(complete) > self.max_completed:
                state.operations.pop(complete.pop(0), None)

    def _output(self, state, operation, stage, stream, data):
        for offset in range(0, len(data), 16_384):
            chunk = data[offset:offset+16_384]
            with state.lock:
                key=(operation.operation_id,stream)
                number=state.output_chunks.get(key,0)+1;state.output_chunks[key]=number
            self._event(state.session_id, stage + ".output", {"operationId": operation.operation_id, "stream": stream, "chunk": number, "bytesBase64": canonical_base64(chunk)})

    def _op_authoring_exec(self, args):
        state = self._session(args["sessionId"])
        with state.lock:
            if state.phase != "authoring": raise ControlProtocolError("STATE_INVALID", "authoring", "authoring is unavailable in this phase")
        op = self._new_operation(state, ordinary=True); state.resources["authoringProcesses"] += 1
        def work(cancel):
            counts = {"stdout": 0, "stderr": 0}
            def output(stream, data):
                counts[stream] += len(data)
                self._output(state, op, "authoring", stream, data)
            try:
                outcome = self.backend.authoring_exec(state.backend_state, tool_id=args["toolId"], arguments=args["arguments"], cwd=args["cwd"], cancel_event=cancel, emit_output=output)
                return {"exitCode": outcome.returncode, "stdoutBytes": counts["stdout"], "stderrBytes": counts["stderr"]}
            finally:
                with state.lock: state.resources["authoringProcesses"] = max(0, state.resources["authoringProcesses"] - 1)
        self._spawn(state, op, work); return {"operationId": op.operation_id}

    def _op_session_prepare(self, args):
        state = self._session(args["sessionId"])
        with state.lock:
            if state.phase not in ("open", "authoring") or state.active_ordinary is not None: raise ControlProtocolError("STATE_INVALID", "prepare", "session cannot prepare in this phase")
            state.phase = "preparing"
        op = self._new_operation(state, ordinary=True)
        def work(cancel):
            prepared = self.backend.prepare(state.backend_state, cancel_event=cancel, emit_output=lambda stream,data:self._output(state, op, "build", stream, data))
            challenge = secrets.token_hex(16)
            result = {"preparedRevision": 1, "artifactId": prepared.artifact_id, "artifactHash": prepared.artifact_hash, "manifestHash": state.manifest_hash, "runtime": prepared.runtime_id, "policyId": prepared.policy_id, "challenge": challenge}
            if prepared.source_hash is not None: result["sourceHash"] = prepared.source_hash
            with state.lock:
                if state.phase != "preparing": raise ControlProtocolError("CANCELLED", "prepare", "preparation cancelled")
                state.phase, state.prepared = "prepared", result
                state.resources["snapshots"] = 2 if prepared.source_hash is not None else 1
            return result
        self._spawn(state, op, work); return {"operationId": op.operation_id}

    def _op_session_authorize(self, args):
        state = self._session(args["sessionId"])
        with state.lock:
            prepared = state.prepared
            if state.phase != "prepared" or prepared is None: raise ControlProtocolError("STATE_INVALID", "authorize", "session is not prepared")
            if args["preparedRevision"] != 1 or args["challenge"] != prepared["challenge"] or args["attestation"]["semanticDigest"] != state.manifest["interfaceDigest"]: raise ControlProtocolError("NEGOTIATION_ATTESTATION_INVALID", "authorize", "attestation does not match prepared session")
        try: admission = self.backend.authorize_admission(state.backend_state, prepared_revision=1, challenge=args["challenge"], attestation=args["attestation"])
        except Exception as exc:
            self._internal_cleanup(state, "client-failure")
            raise ControlProtocolError(getattr(exc,"code","BACKEND_ADMISSION_FAILED"), "authorize", str(exc))
        with state.lock:
            if state.phase != "prepared": raise ControlProtocolError("CANCELLED", "authorize", "session changed during authorization")
            state.phase, state.admission, state.authorization_id = "authorized", admission, secrets.token_hex(16)
            return {"authorizationId": state.authorization_id}

    def _launch_guard(self, state, owner, worker_id, admission):
        with state.lock:
            if state.phase != "reserved" or state.owner != owner or state.worker_id != worker_id or state.admission is not admission: return False
            state.phase = "starting"; return True

    def _worker_event(self, state, name, data):
        data = dict(data)
        data["workerId"] = state.worker_id
        if "returncode" in data: data["exitCode"] = data.pop("returncode")
        if name == "worker.exited":
            raw=data.get("reason")
            with state.lock: recorded=state.closing_reason
            data["reason"]=(recorded or ("deadline" if raw == "wall_timeout" else
                            "client-failure" if raw == "client-disconnected" else "worker-failure"))
        allowed = {"worker.started":{"workerId"}, "worker.ready":{"workerId"}, "worker.exited":{"workerId","reason","exitCode"}, "worker.closing":{"workerId","reason"}}
        if name not in allowed: return
        data = {key:value for key,value in data.items() if key in allowed[name]}
        exited = False
        with state.lock:
            if name == "worker.ready" and state.phase == "starting": state.phase = "running"
            elif name == "worker.exited" and state.phase not in ("closing","closed","cleanupFailed"): exited = True
        self._event(state.session_id, name, data)
        if exited: self._internal_cleanup(state, "worker-failure")

    def _op_worker_acquire(self, args):
        state = self._session(args["sessionId"])
        with state.lock:
            if state.phase != "authorized" or args["authorizationId"] != state.authorization_id or state.authorization_used: raise ControlProtocolError("HANDLE_INVALID", "attach", "invalid authorization handle")
            state.authorization_used = True; state.worker_id = secrets.token_hex(16); state.phase = "reserved"; worker_id = state.worker_id
        try:
            reservation = self.backend.reserve_worker(state.backend_state, authorization=state.admission, worker_id=worker_id, owner=state.owner, launch_guard=lambda o,w,a:self._launch_guard(state,o,w,a), on_worker_event=lambda n,d:self._worker_event(state,n,d))
        except Exception as exc:
            self._internal_cleanup(state, "worker-failure")
            raise ControlProtocolError(getattr(exc,"code","BACKEND_ADMISSION_FAILED"), "attach", str(exc))
        with state.lock:
            if state.phase != "reserved": raise ControlProtocolError("CANCELLED", "attach", "session changed during reservation")
            state.reservation = reservation; state.resources["workers"] = 1
        return {"workerId": worker_id, "endpoint": {"kind":"unix", "path":str(reservation.endpoint_path)}, "attachmentToken": reservation.attachment_token, "attachmentTimeoutMs": reservation.attachment_timeout_ms, "releaseMode":"control-v1"}

    def _cleanup_operation(self, state, reason, *, worker_id=None, advertise=True):
        finished_to_advertise=None
        with state.lock:
            if state.cleanup_operation is not None:
                op=state.operations[state.cleanup_operation]
                if advertise and not op.advertised:
                    op.advertised=True
                    if op.status != "pending":finished_to_advertise=op
                existing=True
            else:existing=False
            if existing:
                pass
            else:
                op = OperationRecord(state.next_operation_id,advertised=advertise); state.next_operation_id += 1; state.operations[op.operation_id] = op
                state.cleanup_operation = op.operation_id; state.phase = "closing"; state.cleanup = {"status":"pending", "remainingResources":[]}
                state.closing_reason=reason
                for item in state.operations.values():
                    if item is not op and item.status == "pending": item.cancel.set()
        if existing:
            if finished_to_advertise is not None:self._finish_event(state,finished_to_advertise)
            return op
        def work(cancel):
            remaining, failures = [], []
            try:
                if worker_id is not None:
                    first = self.backend.finish_worker_release(state.backend_state, worker_id=worker_id, reason=reason, cancel_event=cancel)
                    remaining.extend(first.remaining_resources); failures.extend(first.failures)
                result = self.backend.cleanup_session(state.backend_state, reason=reason, cancel_event=cancel)
                remaining.extend(result.remaining_resources); failures.extend(result.failures)
            except Exception as exc:
                with state.lock:
                    state.phase="cleanupFailed"; state.cleanup={"status":"failed","remainingResources":remaining}
                raise ControlProtocolError("CLEANUP_FAILED","cleanup",str(exc)) from exc
            complete = result.complete and not failures and not remaining
            with state.lock:
                state.phase = "closed" if complete else "cleanupFailed"
                state.cleanup = {"status":"succeeded" if complete else "failed", "remainingResources":list(dict.fromkeys(remaining))}
                retained=set(remaining)
                state.resources={"authoringProcesses":state.resources["authoringProcesses"] if "authoring" in retained else 0,
                                 "buildProcesses":state.resources["buildProcesses"] if "build" in retained else 0,
                                 "workers":state.resources["workers"] if "worker" in retained else 0,
                                 "snapshots":state.resources["snapshots"] if "snapshot" in retained else 0}
            if not complete: raise ControlProtocolError("CLEANUP_FAILED", "cleanup", "; ".join(map(str, failures)) or "cleanup did not complete")
            return {"phase":"closed", "cleanupStatus":"succeeded", "remainingResources":[]}
        self._spawn(state, op, work, cleanup_on_failure=False); return op

    def _internal_cleanup(self, state, reason):
        self._cleanup_operation(state,reason,advertise=False)

    def _failure_cleanup(self, state, operation, error): self._internal_cleanup(state, "client-failure")

    def _op_worker_release(self, args):
        state = self._session(args["sessionId"])
        with state.lock:
            if state.worker_id != args["workerId"]: raise ControlProtocolError("HANDLE_INVALID", "cleanup", "invalid worker handle")
            if state.cleanup_operation is not None:
                op = self._cleanup_operation(state, args["reason"])
                mode = getattr(state, "cleanup_mode", "terminate-only")
                return {"operationId":op.operation_id, "cleanupMode":mode}
            state.phase = "closing"
        mode = self.backend.arm_worker_release(state.backend_state, worker_id=args["workerId"], reason=args["reason"])
        state.cleanup_mode = mode
        op = self._cleanup_operation(state, args["reason"], worker_id=args["workerId"])
        return {"operationId":op.operation_id, "cleanupMode":mode}

    def _op_session_cancel(self, args):
        state = self._session(args["sessionId"]); op = self._cleanup_operation(state, args["reason"]); return {"operationId":op.operation_id}

    def _op_session_close(self, args):
        state = self._session(args["sessionId"])
        with state.lock:
            if "outcomeSummary" in args: state.outcome_summary = dict(args["outcomeSummary"])
        op = self._cleanup_operation(state, "normal"); return {"operationId":op.operation_id}

    def _op_session_status(self, args):
        state = self._session(args["sessionId"])
        count_resources = getattr(self.backend, "resource_counts", None)
        resources = count_resources(state.backend_state) if callable(count_resources) else dict(state.resources)
        with state.lock:
            return {"phase": state.phase, "resources": resources,
                    "cleanup": {"status": state.cleanup["status"],
                                "remainingResources": list(state.cleanup["remainingResources"])}}

    def _op_operation_status(self, args):
        state = self._session(args["sessionId"])
        with state.lock: record = state.operations.get(args["operationId"])
        if record is None: raise ControlProtocolError("OPERATION_UNKNOWN", "cleanup", "operation is unknown or evicted")
        return record.public()

    def close(self, *, join_timeout=5.0):
        with self._lock:
            if self._closed: return
            self._closed = True; states = list(self._sessions.values())
        for state in states: self._internal_cleanup(state, "client-failure")
        self.after_response()
        with self._lock: threads = list(self._threads)
        deadline = time.monotonic() + join_timeout
        for thread in threads: thread.join(max(0, deadline - time.monotonic()))
