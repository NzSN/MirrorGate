"""Strict JSONL codec and closed-record validation for control protocol v1."""
from __future__ import annotations

import base64
from decimal import Decimal, DecimalException
import json
import re
from typing import Any

from .protocol import ProtocolError, _parse_json, validate_manifest

MAX_FRAME_BYTES = 1_048_576
MAX_JSON_DEPTH = 128
MAX_JSON_NODES = 16_384
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_MANIFEST_BYTES = 262_144
MAX_ATTACHMENT_FRAME_BYTES = 4_096
MAX_OUTPUT_CHUNK_BYTES = 16_384

HANDLE = re.compile(r"[0-9a-f]{32}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")
PUBLIC_ID = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,127}\Z")
ERROR_CODES = frozenset(("VERSION_UNSUPPORTED", "CAPABILITY_UNAVAILABLE", "ARGUMENT_INVALID", "POLICY_DENIED", "HANDLE_INVALID", "STATE_INVALID", "LIMIT_EXCEEDED", "PREPARATION_FAILED", "BUILD_FAILED", "NEGOTIATION_ATTESTATION_INVALID", "BACKEND_ADMISSION_FAILED", "ATTACHMENT_FAILED", "WORKER_PROTOCOL_FAILED", "WORKER_EXITED", "CANCELLED", "DEADLINE_EXCEEDED", "CLEANUP_FAILED", "OPERATION_UNKNOWN"))
ERROR_STAGES = frozenset(("bootstrap", "policy", "authoring", "prepare", "build", "authorize", "attach", "worker", "cleanup"))
OPERATIONS = frozenset(("hello", "session.open", "authoring.exec", "session.prepare", "session.authorize", "worker.acquire", "worker.release", "session.cancel", "session.close", "session.status", "operation.status"))
PHASES = frozenset(("open", "authoring", "preparing", "prepared", "authorized", "reserved", "starting", "running", "closing", "closed", "cleanupFailed"))
REASONS = frozenset(("normal", "user-cancel", "deadline", "client-failure", "worker-failure"))
EVENTS = frozenset(("operation.finished", "authoring.output", "build.output", "worker.started", "worker.ready", "worker.exited", "worker.closing", "session.closed"))
LIMIT_KEYS = frozenset(("sessionWallMs", "executionWallMs", "commandCpuSeconds", "addressSpaceBytes", "uidProcesses", "openFiles", "fileBytes", "stdoutBytes", "stderrBytes", "snapshotFiles", "snapshotBytes", "tmpBytes", "scratchBytes"))
HELLO_LIMIT_KEYS = frozenset(("maxFrameBytes", "maxJsonDepth", "maxJsonNodes", "maxPendingOutputBytes", "maxSessionsPerConnection", "maxInflightRequestsPerConnection", "maxCompletedOperationsPerSession", "helloTimeoutMs", "requestAckTimeoutMs", "workerAttachmentTimeoutMs", "sessionWallMs", "gracefulStopMs", "teardownMs"))


class ControlProtocolError(ValueError):
    def __init__(self, code: str, stage: str, message: str, *, fatal: bool = False):
        super().__init__(message)
        self.code, self.stage, self.message, self.fatal = code, stage, message, fatal

    def record(self, operation_id: int | None = None) -> dict:
        result = {"code": self.code, "stage": self.stage, "message": self.message}
        if operation_id is not None:
            result["operationId"] = operation_id
        return result


def _fail(code: str, stage: str, message: str, *, fatal: bool = False):
    raise ControlProtocolError(code, stage, message, fatal=fatal)


def _pairs(items):
    value = {}
    for key, child in items:
        if key in value:
            _fail("ARGUMENT_INVALID", "bootstrap", "duplicate JSON object key", fatal=True)
        value[key] = child
    return value


def _number(token: str) -> int:
    try:
        value = Decimal(token)
        if not value.is_finite() or value != value.to_integral_value() or not -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
            raise ValueError
        return int(value)
    except (DecimalException, ValueError, OverflowError):
        _fail("ARGUMENT_INVALID", "bootstrap", "JSON numbers must be exact safe integers", fatal=True)


def _constant(_value):
    _fail("ARGUMENT_INVALID", "bootstrap", "nonfinite JSON number", fatal=True)


