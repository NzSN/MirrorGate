"""Strict, language-neutral MirrorGate port/v1 admission and value validation.

This module does not load adapters, select sandbox permissions, or trust a
worker-supplied identity. See docs/protocol-v1.md for correlation and lifecycle.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal, DecimalException
from pathlib import Path
from typing import Any

MAX_FRAME_BYTES = 65_535
MAX_MANIFEST_BYTES = 262_144
MAX_JSON_DEPTH = 96
MAX_TYPE_DEPTH = 32
MAX_VALUE_DEPTH = 32
MAX_NODES = 8_192
MAX_SAFE_INTEGER = 9_007_199_254_740_991
IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,127}\Z", re.ASCII)
DIGEST = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
ERROR_CODE = re.compile(r"[A-Z][A-Z0-9_]{0,63}\Z", re.ASCII)
INTEGER = re.compile(r"(?:0|-?[1-9][0-9]*)\Z", re.ASCII)


class ProtocolError(ValueError):
    """Bounded public failure; no private evaluator content belongs here."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _fail(code: str, message: str) -> None:
    raise ProtocolError(code, message)


def _string(value: Any, maximum: int | None = None, nonempty: bool = False) -> None:
    if not isinstance(value, str):
        _fail("SCHEMA", "expected string")
    try:
        size = len(value.encode("utf-8", errors="strict"))
    except UnicodeError:
        _fail("SCHEMA", "strings must contain Unicode scalars")
    if (nonempty and not size) or (maximum is not None and size > maximum):
        _fail("SCHEMA", "string length outside permitted bounds")


def _identifier(value: Any) -> None:
    if not isinstance(value, str) or IDENTIFIER.fullmatch(value) is None:
        _fail("SCHEMA", "invalid public identifier")


def _digest(value: Any) -> None:
    if not isinstance(value, str) or DIGEST.fullmatch(value) is None:
        _fail("SCHEMA", "invalid interface digest")


def _object(value: Any, keys: set[str] | None = None, code: str = "SCHEMA") -> dict:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        _fail(code, "expected object")
    if keys is not None and set(value) != keys:
        _fail(code, "object fields do not match contract")
    return value


def _array(value: Any, nonempty: bool = False) -> list:
    if not isinstance(value, list) or (nonempty and not value):
        _fail("SCHEMA", "expected array" + (" with at least one item" if nonempty else ""))
    return value


def _json_bounds(value: Any) -> None:
    stack = [(value, 0)]
    count = 0
    while stack:
        item, depth = stack.pop()
        count += 1
        if depth > MAX_JSON_DEPTH or count > MAX_NODES:
            _fail("LIMIT", "JSON depth or node budget exceeded")
        if isinstance(item, dict):
            for key, child in item.items():
                _string(key)
                stack.append((child, depth + 1))
        elif isinstance(item, list):
            stack.extend((child, depth + 1) for child in item)
        elif isinstance(item, str):
            _string(item)
        elif type(item) is int:
            if abs(item) > MAX_SAFE_INTEGER:
                _fail("SCHEMA", "JSON numbers must be safe integers")
        elif item is not None and type(item) is not bool:
            _fail("SCHEMA", "unsupported JSON value or nonintegral number")


def _pairs(items: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in items:
        if key in result:
            _fail("FRAME", "duplicate JSON object key")
        result[key] = value
    return result


def _invalid_constant(_value: str) -> None:
    _fail("FRAME", "nonfinite JSON number")


def _exact_number(token: str) -> int:
    try:
        coefficient = re.split(r"[eE]", token, maxsplit=1)[0].replace("-", "").replace(".", "")
        if not coefficient.strip("0"):
            return 0
        number = Decimal(token)
        if (not number.is_finite() or not -MAX_SAFE_INTEGER <= number <= MAX_SAFE_INTEGER
                or number != number.to_integral_value()):
            _fail("SCHEMA", "JSON numbers must be exact safe integers")
        return int(number)
    except (DecimalException, OverflowError, ValueError):
        _fail("SCHEMA", "JSON number exceeds supported bounds")


def _parse_json(data: bytes) -> Any:
    try:
        value = json.loads(data.decode("utf-8", errors="strict"),
                           object_pairs_hook=_pairs, parse_constant=_invalid_constant,
                           parse_float=_exact_number, parse_int=_exact_number)
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        if isinstance(exc, ProtocolError):
            raise
        _fail("FRAME", "invalid UTF-8 JSON")
    _json_bounds(value)
    return value


def parse_frame(data: bytes) -> dict:
    """Parse exactly one LF-terminated frame, checking bytes before decoding."""
    if not isinstance(data, bytes):
        _fail("FRAME", "frame must be bytes")
    if len(data) > MAX_FRAME_BYTES + 1:
        _fail("LIMIT", "frame byte budget exceeded")
    if not data.endswith(b"\n") or b"\n" in data[:-1] or b"\r" in data:
        _fail("FRAME", "frame must have one LF terminator and no literal CR")
    if not data[:-1].strip():
        _fail("FRAME", "empty frame")
    return _object(_parse_json(data[:-1]))


def encode_frame(message: dict) -> bytes:
    """Serialize a bounded object. Call operation-specific validation first."""
    _object(message)
    _json_bounds(message)
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"),
                         allow_nan=False).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        _fail("LIMIT", "frame byte budget exceeded")
    return payload + b"\n"


