import io
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "supervisor"))

from mirrorgate.control_protocol import (ControlProtocolError, MAX_FRAME_BYTES,
    encode_control_frame, parse_control_frame, validate_attachment, validate_event,
    validate_operation_status, validate_request, validate_response, validate_result)


class ControlCodecTests(unittest.TestCase):
    def test_shared_vectors(self):
        vectors = [json.loads(line) for line in (ROOT / "conformance/control-v1/vectors.jsonl").read_text().splitlines()]
        self.assertGreaterEqual(len(vectors), 25)
        for vector in vectors:
            validators = {
                "request": lambda: validate_request(vector["value"]),
                "response": lambda: validate_result(vector["request"], vector["value"],
                                                    operation=vector.get("operation")),
                "event": lambda: validate_event(vector["value"], vector.get("operation")),
                "operation": lambda: validate_operation_status(vector["value"], vector.get("operation")),
                "attachment": lambda: validate_attachment(vector["value"]),
                "attached": lambda: validate_attachment(vector["value"], success=True),
            }
            with self.subTest(vector["name"]):
                if vector["valid"]: validators[vector["kind"]]()
                else:
                    with self.assertRaises(ControlProtocolError): validators[vector["kind"]]()

    def test_strict_framing_duplicate_bom_unicode_and_bounds(self):
        invalid = [b'{"v":1,"v":1}\n', b'\xef\xbb\xbf{}\n', b'{}\r\n', b'\n', b'{}', b'{"x":"\xed\xa0\x80"}\n']
        for frame in invalid:
            with self.subTest(frame=frame[:20]), self.assertRaises(ControlProtocolError): parse_control_frame(frame)
        with self.assertRaises(ControlProtocolError): parse_control_frame(b'{"x":"' + b'a' * MAX_FRAME_BYTES + b'"}\n')

    def test_numbers_are_exact_safe_integers_and_booleans_are_not_ids(self):
        for token in (b'9007199254740992', b'9007199254740991.00000000000000001', b'1.1', b'1e999'):
            with self.subTest(token=token), self.assertRaises(ControlProtocolError): parse_control_frame(b'{"v":' + token + b'}\n')
        request = {"v":1,"kind":"request","id":True,"op":"hello","args":{"controlVersions":[1],"requiredCapabilities":[]}}
        with self.assertRaises(ControlProtocolError): validate_request(request)
        request["id"] = 1; request["args"]["controlVersions"] = [True]
        with self.assertRaises(ControlProtocolError): validate_request(request)
        for op,caps in (({},[]),([],[]),("hello",[{}]),("hello",[[]])):
            request={"v":1,"kind":"request","id":1,"op":op,"args":{"controlVersions":[1],"requiredCapabilities":caps}}
            with self.assertRaises(ControlProtocolError): validate_request(request)
        with self.assertRaises(ControlProtocolError) as caught: parse_control_frame(b'{"x":"\\ud800"}\n')
        self.assertTrue(caught.exception.fatal)

    def test_result_correlation_and_exact_worker_descriptor(self):
        request = {"v":1,"kind":"request","id":2,"op":"worker.acquire","args":{"sessionId":"1"*32,"authorizationId":"2"*32}}
        validate_request(request)
        response = {"v":1,"kind":"response","id":2,"ok":True,"result":{"workerId":"3"*32,"endpoint":{"kind":"unix","path":"/tmp/w.sock"},"attachmentToken":"4"*64,"attachmentTimeoutMs":5000,"releaseMode":"control-v1"}}
        validate_result(request,response)
        response["result"]["expiresAt"] = 1
        with self.assertRaises(ControlProtocolError): validate_result(request,response)
        response["id"] = 3
        with self.assertRaises(ControlProtocolError): validate_response(response,request)

    def test_encoder_direct_unicode_and_limit(self):
        encoded = encode_control_frame({"value":"汉"})
        self.assertIn("汉".encode(),encoded); self.assertNotIn(b"\\u",encoded)
        with self.assertRaises(ControlProtocolError): encode_control_frame({"value":"x"*MAX_FRAME_BYTES})


if __name__ == "__main__": unittest.main()