def _scalar_string(value: Any, label: str, max_bytes: int = 1024, nonempty: bool = True) -> str:
    if not isinstance(value, str) or (nonempty and not value):
        _fail("ARGUMENT_INVALID", "bootstrap", f"{label} must be a string")
    try:
        data = value.encode("utf-8")
    except UnicodeEncodeError:
        _fail("ARGUMENT_INVALID", "bootstrap", f"{label} contains an invalid Unicode scalar")
    if len(data) > max_bytes:
        _fail("LIMIT_EXCEEDED", "bootstrap", f"{label} exceeds its byte limit")
    return value


def _bounds(value: Any) -> None:
    stack, count = [(value, 0)], 0
    while stack:
        item, depth = stack.pop()
        count += 1
        if depth > MAX_JSON_DEPTH or count > MAX_JSON_NODES:
            _fail("LIMIT_EXCEEDED", "bootstrap", "JSON depth or node budget exceeded", fatal=True)
        if isinstance(item, dict):
            for key, child in item.items():
                _scalar_string(key, "object key", MAX_FRAME_BYTES, False)
                stack.append((child, depth + 1))
        elif isinstance(item, list):
            stack.extend((child, depth + 1) for child in item)
        elif isinstance(item, str):
            _scalar_string(item, "string", MAX_FRAME_BYTES, False)
        elif type(item) is int:
            if abs(item) > MAX_SAFE_INTEGER:
                _fail("ARGUMENT_INVALID", "bootstrap", "unsafe JSON integer", fatal=True)
        elif item is not None and type(item) is not bool:
            _fail("ARGUMENT_INVALID", "bootstrap", "unsupported JSON value", fatal=True)


def _object(value: Any, required=(), optional=(), label="record") -> dict:
    if not isinstance(value, dict):
        _fail("ARGUMENT_INVALID", "bootstrap", f"{label} must be an object")
    allowed = set(required) | set(optional)
    if not set(required) <= set(value) or not set(value) <= allowed:
        _fail("ARGUMENT_INVALID", "bootstrap", f"{label} fields do not match contract")
    return value


def _safe(value: Any, label: str, *, positive=True) -> int:
    lower = 1 if positive else 0
    if type(value) is not int or not lower <= value <= MAX_SAFE_INTEGER:
        _fail("ARGUMENT_INVALID", "bootstrap", f"{label} must be a {'positive ' if positive else ''}safe integer")
    return value


def _handle(value: Any, label: str) -> str:
    if not isinstance(value, str) or HANDLE.fullmatch(value) is None:
        _fail("ARGUMENT_INVALID", "bootstrap", f"{label} must be a 128-bit lowercase hex handle")
    return value


def _public_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or PUBLIC_ID.fullmatch(value) is None:
        _fail("ARGUMENT_INVALID", "bootstrap", f"{label} is not a public identifier")
    return value


def _enum(value: Any, allowed, label: str) -> str:
    if type(value) is not str or value not in allowed:
        _fail("ARGUMENT_INVALID", "bootstrap", f"invalid {label}")
    return value


def _digest(value: Any, label: str) -> str:
    if type(value) is not str or DIGEST.fullmatch(value) is None:
        _fail("ARGUMENT_INVALID", "bootstrap", f"invalid {label}")
    return value


def _remaining_resources(value: Any) -> None:
    if type(value) is not list or len(value) > 64:
        _fail("ARGUMENT_INVALID", "cleanup", "invalid remaining resources")
    seen = set()
    for item in value:
        _public_id(item, "remaining resource")
        if item in seen:
            _fail("ARGUMENT_INVALID", "cleanup", "duplicate remaining resource")
        seen.add(item)


def _cleanup_result(value: Any) -> None:
    _object(value, ("phase", "cleanupStatus", "remainingResources"), label="cleanup result")
    _enum(value["phase"], ("closed", "cleanupFailed"), "terminal session phase")
    _enum(value["cleanupStatus"], ("succeeded", "failed"), "terminal cleanup status")
    _remaining_resources(value["remainingResources"])
    if ((value["phase"] == "closed") != (value["cleanupStatus"] == "succeeded")
            or value["phase"] == "closed" and value["remainingResources"]):
        _fail("ARGUMENT_INVALID", "cleanup", "incoherent terminal cleanup result")


