"""Control v2 hosting codec; frozen v1 remains independently selectable.

Framing and the bootstrap envelope are v1. After selection all administrative
frames use v2. Worker attachment and worker RPC remain v1. No validator allocates
resources; owner, policy, audit, deadline and slot admission are controller work.
"""
from __future__ import annotations

from typing import Any

from . import control_protocol as v1
from .control_protocol import (ControlProtocolError, encode_control_frame,
    parse_control_frame, validate_attachment, validate_operation_status,
    validate_terminal_result)

VERSION = 2
HOSTING_CAPABILITY = "hosting.fresh-agent-v1"
OPERATIONS = v1.OPERATIONS | {"agent.start", "agent.status", "agent.cancel"}
EVENTS = v1.EVENTS | {"agent.updated", "agent.finished"}
PHASES = v1.PHASES | {"submitted"}
RUN_PHASES = {"starting", "running", "submitting", "cleaning", "finished"}
RUN_OUTCOMES = {"submitted", "failed", "cancelled", "timedOut"}
ERROR_CODES = v1.ERROR_CODES | {"AGENT_START_FAILED", "AGENT_EXITED", "AUDIT_UNAVAILABLE"}
ERROR_STAGES = v1.ERROR_STAGES | {"hosting"}
HOST_LIMITS = {"wallMs": 300_000, "stdoutBytes": 1_048_576,
               "stderrBytes": 1_048_576, "progressRecords": 256,
               "progressBytes": 262_144, "progressRecordBytes": 16_384}
MAX_INSTRUCTION_BYTES = 65_536
MAX_PUBLIC_FILES = 128
MAX_PUBLIC_FILE_BYTES = 262_144
MAX_PUBLIC_PATH_BYTES = 1_024


def validate_public_task(value: Any) -> dict:
    v1._bounds(value)
    v1._object(value, ("instructions", "files"), label="public task")
    v1._scalar_string(value["instructions"], "instructions", MAX_INSTRUCTION_BYTES)
    files = value["files"]
    if type(files) is not list or len(files) > MAX_PUBLIC_FILES:
        v1._fail("LIMIT_EXCEEDED", "hosting", "public files exceed count limit")
    paths, total = set(), 0
    for item in files:
        v1._object(item, ("path", "text"), label="public file")
        path = v1._scalar_string(item["path"], "public file path", MAX_PUBLIC_PATH_BYTES)
        if (path.startswith("/") or "\\" in path or "\x00" in path
                or any(part in ("", ".", "..") for part in path.split("/"))
                or path.split("/")[0] == ".mirrorgate"):
            v1._fail("ARGUMENT_INVALID", "hosting", "noncanonical or reserved public file path")
        # File/directory collisions would otherwise make staging order-dependent.
        if path in paths or any(path.startswith(p + "/") or p.startswith(path + "/") for p in paths):
            v1._fail("ARGUMENT_INVALID", "hosting", "colliding public file paths")
        paths.add(path)
        total += len(v1._scalar_string(item["text"], "public file text", MAX_PUBLIC_FILE_BYTES, False).encode("utf-8"))
        if total > MAX_PUBLIC_FILE_BYTES:
            v1._fail("LIMIT_EXCEEDED", "hosting", "public file text exceeds aggregate limit")
    return value


def validate_host_limits(value: Any, *, complete: bool = False) -> dict:
    v1._object(value, HOST_LIMITS if complete else (), () if complete else HOST_LIMITS, "hosting limits")
    for key, item in value.items():
        v1._safe(item, key)
        if item > HOST_LIMITS[key]:
            v1._fail("LIMIT_EXCEEDED", "hosting", f"{key} exceeds hosting ceiling")
    return value


def validate_request(message: Any) -> dict:
    v1._bounds(message)
    v1._object(message, ("v", "kind", "id", "op", "args"), label="request envelope")
    if message.get("op") == "hello":
        return v1.validate_request(message)
    if (type(message["v"]) is not int or message["v"] != VERSION
            or message["kind"] != "request" or type(message["op"]) is not str
            or message["op"] not in OPERATIONS):
        v1._fail("ARGUMENT_INVALID", "bootstrap", "invalid v2 request envelope or operation", fatal=True)
    v1._safe(message["id"], "request id")
    op, args = message["op"], message["args"]
    if not op.startswith("agent."):
        v1.validate_request(dict(message, v=1))
        return message
    required = {"agent.start": ("sessionId", "profileId", "publicTask"),
                "agent.status": ("sessionId",), "agent.cancel": ("sessionId", "runId", "reason")}[op]
    optional = {"agent.start": ("limits",), "agent.status": ("runId",), "agent.cancel": ()}[op]
    v1._object(args, required, optional, f"{op} arguments")
    v1._handle(args["sessionId"], "sessionId")
    if "runId" in args:
        v1._handle(args["runId"], "runId")
    if op == "agent.start":
        v1._public_id(args["profileId"], "profileId")
        validate_public_task(args["publicTask"])
        if "limits" in args:
            validate_host_limits(args["limits"])
    elif op == "agent.cancel":
        v1._enum(args["reason"], v1.REASONS, "cancellation reason")
    return message