def _request_id(value: Any) -> None:
    if type(value) is not int or not 1 <= value <= MAX_SAFE_INTEGER:
        _fail("SCHEMA", "request ID must be a positive safe integer")


def validate_request(message: Any) -> dict:
    _json_bounds(message)
    _object(message)
    if type(message.get("v")) is not int or message["v"] != 1:
        _fail("SCHEMA", "unsupported protocol version")
    _request_id(message.get("id"))
    op = message.get("op")
    fields = {"hello": {"interfaceDigest", "runtime"}, "create": set(),
              "invoke": {"action", "inputs"}, "observe": set(),
              "dispose": set(), "cancel": {"requestId"}}
    if not isinstance(op, str) or op not in fields:
        _fail("SCHEMA", "unknown operation")
    _object(message, {"v", "id", "op"} | fields[op])
    if op == "hello":
        _digest(message["interfaceDigest"])
        _identifier(message["runtime"])
    elif op == "invoke":
        _identifier(message["action"])
        _object(message["inputs"])
        for name in message["inputs"]:
            _identifier(name)
    elif op == "cancel":
        _request_id(message["requestId"])
        if message["requestId"] >= message["id"]:
            _fail("SCHEMA", "cancel target must precede its request ID")
    return message


def validate_response(message: Any) -> dict:
    _json_bounds(message)
    _object(message)
    if type(message.get("v")) is not int or message["v"] != 1:
        _fail("SCHEMA", "unsupported protocol version")
    _request_id(message.get("id"))
    if type(message.get("ok")) is not bool:
        _fail("SCHEMA", "response ok must be boolean")
    if message["ok"]:
        _object(message, {"v", "id", "ok", "result"})
    else:
        _object(message, {"v", "id", "ok", "error"})
        error = _object(message["error"], {"code", "message"})
        if not isinstance(error["code"], str) or ERROR_CODE.fullmatch(error["code"]) is None:
            _fail("SCHEMA", "invalid error code")
        _string(error["message"], 1024)
    return message


def validate_result(request: dict, response: dict, manifest: dict) -> Any:
    """Check correlation and success result shape; return result, or error dict."""
    validate_request(request)
    validate_response(response)
    if response["id"] != request["id"]:
        _fail("SCHEMA", "uncorrelated response")
    if not response["ok"]:
        return response["error"]
    result = response["result"]
    if request["op"] == "hello":
        _object(result, {"interfaceDigest", "runtime"})
        if (result["interfaceDigest"] != request["interfaceDigest"] or
                result["runtime"] != request["runtime"]):
            _fail("HANDSHAKE", "worker identity does not match requested interface/runtime")
    elif request["op"] == "observe":
        validate_observations(manifest, result)
    elif result is not None:
        _fail("SCHEMA", "operation result must be null")
    return result


def _unique(items: list, field: str, label: str) -> None:
    found = set()
    for item in items:
        value = item[field]
        if value in found:
            _fail("SCHEMA", "duplicate " + label)
        found.add(value)


def _type(shape: Any, depth: int = 0) -> None:
    if depth > MAX_TYPE_DEPTH:
        _fail("LIMIT", "type depth budget exceeded")
    _object(shape)
    kind = shape.get("kind")
    if kind in ("int", "bool", "str", "null"):
        _object(shape, {"kind"})
    elif kind in ("set", "seq"):
        _object(shape, {"kind", "element"})
        _type(shape["element"], depth + 1)
    elif kind == "tuple":
        _object(shape, {"kind", "elements"})
        for item in _array(shape["elements"]):
            _type(item, depth + 1)
    elif kind == "record":
        _object(shape, {"kind", "fields"})
        fields = _array(shape["fields"])
        for item in fields:
            _object(item, {"wireName", "type"})
            _string(item["wireName"], 128, True)
            _type(item["type"], depth + 1)
        _unique(fields, "wireName", "record field")
    elif kind == "map":
        _object(shape, {"kind", "key", "value"})
        if shape["key"] != {"kind": "str"}:
            _fail("SCHEMA", "portable maps require string keys")
        _type(shape["key"], depth + 1)
        _type(shape["value"], depth + 1)
    elif kind == "variant":
        _object(shape, {"kind", "cases"})
        cases = _array(shape["cases"], True)
        for item in cases:
            _object(item, {"tag", "payload"})
            _string(item["tag"], 128, True)
            _type(item["payload"], depth + 1)
        _unique(cases, "tag", "variant tag")
    else:
        _fail("SCHEMA", "unsupported portable type")


def validate_type(shape: Any) -> dict:
    _json_bounds(shape)
    _type(shape)
    return shape