def parse_control_frame(data: bytes, *, max_bytes: int = MAX_FRAME_BYTES) -> dict:
    if not isinstance(data, bytes) or len(data) > max_bytes + 1:
        _fail("LIMIT_EXCEEDED", "bootstrap", "control frame byte budget exceeded", fatal=True)
    if data.startswith(b"\xef\xbb\xbf") or not data.endswith(b"\n") or b"\n" in data[:-1] or b"\r" in data or not data[:-1].strip():
        _fail("ARGUMENT_INVALID", "bootstrap", "invalid control JSONL framing", fatal=True)
    try:
        value = json.loads(data[:-1].decode("utf-8", "strict"), object_pairs_hook=_pairs,
                           parse_int=_number, parse_float=_number, parse_constant=_constant)
    except ControlProtocolError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError):
        _fail("ARGUMENT_INVALID", "bootstrap", "invalid UTF-8 JSON", fatal=True)
    try:
        _bounds(value)
    except ControlProtocolError as exc:
        raise ControlProtocolError(exc.code, exc.stage, exc.message, fatal=True) from exc
    if not isinstance(value, dict):
        _fail("ARGUMENT_INVALID", "bootstrap", "control frame root must be an object", fatal=True)
    return value


def encode_control_frame(message: dict, *, max_bytes: int = MAX_FRAME_BYTES) -> bytes:
    _bounds(message)
    try:
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (UnicodeError, TypeError, ValueError):
        _fail("ARGUMENT_INVALID", "bootstrap", "cannot encode control frame")
    if len(payload) > max_bytes:
        _fail("LIMIT_EXCEEDED", "bootstrap", "control frame byte budget exceeded")
    return payload + b"\n"


def _input_ref(value):
    value = _object(value, ("rootId", "relativePath"), label="input reference")
    _public_id(value["rootId"], "rootId")
    path = _scalar_string(value["relativePath"], "relativePath", 1024)
    if path.startswith("/") or "\x00" in path or path != "." and any(part in ("", ".", "..") for part in path.split("/")):
        _fail("ARGUMENT_INVALID", "policy", "relativePath is not canonical")


def _submission(value):
    if not isinstance(value, dict) or value.get("kind") not in ("prebuilt", "source"):
        _fail("ARGUMENT_INVALID", "policy", "invalid submission")
    if value["kind"] == "prebuilt":
        _object(value, ("kind", "input"), label="prebuilt submission")
    else:
        _object(value, ("kind", "input", "buildPlanId", "authoring"), label="source submission")
        _public_id(value["buildPlanId"], "buildPlanId")
        if type(value["authoring"]) is not bool:
            _fail("ARGUMENT_INVALID", "policy", "authoring must be boolean")
    _input_ref(value["input"])


def _limits(value, *, keys=LIMIT_KEYS, positive=True):
    value = _object(value, optional=keys, label="limits")
    for key, item in value.items():
        _safe(item, key, positive=positive)


def _outcome(value):
    value = _object(value, ("status",), ("failureFamily",), "outcome summary")
    if value["status"] not in ("passed", "mismatch", "failed", "cancelled", "timedOut"):
        _fail("ARGUMENT_INVALID", "cleanup", "invalid outcome status")
    if "failureFamily" in value:
        _public_id(value["failureFamily"], "failureFamily")


def _attestation(value):
    keys = ("registrationId", "request", "policy", "status", "descriptorSchema", "semanticDigest", "adapterId", "targetProfile", "stateComputerContractVersion")
    value = _object(value, keys, label="attestation")
    for key in ("registrationId", "descriptorSchema", "adapterId", "targetProfile", "stateComputerContractVersion"):
        _scalar_string(value[key], key, 128)
    if (value["request"], value["policy"], value["status"], value["descriptorSchema"]) != ("verify", "require", "matched", "mirrors.model-interface-descriptor/v1") or not isinstance(value["semanticDigest"], str) or DIGEST.fullmatch(value["semanticDigest"]) is None:
        _fail("ARGUMENT_INVALID", "authorize", "invalid required-match attestation")