def validate_error(value: Any) -> dict:
    v1._object(value, ("code", "stage", "message"), ("operationId",), "control error")
    v1._enum(value["code"], ERROR_CODES, "error code")
    v1._enum(value["stage"], ERROR_STAGES, "error stage")
    v1._scalar_string(value["message"], "error message", 1024, False)
    if "operationId" in value:
        v1._safe(value["operationId"], "operationId")
    return value


def validate_submission(value: Any) -> dict:
    v1._object(value, ("submissionId", "sourceHash", "sourceRevision"), label="source submission")
    v1._handle(value["submissionId"], "submissionId")
    v1._digest(value["sourceHash"], "sourceHash")
    if type(value["sourceRevision"]) is not int or value["sourceRevision"] != 1:
        v1._fail("ARGUMENT_INVALID", "hosting", "invalid source revision")
    return value


def validate_run(value: Any) -> dict:
    v1._bounds(value)
    v1._object(value, ("runId", "phase", "cleanup", "limits", "progress"),
               ("outcome", "submission", "error"), "hosted run")
    v1._handle(value["runId"], "runId")
    phase = v1._enum(value["phase"], RUN_PHASES, "run phase")
    limits = validate_host_limits(value["limits"], complete=True)
    cleanup = v1._object(value["cleanup"], ("status", "remainingResources"), label="hosting cleanup")
    v1._enum(cleanup["status"], {"notStarted", "pending", "succeeded", "failed"}, "cleanup status")
    v1._remaining_resources(cleanup["remainingResources"])
    if cleanup["status"] in ("notStarted", "succeeded") and cleanup["remainingResources"]:
        v1._fail("ARGUMENT_INVALID", "hosting", "incoherent hosting cleanup")
    if "outcome" in value:
        v1._enum(value["outcome"], RUN_OUTCOMES, "run outcome")
    if "submission" in value:
        validate_submission(value["submission"])
    if (value.get("outcome") == "submitted") != ("submission" in value):
        v1._fail("ARGUMENT_INVALID", "hosting", "submission and primary outcome disagree")
    if "error" in value:
        validate_error(value["error"])
    if (value.get("outcome") in {"failed", "cancelled", "timedOut"}) != ("error" in value):
        v1._fail("ARGUMENT_INVALID", "hosting", "failure outcome and primary error disagree")
    expected_cleanup = {"starting": {"notStarted"}, "running": {"notStarted"},
                        "submitting": {"notStarted"}, "cleaning": {"pending"},
                        "finished": {"succeeded", "failed"}}[phase]
    if cleanup["status"] not in expected_cleanup or ((phase in {"cleaning", "finished"}) != ("outcome" in value)):
        v1._fail("ARGUMENT_INVALID", "hosting", "run phase and outcome/cleanup disagree")
    progress = v1._object(value["progress"], ("firstSeq", "nextSeq", "truncated", "records"), label="run progress")
    first = v1._safe(progress["firstSeq"], "firstSeq")
    end = v1._safe(progress["nextSeq"], "nextSeq")
    records = progress["records"]
    if (type(progress["truncated"]) is not bool or progress["truncated"] != (first > 1)
            or type(records) is not list or len(records) > limits["progressRecords"]
            or end != first + len(records)):
        v1._fail("ARGUMENT_INVALID", "hosting", "invalid bounded progress window")
    total = 0
    for seq, record in enumerate(records, first):
        v1._object(record, ("seq", "message"), label="progress record")
        if type(record["seq"]) is not int or record["seq"] != seq:
            v1._fail("ARGUMENT_INVALID", "hosting", "noncontiguous progress sequence")
        v1._scalar_string(record["message"], "progress message", limits["progressRecordBytes"], False)
        size = len(encode_control_frame(record)) - 1
        if size > limits["progressRecordBytes"]:
            v1._fail("LIMIT_EXCEEDED", "hosting", "progress record exceeds encoded byte limit")
        total += size
    if total > limits["progressBytes"]:
        v1._fail("LIMIT_EXCEEDED", "hosting", "progress window exceeds encoded byte limit")
    return value


