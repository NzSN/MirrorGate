"""Hosting wire regression tests; actual lifecycle/audit gates are separate."""
import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "supervisor"))
from mirrorgate import control_protocol as v1
from mirrorgate import control_protocol_v2 as v2


def validate_vector(vector):
    value = vector["value"]
    return {"request": lambda: v2.validate_request(value),
            "response": lambda: v2.validate_result(vector["request"], value, operation=vector.get("operation")),
            "event": lambda: v2.validate_event(value, vector.get("operation")),
            "operation": lambda: v2.validate_operation_status(value, vector.get("operation"))}[vector["kind"]]()


class HostingCodecTests(unittest.TestCase):
    def test_shared_vectors(self):
        vectors = [json.loads(line) for line in (ROOT / "conformance/control-v2/vectors.jsonl").read_text().splitlines()]
        self.assertGreaterEqual(len(vectors), 70)
        for vector in vectors:
            with self.subTest(vector["name"]):
                if vector["valid"]:
                    validate_vector(vector)
                else:
                    with self.assertRaises(v1.ControlProtocolError):
                        validate_vector(vector)

    def test_strict_framing_before_hosting_admission(self):
        for frame in (b'{"v":2,"v":2}\n', b'{}\r\n', b'{}', b'{"x":"\\ud800"}\n',
                      b'{"id":9007199254740992}\n', b'\xef\xbb\xbf{}\n', b'{}\n{}\n'):
            with self.subTest(frame=frame), self.assertRaises(v1.ControlProtocolError):
                v2.parse_control_frame(frame)

    def test_bootstrap_never_silently_downgrades(self):
        hello = {"v": 1, "kind": "request", "id": 1, "op": "hello",
                 "args": {"controlVersions": [2], "requiredCapabilities": [v2.HOSTING_CAPABILITY]}}
        self.assertEqual(v2.select_control_version(hello), 2)
        with self.assertRaises(v1.ControlProtocolError) as caught:
            v2.select_control_version(hello, supported=(1,))
        self.assertEqual(caught.exception.code, "VERSION_UNSUPPORTED")
        hello["args"]["controlVersions"] = [1]
        self.assertEqual(v2.select_control_version(hello), 1)
        self.assertIs(v1.codec_for_version(1), v1)
        self.assertIs(v1.codec_for_version(2), v2)
        for invalid in (True, 0, 3, "2", None):
            with self.subTest(invalid=invalid), self.assertRaises(v1.ControlProtocolError):
                v1.codec_for_version(invalid)

    def test_task_utf8_and_path_prefix_boundaries(self):
        task = {"instructions": "x" * 65536, "files": [{"path": "a", "text": "汉" * 87381 + "x"}]}
        v2.validate_public_task(task)  # Exactly 262144 bytes of file content.
        task["files"][0]["text"] += "x"
        with self.assertRaises(v1.ControlProtocolError): v2.validate_public_task(task)
        task = {"instructions": "x", "files": [{"path": "a/b", "text": ""}, {"path": "a", "text": ""}]}
        with self.assertRaises(v1.ControlProtocolError): v2.validate_public_task(task)
        task["files"] = [{"path": "a" * 1024, "text": ""}]
        v2.validate_public_task(task)
        task["files"][0]["path"] += "x"
        with self.assertRaises(v1.ControlProtocolError): v2.validate_public_task(task)

    def test_encoded_progress_limit_counts_json_escaping(self):
        run = {"runId": "3" * 32, "phase": "running",
               "cleanup": {"status": "notStarted", "remainingResources": []},
               "limits": dict(v2.HOST_LIMITS),
               "progress": {"firstSeq": 1, "nextSeq": 2, "truncated": False,
                            "records": [{"seq": 1, "message": "\\" * 8200}]}}
        with self.assertRaises(v1.ControlProtocolError): v2.validate_run(run)
        run["progress"]["records"][0]["message"] = "a"
        v2.validate_run(run)
        size = len(v2.encode_control_frame(run["progress"]["records"][0])) - 1
        run["limits"]["progressBytes"] = size
        v2.validate_run(run)
        run["limits"]["progressBytes"] = size - 1
        with self.assertRaises(v1.ControlProtocolError): v2.validate_run(run)

    def test_frozen_contract_matches_codec(self):
        c = json.loads((ROOT / "protocol/control-v2/contract.json").read_text())
        self.assertEqual(set(c["operations"]), v2.OPERATIONS)
        self.assertEqual(set(c["constants"]["eventNames"]), v2.EVENTS)
        self.assertEqual(set(c["constants"]["phases"]), v2.PHASES)
        self.assertEqual(set(c["constants"]["errorCodes"]), v2.ERROR_CODES)
        self.assertEqual(set(c["constants"]["errorStages"]), v2.ERROR_STAGES)
        self.assertEqual(c["hostingLimits"], v2.HOST_LIMITS)
        schema = json.loads((ROOT / "protocol/control-v2/schema.json").read_text())
        for definition in schema["$defs"].values():
            if definition.get("type") == "object":
                self.assertIs(definition["additionalProperties"], False)
        self.assertEqual(schema["$defs"]["HostedRun"]["required"], ["runId", "phase", "cleanup", "limits", "progress"])


if __name__ == "__main__":
    unittest.main()