def validate_request(message: Any) -> dict:
    _bounds(message)
    try:
        _object(message, ("v", "kind", "id", "op", "args"), label="request envelope")
        if type(message["v"]) is not int or message["v"] != 1 or message["kind"] != "request":
            raise ValueError
        _safe(message["id"], "request id")
        if not isinstance(message["op"], str) or message["op"] not in OPERATIONS:
            raise KeyError
    except (ControlProtocolError, ValueError, KeyError):
        _fail("ARGUMENT_INVALID", "bootstrap", "invalid request envelope or operation", fatal=True)
    op, args = message["op"], message["args"]
    if op == "hello":
        _object(args, ("controlVersions", "requiredCapabilities"), label="hello arguments")
        versions = args["controlVersions"]
        caps = args["requiredCapabilities"]
        if not isinstance(versions, list) or not 1 <= len(versions) <= 8 or any(type(v) is not int or v < 1 for v in versions) or len(set(versions)) != len(versions):
            _fail("ARGUMENT_INVALID", "bootstrap", "invalid controlVersions")
        if not isinstance(caps, list) or len(caps) > 64 or any(not isinstance(cap, str) for cap in caps):
            _fail("ARGUMENT_INVALID", "bootstrap", "invalid requiredCapabilities")
        for cap in caps: _public_id(cap, "capability")
        if len(caps) != len(set(caps)): _fail("ARGUMENT_INVALID", "bootstrap", "invalid requiredCapabilities")
    elif op == "session.open":
        _object(args, ("policyId", "submission", "runtime", "manifestJson"), ("limits", "modelRevisionId"), "session.open arguments")
        _public_id(args["policyId"], "policyId"); _public_id(args["runtime"], "runtime"); _submission(args["submission"])
        manifest = _scalar_string(args["manifestJson"], "manifestJson", MAX_MANIFEST_BYTES, False)
        try:
            validate_manifest(_parse_json(manifest.encode("utf-8")))
        except ProtocolError as exc:
            _fail("ARGUMENT_INVALID", "policy", "invalid public manifest")
        if "limits" in args: _limits(args["limits"])
        if "modelRevisionId" in args:
            revision = _scalar_string(args["modelRevisionId"], "modelRevisionId", 128)
            if not revision.isascii():
                _fail("ARGUMENT_INVALID", "policy", "modelRevisionId must be ASCII")
        without = dict(message); without["args"] = dict(args); without["args"].pop("manifestJson")
        if len(encode_control_frame(without)) - 1 > 65_535: _fail("LIMIT_EXCEEDED", "policy", "session.open metadata exceeds byte limit")
    else:
        required = {"authoring.exec": ("sessionId", "toolId", "arguments", "cwd"), "session.prepare": ("sessionId",), "session.authorize": ("sessionId", "preparedRevision", "challenge", "attestation"), "worker.acquire": ("sessionId", "authorizationId"), "worker.release": ("sessionId", "workerId", "reason"), "session.cancel": ("sessionId", "reason"), "session.close": ("sessionId",), "session.status": ("sessionId",), "operation.status": ("sessionId", "operationId")}[op]
        optional = ("outcomeSummary",) if op == "session.close" else ()
        _object(args, required, optional, f"{op} arguments")
        _handle(args["sessionId"], "sessionId")
        if op == "authoring.exec":
            _public_id(args["toolId"], "toolId")
            _input_ref({"rootId": "cwd", "relativePath": args["cwd"]})
            argv = args["arguments"]
            if not isinstance(argv, list) or len(argv) > 256: _fail("ARGUMENT_INVALID", "authoring", "invalid arguments")
            total = 0
            for item in argv: total += len(_scalar_string(item, "argument", 65_535, False).encode())
            if total > 65_535 or any("\x00" in item for item in argv): _fail("LIMIT_EXCEEDED", "authoring", "arguments exceed limits")
        elif op == "session.authorize":
            _safe(args["preparedRevision"], "preparedRevision"); _handle(args["challenge"], "challenge"); _attestation(args["attestation"])
        elif op == "worker.acquire": _handle(args["authorizationId"], "authorizationId")
        elif op == "worker.release": _handle(args["workerId"], "workerId")
        if op in ("worker.release", "session.cancel"):
            _enum(args["reason"], REASONS, "cleanup reason")
        if op == "session.close" and "outcomeSummary" in args: _outcome(args["outcomeSummary"])
        if op == "operation.status": _safe(args["operationId"], "operationId")
    return message