def validate_manifest(manifest: Any) -> dict:
    _json_bounds(manifest)
    _object(manifest, {"schema", "interfaceDigest", "initializers", "actions", "observations"})
    if manifest["schema"] != "mirrorgate.port/v1":
        _fail("SCHEMA", "unsupported public manifest schema")
    _digest(manifest["interfaceDigest"])
    initializers = _array(manifest["initializers"], True)
    actions = _array(manifest["actions"])
    observations = _array(manifest["observations"], True)
    for action in initializers + actions:
        _object(action, {"id", "inputs"})
        _identifier(action["id"])
        inputs = _array(action["inputs"])
        for item in inputs:
            _object(item, {"id", "type"})
            _identifier(item["id"])
            _type(item["type"])
        _unique(inputs, "id", "input ID")
    _unique(initializers + actions, "id", "operation ID")
    for item in observations:
        _object(item, {"id", "type"})
        _identifier(item["id"])
        _type(item["type"])
    _unique(observations, "id", "observation ID")
    if len(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_MANIFEST_BYTES:
        _fail("LIMIT", "manifest byte budget exceeded")
    return manifest


def load_manifest(path: str | Path) -> dict:
    with Path(path).open("rb") as stream:
        data = stream.read(MAX_MANIFEST_BYTES + 1)
    if len(data) > MAX_MANIFEST_BYTES:
        _fail("LIMIT", "manifest byte budget exceeded")
    return validate_manifest(_parse_json(data))


def _value(shape: dict, value: Any, depth: int = 0) -> Any:
    """Validate and return a hashable semantic key for set/map duplicate checks."""
    if depth > MAX_VALUE_DEPTH:
        _fail("LIMIT", "value depth budget exceeded")
    kind = shape["kind"]
    if kind == "int":
        _object(value, {"#bigint"}, "VALUE")
        number = value["#bigint"]
        if not isinstance(number, str) or INTEGER.fullmatch(number) is None:
            _fail("VALUE", "integer must be a canonical decimal string")
        return (kind, number)
    if kind == "bool":
        if type(value) is not bool:
            _fail("VALUE", "expected boolean")
        return (kind, value)
    if kind == "str":
        if not isinstance(value, str):
            _fail("VALUE", "expected string")
        return (kind, value)
    if kind == "null":
        if value is not None:
            _fail("VALUE", "expected null")
        return (kind,)
    if kind in ("set", "seq", "tuple"):
        values = value
        if kind != "seq":
            marker = "#set" if kind == "set" else "#tup"
            _object(value, {marker}, "VALUE")
            values = value[marker]
        if not isinstance(values, list):
            _fail("VALUE", "expected collection array")
        if kind == "tuple":
            if len(values) != len(shape["elements"]):
                _fail("VALUE", "tuple arity does not match")
            keys = tuple(_value(t, v, depth + 1) for t, v in zip(shape["elements"], values))
        else:
            keys = tuple(_value(shape["element"], v, depth + 1) for v in values)
        if kind == "set":
            unique = frozenset(keys)
            if len(unique) != len(keys):
                _fail("VALUE", "duplicate set member")
            return (kind, unique)
        return (kind, keys)
    if kind == "record":
        fields = shape["fields"]
        _object(value, {item["wireName"] for item in fields}, "VALUE")
        return (kind, frozenset((item["wireName"], _value(item["type"], value[item["wireName"]], depth + 1))
                                for item in fields))
    if kind == "map":
        _object(value, {"#map"}, "VALUE")
        entries = value["#map"]
        if not isinstance(entries, list):
            _fail("VALUE", "expected map entry array")
        seen = set()
        keys = []
        for entry in entries:
            if not isinstance(entry, list) or len(entry) != 2 or not isinstance(entry[0], str):
                _fail("VALUE", "expected string-key map pair")
            if entry[0] in seen:
                _fail("VALUE", "duplicate map key")
            seen.add(entry[0])
            keys.append((entry[0], _value(shape["value"], entry[1], depth + 1)))
        return (kind, frozenset(keys))
    if kind == "variant":
        _object(value, {"tag", "value"}, "VALUE")
        for case in shape["cases"]:
            if value["tag"] == case["tag"]:
                return (kind, case["tag"], _value(case["payload"], value["value"], depth + 1))
        _fail("VALUE", "unknown variant tag")
    _fail("SCHEMA", "unsupported portable type")


def validate_value(shape: Any, value: Any) -> Any:
    validate_type(shape)
    _json_bounds(value)
    _value(shape, value)
    return value


def operation(manifest: dict, action: str) -> dict:
    for item in manifest["initializers"] + manifest["actions"]:
        if item["id"] == action:
            return item
    _fail("VALUE", "undeclared operation")


def validate_inputs(manifest: dict, action: str, inputs: Any) -> dict:
    selected = operation(manifest, action)
    _json_bounds(inputs)
    _object(inputs, {item["id"] for item in selected["inputs"]}, "VALUE")
    for item in selected["inputs"]:
        _value(item["type"], inputs[item["id"]])
    return inputs


def validate_observations(manifest: dict, values: Any) -> dict:
    _json_bounds(values)
    _object(values, {item["id"] for item in manifest["observations"]}, "VALUE")
    for item in manifest["observations"]:
        _value(item["type"], values[item["id"]])
    return values
