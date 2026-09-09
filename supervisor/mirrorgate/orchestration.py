"""Connection-owned control v1/v2 lifecycle, including audited managed hosting."""
from __future__ import annotations

from collections import OrderedDict
import copy
from dataclasses import dataclass, field
import hashlib
import secrets
import threading
import time
from typing import Any, Callable

from .control_protocol import ControlProtocolError, canonical_base64, codec_for_version
from . import control_protocol_v2 as hosting_protocol
from .agent_runtime import AgentHost, HostResult
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
class HostedRun:
    run_id: str
    admission: Any
    phase: str = "starting"
    outcome: str | None = None
    submission: dict | None = None
    error: dict | None = None
    cleanup: dict = field(default_factory=lambda: {"status": "notStarted", "remainingResources": []})
    progress: dict = field(default_factory=lambda: {"firstSeq": 1, "nextSeq": 1, "truncated": False, "records": []})
    cancel: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    tool_cancel: threading.Event = field(default_factory=threading.Event)
    cancel_reason: str | None = None
    finished_notified: bool = False
    host: Any = None

    def public(self):
        record = {"runId": self.run_id, "phase": self.phase,
                  "cleanup": self.cleanup, "progress": self.progress,
                  "limits": self.admission.limits}
        if self.outcome is not None: record["outcome"] = self.outcome
        if self.submission is not None: record["submission"] = self.submission
        if self.error is not None: record["error"] = self.error
        return copy.deepcopy(record)


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
    hosted_run: HostedRun | None = None


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
        self.control_version = 1
        self._closed = False
        self._threads: set[threading.Thread] = set()
        self._pending_starts: list[threading.Thread] = []
        self._pending_events: list[dict] = []
        self._dispatch_thread: int | None = None

    def _success(self, request_id, result):
        return {"v": self.control_version, "kind": "response", "id": request_id, "ok": True, "result": result}

    def _failure(self, request_id, error):
        return {"v": self.control_version, "kind": "response", "id": request_id, "ok": False, "error": error}

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
                event = {"v": self.control_version, "kind": "event", "seq": self._seq, "sessionId": session_id, "event": name, "data": data}
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
        self.validate_request(request)
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
            message = exc.message if not op.startswith("agent.") else self._hosting_error_message(exc.code)
            return self._error(request_id, exc.code, exc.stage, message)
        except Exception as exc:
            if op.startswith("agent."):
                return self._error(request_id, "POLICY_DENIED", "hosting", "hosting admission failed")
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

    def validate_request(self, request):
        return codec_for_version(self.control_version).validate_request(request)

    def _hello_request(self, request_id, args):
        version = hosting_protocol.select_control_version({"v": 1, "kind": "request", "id": request_id, "op": "hello", "args": args})
        capabilities = list(self.backend.capability_reports(self.connection_mode))
        if version == 2:
            reports = getattr(self.backend, "hosting_capability_reports", None)
            if callable(reports): capabilities.extend(reports())
        if version == 1:
            capabilities = [cap for cap in capabilities if not cap["id"].startswith("hosting.")]
        by_id = {item["id"]: item for item in capabilities}
        missing = [name for name in args["requiredCapabilities"] if not by_id.get(name, {}).get("available", False)]
        if missing: raise ControlProtocolError("CAPABILITY_UNAVAILABLE", "bootstrap", "required capability unavailable: " + missing[0])
        limits = {"maxFrameBytes": 1_048_576, "maxJsonDepth": 128, "maxJsonNodes": 16_384,
                  "maxPendingOutputBytes": 4_194_304, "maxSessionsPerConnection": 4,
                  "maxInflightRequestsPerConnection": 16, "maxCompletedOperationsPerSession": self.max_completed,
                  "helloTimeoutMs": 5000, "requestAckTimeoutMs": 5000, "workerAttachmentTimeoutMs": 5000,
                  "sessionWallMs": 600_000, "gracefulStopMs": 1000, "teardownMs": 5000}
        if version == 2:
            # agent.cancel joins a five-second cleanup attempt; allow transport
            # scheduling overhead without changing the frozen v1 timeout.
            limits["requestAckTimeoutMs"] = 10_000
        with self._lock:
            self._hello = True
            self.control_version = version
        return {"v": 1, "kind": "response", "id": request_id, "ok": True,
                "result": {"controlVersion": version, "instanceId": self.instance_id, "capabilities": capabilities, "limits": limits}}

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
        if hasattr(backend_state, "lock"):
            state.lock = backend_state.lock
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
            else: thread.start()

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
            with self._lock:
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

    @staticmethod
    def _hosting_error_message(code):
        return {"STATE_INVALID": "hosting is unavailable in this session state",
                "HANDLE_INVALID": "invalid hosted run handle", "POLICY_DENIED": "hosting profile is not permitted",
                "AUDIT_UNAVAILABLE": "approved runtime audit is unavailable",
                "CAPABILITY_UNAVAILABLE": "required hosting capability is unavailable",
                "LIMIT_EXCEEDED": "hosting limit exceeded", "CANCELLED": "hosting cancelled",
                "DEADLINE_EXCEEDED": "hosting deadline exceeded"}.get(code, "managed hosting failed")

    def _host_progress_locked(self, run, message):
        """Only fixed controller status text enters public progress."""
        from .control_protocol import encode_control_frame
        progress, limits = run.progress, run.admission.limits
        record = {"seq": progress["nextSeq"], "message": message}
        size = lambda item: len(encode_control_frame(item)) - 1
        # Operator-tightened budgets can be too small for any progress. Advance
        # the cursor and report truncation rather than breach the admitted cap.
        progress["nextSeq"] += 1
        progress["records"].append(record)
        while (len(progress["records"]) > limits["progressRecords"]
               or any(size(item) > limits["progressRecordBytes"] for item in progress["records"])
               or sum(size(item) for item in progress["records"]) > limits["progressBytes"]):
            progress["records"].pop(0)
        progress["firstSeq"] = progress["nextSeq"] - len(progress["records"])
        progress["truncated"] = progress["firstSeq"] > 1

    def _host_event(self, state):
        with state.lock:
            run = state.hosted_run
            if run is None: return
            terminal = run.phase == "finished"
            if terminal:
                if run.finished_notified: return
                run.finished_notified = True
            record = run.public()
            # Keep snapshot and enqueue ordered with all state transitions. An
            # update copied before commit must not follow a finished event (or
            # a newer status reply) after this producer is descheduled.
            self._event(state.session_id, "agent.finished" if terminal else "agent.updated", {"run": record})

    def _adopt_submission_locked(self, state):
        run = state.hosted_run
        submission = getattr(state.backend_state, "submission", None)
        if run is not None and run.phase != "finished" and submission is not None:
            run.submission = dict(submission)
            run.outcome, run.error = "submitted", None
            run.phase, run.cleanup = "cleaning", {"status": "pending", "remainingResources": []}
            if state.phase not in ("closing", "closed", "cleanupFailed"):
                state.phase = "submitted"
            state.resources["snapshots"] = max(1, state.resources["snapshots"])

    def _cancel_host_locked(self, state, reason):
        run = state.hosted_run
        if run is None or run.phase == "finished": return
        self._adopt_submission_locked(state)
        if run.cancel_reason is None: run.cancel_reason = reason
        run.cancel.set()
        run.tool_cancel.set()

    def _terminal_host(self, state, result):
        with state.lock:
            run = state.hosted_run
            if run.phase == "finished": return
            self._adopt_submission_locked(state)
            if run.outcome is None:
                reason = result.reason
                if run.cancel_reason == "deadline" or reason == "wall_timeout":
                    outcome, code = "timedOut", "DEADLINE_EXCEEDED"
                elif run.cancel_reason is not None or reason == "cancelled":
                    outcome, code = "cancelled", "CANCELLED"
                elif reason in ("stdout_limit", "stderr_limit"):
                    outcome, code = "failed", "LIMIT_EXCEEDED"
                else:
                    outcome, code = "failed", "AGENT_START_FAILED" if reason == "start_failed" else "AGENT_EXITED"
                run.outcome = outcome
                run.error = {"code": code, "stage": "hosting", "message": self._hosting_error_message(code)}
            run.phase = "finished"
            complete = result.cleanup_complete and not result.remaining_resources
            run.cleanup = {"status": "succeeded" if complete else "failed",
                           "remainingResources": list(result.remaining_resources)}
            state.backend_state.host_cleanup_complete = complete
            self._host_progress_locked(run, "Hosting cleanup completed" if complete else "Hosting cleanup unconfirmed")
        self._host_event(state)

    def _join_host(self, state, timeout):
        run = state.hosted_run
        if run is None: return
        if not run.done.wait(timeout):
            # Terminal metadata is sticky even if a broken runtime later returns.
            # Never let a late submit install source after unconfirmed teardown.
            with state.lock:
                self._cancel_host_locked(state, "client-failure")
            self._terminal_host(state, HostResult(None, "cancelled", False, ("agent-host",)))

    def _host_execute(self, state, run, tool_id, arguments):
        with state.lock:
            if (state.hosted_run is not run or run.phase not in ("starting", "running")
                    or run.cancel.is_set() or state.phase != "authoring" or state.active_ordinary is not None):
                raise ControlProtocolError("STATE_INVALID", "hosting", "authoring tool unavailable")
            # The broker has a tool slot, never an ordinary public operation ID.
            state.active_ordinary = -1
            run.tool_cancel = threading.Event()
            state.resources["authoringProcesses"] += 1
        output = {"stdout": bytearray(), "stderr": bytearray()}
        overflow = threading.Event()
        def emit(stream, data):
            # JSON escaping can expand one byte to six; 64KiB per stream keeps
            # the broker response below 1MiB independently of backend limits.
            current = output[stream]
            if len(current) + len(data) > 65536:
                overflow.set()
                run.tool_cancel.set()
                return
            current.extend(data)
        try:
            outcome = self.backend.authoring_exec(state.backend_state, tool_id=tool_id,
                arguments=arguments, cwd=".", cancel_event=run.tool_cancel, emit_output=emit)
            if overflow.is_set():
                raise ControlProtocolError("LIMIT_EXCEEDED", "hosting", "public tool output limit exceeded")
            return {"returncode": outcome.returncode,
                    "stdout": output["stdout"].decode("utf-8", "replace"),
                    "stderr": output["stderr"].decode("utf-8", "replace")}
        finally:
            with state.lock:
                state.active_ordinary = None
                state.resources["authoringProcesses"] = max(0, state.resources["authoringProcesses"] - 1)

    def _host_submit(self, state, run):
        with state.lock:
            self._adopt_submission_locked(state)
            if run.submission is not None: return dict(run.submission)
            if (state.hosted_run is not run or run.phase not in ("starting", "running")
                    or run.cancel.is_set() or state.phase != "authoring"):
                raise ControlProtocolError("STATE_INVALID", "hosting", "submission unavailable")
            run.phase = "submitting"
            run.tool_cancel.set()
            self._host_progress_locked(run, "Sealing submission source")
        self._host_event(state)
        try:
            # Backend and controller share the lock; release it across freezing
            # so cancel/close can win before the backend's atomic lease install.
            submission = self.backend.submit_source(state.backend_state, cancel_event=run.cancel)
            with state.lock:
                self._adopt_submission_locked(state)
                if run.phase == "finished":
                    raise ControlProtocolError("CANCELLED", "hosting", "hosting already ended")
                run.cancel.set()  # stop the runtime after explicit source commitment
                self._host_progress_locked(run, "Submission source committed")
            self._host_event(state)
            return submission
        except Exception as exc:
            with state.lock:
                self._adopt_submission_locked(state)
                timed_out = getattr(exc, "code", None) == "DEADLINE_EXCEEDED"
                if run.outcome is None and timed_out:
                    run.outcome = "timedOut"
                    run.cancel_reason = "deadline"
                    run.error = {"code": "DEADLINE_EXCEEDED", "stage": "hosting", "message": "hosting deadline exceeded"}
                    run.phase, run.cleanup = "cleaning", {"status": "pending", "remainingResources": []}
                elif run.outcome is None and not run.cancel.is_set():
                    run.outcome = "failed"
                    run.error = {"code": "PREPARATION_FAILED", "stage": "hosting", "message": "submission could not be frozen"}
                    run.phase, run.cleanup = "cleaning", {"status": "pending", "remainingResources": []}
                run.cancel.set()
            if timed_out:
                raise ControlProtocolError("DEADLINE_EXCEEDED", "hosting", "hosting deadline exceeded") from exc
            raise ControlProtocolError("PREPARATION_FAILED", "hosting", "submission could not be frozen") from exc

    def _op_agent_start(self, args):
        state = self._session(args["sessionId"])
        with state.lock:
            if state.phase != "authoring" or state.hosted_run is not None or state.active_ordinary is not None:
                raise ControlProtocolError("STATE_INVALID", "hosting", "managed run cannot start")
        try:
            admission = self.backend.admit_agent(state.backend_state, args["profileId"], args["publicTask"], args.get("limits"))
        except Exception as exc:
            code = getattr(exc, "code", "AUDIT_UNAVAILABLE")
            if code not in {"POLICY_DENIED", "LIMIT_EXCEEDED", "AUDIT_UNAVAILABLE", "CAPABILITY_UNAVAILABLE", "STATE_INVALID", "ARGUMENT_INVALID", "DEADLINE_EXCEEDED"}:
                code = "AUDIT_UNAVAILABLE"
            raise ControlProtocolError(code, "hosting", self._hosting_error_message(code)) from exc
        with state.lock:
            if (state.phase != "authoring" or state.hosted_run is not None or state.active_ordinary is not None
                    or self._closed or time.monotonic() >= state.backend_state.deadline):
                raise ControlProtocolError("STATE_INVALID", "hosting", "managed run cannot start")
            run = HostedRun(secrets.token_hex(16), admission)
            state.hosted_run = run
            state.backend_state.host_cleanup_complete = False
            state.backend_state.host_deadline = min(state.backend_state.deadline,
                time.monotonic() + admission.limits["wallMs"] / 1000)
            self._host_progress_locked(run, "Managed authoring accepted")
        def execute():
            try:
                with state.lock:
                    cancelled = run.cancel.is_set()
                    if not cancelled:
                        run.phase = "running"
                        self._host_progress_locked(run, "Starting approved agent runtime")
                if cancelled:
                    result = HostResult(None, "cancelled", True, ())
                else:
                    self._host_event(state)
                    def stop_authoring(deadline):
                        run.tool_cancel.set()
                        self.backend._stop_authoring(state.backend_state, deadline=deadline)
                    run.host = AgentHost(admission,
                        execute=lambda tool, argv: self._host_execute(state, run, tool, argv),
                        submit=lambda: self._host_submit(state, run),
                        tool_ids=tuple(state.backend_state.policy.tools),
                        deadline=state.backend_state.host_deadline, cancel_event=run.cancel,
                        stop_authoring=stop_authoring)
                    result = run.host.run()
                self._terminal_host(state, result)
            except Exception:
                # Runtime adapters must normally return a cleanup receipt. An
                # unexpected exception cannot justify a successful cleanup claim.
                self._terminal_host(state, HostResult(None, "start_failed", False, ("agent-host",)))
            finally:
                run.done.set()
                with state.lock:
                    needs_cleanup = run.outcome != "submitted" or run.cleanup["status"] != "succeeded"
                if needs_cleanup: self._internal_cleanup(state, "client-failure")
                with self._lock: self._threads.discard(threading.current_thread())
        thread = threading.Thread(target=execute, daemon=True, name="mirrorgate-hosted-agent")
        with self._lock:
            self._threads.add(thread)
            self._pending_starts.append(thread)
        return {"runId": run.run_id}

    def _op_agent_status(self, args):
        state = self._session(args["sessionId"])
        with state.lock:
            run = state.hosted_run
            if "runId" in args and (run is None or args["runId"] != run.run_id):
                raise ControlProtocolError("HANDLE_INVALID", "hosting", "invalid run handle")
            return {"run": None if run is None else run.public()}

    def _op_agent_cancel(self, args):
        state = self._session(args["sessionId"])
        with state.lock:
            run = state.hosted_run
            if run is None or args["runId"] != run.run_id:
                raise ControlProtocolError("HANDLE_INVALID", "hosting", "invalid run handle")
            self._cancel_host_locked(state, args["reason"])
        self._join_host(state, 5.0)
        with state.lock:
            result = {"run": run.public()}
        if result["run"]["cleanup"]["status"] != "succeeded":
            self._internal_cleanup(state, "client-failure")
        return result

    def _op_authoring_exec(self, args):
        state = self._session(args["sessionId"])
        with state.lock:
            if state.phase != "authoring" or state.hosted_run is not None: raise ControlProtocolError("STATE_INVALID", "authoring", "authoring is unavailable in this phase")
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
            hosted = state.hosted_run
            if (state.phase not in ("open", "authoring", "submitted") or state.active_ordinary is not None
                    or hosted is not None and (hosted.outcome != "submitted" or hosted.phase != "finished" or hosted.cleanup["status"] != "succeeded")):
                raise ControlProtocolError("STATE_INVALID", "prepare", "session cannot prepare in this phase")
            state.phase = "preparing"
        op = self._new_operation(state, ordinary=True)
        def work(cancel):
            prepared = self.backend.prepare(state.backend_state, cancel_event=cancel, emit_output=lambda stream,data:self._output(state, op, "build", stream, data))
            challenge = secrets.token_hex(16)
            result = {"preparedRevision": 1, "artifactId": prepared.artifact_id, "artifactHash": prepared.artifact_hash, "manifestHash": state.manifest_hash, "runtime": prepared.runtime_id, "policyId": prepared.policy_id, "challenge": challenge}
            if prepared.source_hash is not None: result["sourceHash"] = prepared.source_hash
            with state.lock:
                if state.hosted_run is not None and result.get("sourceHash") != state.hosted_run.submission["sourceHash"]:
                    raise ControlProtocolError("PREPARATION_FAILED", "prepare", "prepared source does not match committed submission")
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
                self._cancel_host_locked(state, reason)
                for item in state.operations.values():
                    if item is not op and item.status == "pending": item.cancel.set()
        if existing:
            if finished_to_advertise is not None:self._finish_event(state,finished_to_advertise)
            return op
        def work(cancel):
            remaining, failures = [], []
            if state.hosted_run is not None:
                deadline = time.monotonic() + 5.0
                with state.lock:
                    old_deadline = getattr(state.backend_state, "cleanup_deadline", None)
                    deadline = min(deadline, old_deadline) if old_deadline is not None else deadline
                    state.backend_state.cleanup_deadline = deadline
                self._join_host(state, max(0, deadline - time.monotonic()))
                with state.lock:
                    if state.hosted_run.cleanup["status"] != "succeeded":
                        remaining.extend(state.hosted_run.cleanup["remainingResources"])
                        failures.append("managed host cleanup did not complete")
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
            if state.hosted_run is not None and state.hosted_run.cleanup["status"] != "succeeded":
                resources = dict(resources)
                resources["authoringProcesses"] += int(not state.hosted_run.done.is_set())
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