def validate_error(value: Any) -> dict:
    value = _object(value, ("code", "stage", "message"), ("operationId",), "control error")
    _enum(value["code"], ERROR_CODES, "control error code")
    _enum(value["stage"], ERROR_STAGES, "control error stage")
    _scalar_string(value["message"], "error message", 1024, False)
    if "operationId" in value: _safe(value["operationId"], "operationId")
    return value


def validate_response(message: Any, request: dict | None = None) -> dict:
    _bounds(message)
    if not isinstance(message, dict) or message.get("ok") is True:
        _object(message, ("v", "kind", "id", "ok", "result"), label="success response")
    else:
        _object(message, ("v", "kind", "id", "ok", "error"), label="failure response")
        validate_error(message["error"])
    if type(message["v"]) is not int or message["v"] != 1 or message["kind"] != "response" or type(message["ok"]) is not bool: _fail("ARGUMENT_INVALID", "bootstrap", "invalid response envelope")
    _safe(message["id"], "response id")
    if request is not None and message["id"] != request["id"]: _fail("ARGUMENT_INVALID", "bootstrap", "uncorrelated response", fatal=True)
    return message


def validate_terminal_result(operation: str, value: Any) -> Any:
    """Validate a long operation's value using its accepted request identity."""
    _bounds(value)
    if operation == "session.prepare":
        _object(value, ("preparedRevision", "artifactId", "artifactHash", "manifestHash",
                        "runtime", "policyId", "challenge"), ("sourceHash",), "prepared result")
        if type(value["preparedRevision"]) is not int or value["preparedRevision"] != 1:
            _fail("ARGUMENT_INVALID", "prepare", "invalid prepared revision")
        for key in ("artifactId", "challenge"):
            _handle(value[key], key)
        for key in ("artifactHash", "manifestHash", "sourceHash"):
            if key in value:
                _digest(value[key], key)
        _public_id(value["runtime"], "runtime")
        _public_id(value["policyId"], "policyId")
    elif operation == "authoring.exec":
        _object(value, ("exitCode", "stdoutBytes", "stderrBytes"), label="command result")
        if type(value["exitCode"]) is not int or abs(value["exitCode"]) > MAX_SAFE_INTEGER:
            _fail("ARGUMENT_INVALID", "authoring", "invalid command exit code")
        _safe(value["stdoutBytes"], "stdoutBytes", positive=False)
        _safe(value["stderrBytes"], "stderrBytes", positive=False)
    elif operation in ("worker.release", "session.cancel", "session.close"):
        _cleanup_result(value)
    else:
        _fail("ARGUMENT_INVALID", "bootstrap", "operation does not have a terminal result")
    return value


def validate_operation_status(value: Any, operation: str | None = None, *, terminal=False) -> dict:
    _bounds(value)
    if not isinstance(value, dict) or value.get("status") not in ("pending", "succeeded", "failed"):
        _fail("ARGUMENT_INVALID", "bootstrap", "invalid operation status")
    status = value["status"]
    _object(value, ("operationId", "status") + (("result",) if status == "succeeded" else (("error",) if status == "failed" else ())), label="operation status")
    _safe(value["operationId"], "operationId")
    if terminal and status == "pending":
        _fail("ARGUMENT_INVALID", "bootstrap", "operation.finished must be terminal")
    if status == "failed":
        validate_error(value["error"])
        if value["error"].get("operationId", value["operationId"]) != value["operationId"]:
            _fail("ARGUMENT_INVALID", "bootstrap", "operation error correlation mismatch")
    if status == "succeeded" and operation is not None:
        validate_terminal_result(operation, value["result"])
    return value