def validate_response(message: Any, request: dict | None = None) -> dict:
    v1._bounds(message)
    if isinstance(message, dict) and message.get("ok") is True:
        v1._object(message, ("v", "kind", "id", "ok", "result"), label="success response")
    else:
        v1._object(message, ("v", "kind", "id", "ok", "error"), label="failure response")
        validate_error(message["error"])
    expected = 1 if request is not None and request.get("op") == "hello" else 2
    if type(message["v"]) is not int or message["v"] != expected or message["kind"] != "response" or type(message["ok"]) is not bool:
        v1._fail("ARGUMENT_INVALID", "bootstrap", "invalid response envelope")
    v1._safe(message["id"], "response id")
    if request is not None and message["id"] != request["id"]:
        v1._fail("ARGUMENT_INVALID", "bootstrap", "uncorrelated response", fatal=True)
    return message


def validate_result(request: dict, response: dict, *, operation: str | None = None) -> Any:
    validate_request(request)
    validate_response(response, request)
    if not response["ok"]:
        return response["error"]
    op, result = request["op"], response["result"]
    if op == "hello":
        selected = result.get("controlVersion") if isinstance(result, dict) else None
        if type(selected) is not int or selected not in (1, 2) or selected not in request["args"]["controlVersions"]:
            v1._fail("VERSION_UNSUPPORTED", "bootstrap", "selected control version was not offered")
        v1.validate_result(request, dict(response, result=dict(result, controlVersion=1)))
        if selected == 1 and any(cap["id"].startswith("hosting.") for cap in result["capabilities"]):
            v1._fail("ARGUMENT_INVALID", "bootstrap", "v1 selection exposes hosting capability")
    elif op == "agent.start":
        v1._object(result, ("runId",), label="accepted run")
        v1._handle(result["runId"], "runId")
    elif op in ("agent.status", "agent.cancel"):
        v1._object(result, ("run",), label="run result")
        if result["run"] is None:
            if op != "agent.status" or "runId" in request["args"]:
                v1._fail("HANDLE_INVALID", "hosting", "explicit run cannot be absent")
        else:
            validate_run(result["run"])
            if request["args"].get("runId", result["run"]["runId"]) != result["run"]["runId"]:
                v1._fail("HANDLE_INVALID", "hosting", "uncorrelated run result")
            if op == "agent.cancel" and result["run"]["phase"] != "finished":
                v1._fail("ARGUMENT_INVALID", "hosting", "cancellation must join hosting cleanup")
    elif op == "session.status" and isinstance(result, dict) and result.get("phase") == "submitted":
        v1.validate_result(dict(request, v=1), dict(response, v=1, result=dict(result, phase="authoring")))
        if result["cleanup"]["status"] != "notStarted":
            v1._fail("ARGUMENT_INVALID", "hosting", "submitted session already closing")
    else:
        v1.validate_result(dict(request, v=1), dict(response, v=1), operation=operation)
    return result


def validate_event(message: Any, operation: str | None = None) -> dict:
    v1._bounds(message)
    v1._object(message, ("v", "kind", "seq", "sessionId", "event", "data"), label="event envelope")
    if type(message["v"]) is not int or message["v"] != 2 or message["kind"] != "event" or type(message["event"]) is not str or message["event"] not in EVENTS:
        v1._fail("ARGUMENT_INVALID", "bootstrap", "invalid v2 event envelope", fatal=True)
    v1._safe(message["seq"], "event sequence")
    v1._handle(message["sessionId"], "sessionId")
    if message["event"].startswith("agent."):
        v1._object(message["data"], ("run",), label="run event")
        validate_run(message["data"]["run"])
        finished = message["data"]["run"]["phase"] == "finished"
        if finished != (message["event"] == "agent.finished"):
            v1._fail("ARGUMENT_INVALID", "hosting", "run event and phase disagree")
    else:
        v1.validate_event(dict(message, v=1), operation)
    return message


def select_control_version(hello: dict, *, supported: tuple[int, ...] = (1, 2)) -> int:
    """Validate the frozen bootstrap then choose the highest common version.

    Capability/policy admission must still happen before accepting hello. A
    hosting-only caller offers [2], so a v1 controller cannot silently downgrade.
    """
    v1.validate_request(hello)
    if hello["op"] != "hello":
        v1._fail("ARGUMENT_INVALID", "bootstrap", "hello required", fatal=True)
    candidates = set(hello["args"]["controlVersions"]) & set(supported)
    if not candidates:
        v1._fail("VERSION_UNSUPPORTED", "bootstrap", "no supported control version")
    return max(candidates)
