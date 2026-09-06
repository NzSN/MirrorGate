"""Common acceptance vectors plus admission/resource/correlation regressions."""

import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "supervisor"))

from mirrorgate.protocol import (  # noqa: E402
    MAX_FRAME_BYTES, MAX_MANIFEST_BYTES, MAX_NODES, ProtocolError,
    encode_frame, load_manifest, parse_frame, validate_inputs, validate_manifest,
    validate_observations, validate_request, validate_response, validate_result,
    validate_type, validate_value,
)


def counter_manifest():
    return {
        "schema": "mirrorgate.port/v1", "interfaceDigest": "0" * 64,
        "initializers": [{"id": "Initialize", "inputs": []}],
        "actions": [{"id": "Tick", "inputs": [{"id": "Stride", "type": {"kind": "int"}}]}],
        "observations": [{"id": "Count", "type": {"kind": "int"}}],
    }


class SharedCorpus(unittest.TestCase):
    def test_vectors(self):
        validators = {"request": validate_request, "response": validate_response,
                      "manifest": validate_manifest}
        vectors = [json.loads(line) for line in (ROOT / "conformance/vectors.jsonl").read_text().splitlines()]
        self.assertGreaterEqual(len(vectors), 90)
        for vector in vectors:
            with self.subTest(vector["name"]):
                def check():
                    if vector["kind"] == "frame":
                        return parse_frame(bytes.fromhex(vector["hex"]))
                    if vector["kind"] == "value":
                        return validate_value(vector["type"], vector["value"])
                    return validators[vector["kind"]](vector["value"])
                if vector["valid"]:
                    check()
                else:
                    with self.assertRaises(ProtocolError):
                        check()


class Admission(unittest.TestCase):
    def setUp(self):
        self.manifest = validate_manifest(counter_manifest())

    def test_inputs_and_observations_exact(self):
        validate_inputs(self.manifest, "Initialize", {})
        validate_inputs(self.manifest, "Tick", {"Stride": {"#bigint": "9007199254740993"}})
        validate_observations(self.manifest, {"Count": {"#bigint": "9007199254740993"}})
        for fn in [lambda: validate_inputs(self.manifest, "Unknown", {}),
                   lambda: validate_inputs(self.manifest, "Tick", {}),
                   lambda: validate_inputs(self.manifest, "Initialize", {"ExpectedCount": 0}),
                   lambda: validate_observations(self.manifest, {"Count": {"#bigint": "1"}, "Private": None}),
                   lambda: validate_observations(self.manifest, {"Count": 1})]:
            with self.assertRaises(ProtocolError):
                fn()

    def test_manifest_source_strict_and_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "public.json"
            path.write_text(json.dumps(self.manifest))
            self.assertEqual(load_manifest(path), self.manifest)
            path.write_bytes(b" " * (MAX_MANIFEST_BYTES + 1))
            with self.assertRaisesRegex(ProtocolError, "byte budget"):
                load_manifest(path)
            path.write_text('{"schema":"mirrorgate.port/v1","schema":"override"}')
            with self.assertRaisesRegex(ProtocolError, "duplicate"):
                load_manifest(path)

    def test_no_private_fields_nested(self):
        for key in ("wireAction", "projection", "expectedState", "invariant", "specPath"):
            manifest = copy.deepcopy(self.manifest)
            manifest["actions"][0][key] = "private"
            with self.assertRaises(ProtocolError):
                validate_manifest(manifest)

    def test_type_depth_budget(self):
        shape = {"kind": "int"}
        for _ in range(32):
            shape = {"kind": "seq", "element": shape}
        validate_type(shape)
        with self.assertRaisesRegex(ProtocolError, "type depth"):
            validate_type({"kind": "seq", "element": shape})

    def test_value_and_node_budgets(self):
        shape, value = {"kind": "null"}, None
        for _ in range(32):
            shape, value = {"kind": "seq", "element": shape}, [value]
        validate_value(shape, value)
        with self.assertRaisesRegex(ProtocolError, "node budget"):
            validate_value({"kind": "seq", "element": {"kind": "null"}}, [None] * MAX_NODES)

    def test_unicode_name_byte_budget(self):
        shape = {"kind": "record", "fields": [{"wireName": "é" * 64, "type": {"kind": "str"}}]}
        validate_type(shape)
        shape["fields"][0]["wireName"] += "é"
        with self.assertRaises(ProtocolError):
            validate_type(shape)


class FramingAndCorrelation(unittest.TestCase):
    def test_frame_byte_boundary(self):
        overhead = len(b'{"x":""}')
        frame = b'{"x":"' + b"a" * (MAX_FRAME_BYTES - overhead) + b'"}\n'
        self.assertEqual(len(frame), MAX_FRAME_BYTES + 1)
        parse_frame(frame)
        with self.assertRaisesRegex(ProtocolError, "byte budget"):
            parse_frame(frame[:-2] + b'a"}\n')

    def test_exact_numeric_parser(self):
        for token in ("1.0", "10e-1", "1e0", "0e999", "-0"):
            value = parse_frame(('{"v":' + token + '}\n').encode())["v"]
            self.assertIs(type(value), int)
        for token in ("1.0000000000000000000001", "0.9999999999999999999999",
                      "9007199254740991.1", "1e-9999", "1e999999999999999999999"):
            with self.assertRaises(ProtocolError):
                parse_frame(('{"v":' + token + '}\n').encode())

    def test_encode_bounds(self):
        message = {"v": 1, "id": 1, "op": "create"}
        self.assertEqual(parse_frame(encode_frame(message)), message)
        with self.assertRaises(ProtocolError):
            encode_frame({"x": "a" * MAX_FRAME_BYTES})
        with self.assertRaises(ProtocolError):
            encode_frame({"x": "\ud800"})

    def test_response_correlation_and_shape(self):
        manifest = counter_manifest()
        request = {"v": 1, "id": 1, "op": "hello", "interfaceDigest": "0" * 64, "runtime": "node-v1"}
        response = {"v": 1, "id": 1, "ok": True, "result": {"interfaceDigest": "0" * 64, "runtime": "node-v1"}}
        validate_result(request, response, manifest)
        response["result"]["runtime"] = "rust-v1"
        with self.assertRaisesRegex(ProtocolError, "identity"):
            validate_result(request, response, manifest)
        response["id"] = 2
        with self.assertRaisesRegex(ProtocolError, "uncorrelated"):
            validate_result(request, response, manifest)
        request = {"v": 1, "id": 3, "op": "invoke", "action": "Initialize", "inputs": {}}
        with self.assertRaisesRegex(ProtocolError, "null"):
            validate_result(request, {"v": 1, "id": 3, "ok": True, "result": {}}, manifest)
        request = {"v": 1, "id": 4, "op": "observe"}
        with self.assertRaises(ProtocolError):
            validate_result(request, {"v": 1, "id": 4, "ok": True, "result": {"Expected": 1}}, manifest)


if __name__ == "__main__":
    unittest.main()