def validate_result(request: dict, response: dict, *, operation: str | None = None) -> Any:
    validate_response(response, request)
    if not response["ok"]: return response["error"]
    op, result = request["op"], response["result"]
    if op == "hello":
        _object(result, ("controlVersion", "instanceId", "capabilities", "limits"), label="hello result")
        if type(result["controlVersion"]) is not int or result["controlVersion"] != 1: _fail("VERSION_UNSUPPORTED", "bootstrap", "invalid selected version")
        _handle(result["instanceId"], "instanceId"); _limits(result["limits"], keys=HELLO_LIMIT_KEYS)
        if set(result["limits"]) != HELLO_LIMIT_KEYS: _fail("ARGUMENT_INVALID", "bootstrap", "hello limits are incomplete")
        if not isinstance(result["capabilities"], list) or len(result["capabilities"]) > 64: _fail("ARGUMENT_INVALID", "bootstrap", "invalid capability array")
        seen = set()
        for cap in result["capabilities"]:
            _object(cap, ("id","available","enforcedScope","limits"), ("reason",), "capability")
            _public_id(cap["id"], "capability id")
            if cap["id"] in seen: _fail("ARGUMENT_INVALID", "bootstrap", "duplicate capability")
            seen.add(cap["id"])
            if type(cap["available"]) is not bool or cap["enforcedScope"] not in ("connection","session","command","process","host-uid","host","none"): _fail("ARGUMENT_INVALID", "bootstrap", "invalid capability")
            _limits(cap["limits"], keys=HELLO_LIMIT_KEYS | LIMIT_KEYS, positive=False)
            if (cap["available"] and ("reason" in cap or cap["enforcedScope"] == "none")) or (not cap["available"] and "reason" not in cap) or (not cap["available"] and cap["enforcedScope"] != "none"): _fail("ARGUMENT_INVALID", "bootstrap", "invalid unavailable capability report")
            if "reason" in cap: _public_id(cap["reason"], "capability reason")
        available = {cap["id"] for cap in result["capabilities"] if cap["available"]}
        if not set(request["args"].get("requiredCapabilities", [])) <= available:
            _fail("CAPABILITY_UNAVAILABLE", "bootstrap", "required capability was not negotiated")
    elif op == "session.open": _object(result, ("sessionId",), label="session.open result"); _handle(result["sessionId"], "sessionId")
    elif op in ("authoring.exec","session.prepare","session.cancel","session.close"):
        _object(result, ("operationId",), label="accepted result"); _safe(result["operationId"], "operationId")
    elif op == "worker.release":
        _object(result, ("operationId","cleanupMode"), label="worker.release result"); _safe(result["operationId"], "operationId")
        if result["cleanupMode"] not in ("dispose-then-terminate","terminate-only"): _fail("ARGUMENT_INVALID", "cleanup", "invalid cleanupMode")
    elif op == "session.authorize": _object(result, ("authorizationId",), label="authorize result"); _handle(result["authorizationId"], "authorizationId")
    elif op == "worker.acquire":
        _object(result, ("workerId","endpoint","attachmentToken","attachmentTimeoutMs","releaseMode"), label="worker descriptor")
        _handle(result["workerId"], "workerId"); _object(result["endpoint"], ("kind","path"), label="endpoint")
        path = _scalar_string(result["endpoint"]["path"], "worker endpoint", 107)
        if (result["endpoint"]["kind"] != "unix" or not path.startswith("/")
                or "\x00" in path or any(part in ("", ".", "..") for part in path.split("/")[1:])):
            _fail("ARGUMENT_INVALID", "attach", "invalid worker endpoint")
        if not isinstance(result["attachmentToken"],str) or re.fullmatch(r"[0-9a-f]{64}",result["attachmentToken"]) is None: _fail("ARGUMENT_INVALID", "attach", "invalid attachment token")
        _safe(result["attachmentTimeoutMs"], "attachmentTimeoutMs")
        if result["releaseMode"] != "control-v1": _fail("ARGUMENT_INVALID", "attach", "invalid releaseMode")
    elif op == "operation.status":
        validate_operation_status(result, operation)
        if result["operationId"] != request["args"]["operationId"]:
            _fail("ARGUMENT_INVALID", "bootstrap", "operation status correlation mismatch")
    elif op == "session.status":
        _object(result, ("phase","resources","cleanup"), label="session status")
        _enum(result["phase"], PHASES, "session phase")
        resources = _object(result["resources"], ("authoringProcesses","buildProcesses","workers","snapshots"), label="resources")
        for key,value in resources.items(): _safe(value,key,positive=False)
        cleanup = _object(result["cleanup"], ("status","remainingResources"), label="cleanup")
        _enum(cleanup["status"], ("notStarted", "pending", "succeeded", "failed"), "cleanup status")
        _remaining_resources(cleanup["remainingResources"])
        if result["phase"] in ("closed", "cleanupFailed"):
            _cleanup_result({"phase": result["phase"], "cleanupStatus": cleanup["status"],
                             "remainingResources": cleanup["remainingResources"]})
    return result


def validate_event(message: Any, operation: str | None = None) -> dict:
    _bounds(message); _object(message, ("v", "kind", "seq", "sessionId", "event", "data"), label="event envelope")
    if type(message["v"]) is not int or message["v"] != 1 or message["kind"] != "event" or type(message["event"]) is not str or message["event"] not in EVENTS: _fail("ARGUMENT_INVALID", "bootstrap", "invalid event envelope", fatal=True)
    _safe(message["seq"], "event sequence"); _handle(message["sessionId"], "sessionId")
    data, name = message["data"], message["event"]
    if name == "operation.finished": validate_operation_status(data, operation, terminal=True)
    elif name in ("authoring.output","build.output"):
        _object(data, ("operationId","stream","chunk","bytesBase64"), label="output event")
        _safe(data["operationId"],"operationId"); _safe(data["chunk"],"chunk")
        if data["stream"] not in ("stdout","stderr"): _fail("ARGUMENT_INVALID", "bootstrap", "invalid output stream")
        try: decoded=base64.b64decode(data["bytesBase64"],validate=True)
        except Exception: _fail("ARGUMENT_INVALID", "bootstrap", "invalid output base64")
        if base64.b64encode(decoded).decode("ascii") != data["bytesBase64"] or len(decoded)>MAX_OUTPUT_CHUNK_BYTES: _fail("ARGUMENT_INVALID", "bootstrap", "noncanonical or oversized output base64")
    elif name in ("worker.started","worker.ready"): _object(data,("workerId",),label=name); _handle(data["workerId"],"workerId")
    elif name == "worker.closing":
        _object(data,("workerId","reason"),label=name); _handle(data["workerId"],"workerId")
        _enum(data["reason"], REASONS, "cleanup reason")
    elif name == "worker.exited":
        _object(data,("workerId","reason"),("exitCode",),label=name); _handle(data["workerId"],"workerId"); _scalar_string(data["reason"],"reason",128)
        _enum(data["reason"], REASONS, "worker exit reason")
        if "exitCode" in data and (type(data["exitCode"]) is not int or abs(data["exitCode"])>MAX_SAFE_INTEGER): _fail("ARGUMENT_INVALID","worker","invalid exitCode")
    elif name == "session.closed":
        _cleanup_result(data)
    return message


def validate_attachment(message: Any, *, success=False) -> dict:
    required = ("v", "kind", "sessionId", "workerId") if success else ("v", "kind", "sessionId", "workerId", "attachmentToken")
    _object(message, required, label="attachment record")
    if type(message["v"]) is not int or message["v"] != 1 or message["kind"] != ("attached" if success else "attach"): _fail("ATTACHMENT_FAILED", "attach", "invalid attachment kind", fatal=True)
    _handle(message["sessionId"], "sessionId"); _handle(message["workerId"], "workerId")
    if not success:
        token = message["attachmentToken"]
        if not isinstance(token, str) or re.fullmatch(r"[0-9a-f]{64}", token) is None: _fail("ATTACHMENT_FAILED", "attach", "invalid attachment token", fatal=True)
    if len(encode_control_frame(message, max_bytes=MAX_ATTACHMENT_FRAME_BYTES)) > MAX_ATTACHMENT_FRAME_BYTES + 1: _fail("ATTACHMENT_FAILED", "attach", "attachment record too large", fatal=True)
    return message


def canonical_base64(data: bytes) -> str:
    if not isinstance(data, bytes) or len(data) > MAX_OUTPUT_CHUNK_BYTES: _fail("LIMIT_EXCEEDED", "authoring", "output chunk exceeds limit")
    return base64.b64encode(data).decode("ascii")
