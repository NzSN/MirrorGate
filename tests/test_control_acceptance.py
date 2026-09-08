"""Independent acceptance of the public CLI against the actual isolation backend."""

import base64
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from mirrorgate.control_policy import example_policy_document
from mirrorgate.control_protocol import parse_control_frame, validate_event, validate_result


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_JSON = (ROOT / "conformance/manifests/counter.json").read_text()
DIGEST = json.loads(MANIFEST_JSON)["interfaceDigest"]


class ControlWire:
    """Small test driver; all state transitions belong to the external Gate."""

    def __init__(self, policy, temporary_root, *, inherited_fd=None):
        environment = dict(os.environ, PYTHONPATH=str(ROOT / "supervisor"),
                           TMPDIR=str(temporary_root), MIRRORGATE_TEST_PRIVATE="private-canary")
        self.process = subprocess.Popen(
            [sys.executable, "-m", "mirrorgate.cli", "control", "--stdio",
             "--policy-file", str(policy)], cwd=ROOT, env=environment,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            pass_fds=() if inherited_fd is None else (inherited_fd,), bufsize=0)
        self.messages = queue.Queue()
        self.events = []
        self.next_id = 0

        def read():
            try:
                for line in self.process.stdout:
                    self.messages.put(parse_control_frame(line))
            except BaseException as error:
                self.messages.put(error)
            finally:
                self.messages.put(None)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        try:
            self.request("hello", {"controlVersions": [1], "requiredCapabilities": [
                "control.local-stdio-v1", "backend.linux-bubblewrap-v1"]})
        except BaseException:
            self.shutdown()
            raise

    def receive(self, timeout=8):
        message = self.messages.get(timeout=timeout)
        if isinstance(message, BaseException):
            raise message
        if message is None:
            raise AssertionError("Gate control stream ended unexpectedly")
        if message.get("kind") == "event":
            validate_event(message)
            if message["seq"] != len(self.events) + 1:
                raise AssertionError("control events arrived out of order")
            self.events.append(message)
        return message

    def request(self, operation, arguments, *, error=None):
        self.next_id += 1
        frame = {"v": 1, "kind": "request", "id": self.next_id,
                 "op": operation, "args": arguments}
        self.process.stdin.write(json.dumps(frame, ensure_ascii=False).encode() + b"\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 8
        while True:
            reply = self.receive(max(0.001, deadline - time.monotonic()))
            if reply["kind"] == "event":
                continue
            if reply["id"] != self.next_id:
                raise AssertionError("uncorrelated response")
            validate_result(frame, reply)
            if error is not None:
                if reply.get("ok") or reply["error"]["code"] != error:
                    raise AssertionError(f"expected {error}, received {reply}")
                return reply["error"]
            if not reply.get("ok"):
                raise AssertionError(f"{operation} failed: {reply}")
            return reply["result"]

    def finished(self, session, operation, *, error=None):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            status = self.request("operation.status", {
                "sessionId": session, "operationId": operation["operationId"]})
            if status["status"] != "pending":
                if error is not None:
                    if status["status"] != "failed" or status["error"]["code"] != error:
                        raise AssertionError(f"expected operation failure {error}, received {status}")
                    return status
                if status["status"] != "succeeded":
                    raise AssertionError(f"operation failed: {status}")
                return status["result"]
            time.sleep(0.01)
        raise AssertionError("operation did not complete within acceptance deadline")

    def shutdown(self):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)
            raise AssertionError("owned Gate did not finish cleanup after control EOF")
        finally:
            self.process.stdout.close()
            self.process.stderr.close()


class ControlAcceptanceTests(unittest.TestCase):
    def setUp(self):
        if not os.environ.get("MIRRORGATE_NODE_RUNTIME_ROOT"):
            if os.environ.get("MIRRORGATE_REQUIRE_SANDBOX") == "1":
                self.fail("required control acceptance needs MIRRORGATE_NODE_RUNTIME_ROOT")
            self.skipTest("pinned Node runtime root is required")
        self.temporary = tempfile.TemporaryDirectory(prefix="mg-accept-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.inputs = self.root / "inputs"
        self.inputs.mkdir()
        self.submission = self.inputs / "counter"
        self.submission.mkdir()
        (self.submission / "adapter.mjs").write_bytes(
            (ROOT / "runtimes/node/examples/counter.mjs").read_bytes())
        self.work = self.root / "supervisor-owned"
        self.work.mkdir()
        self.policy = self.root / "policy.json"
        self.document = example_policy_document(
            submission_root=self.inputs, node_shim_root=ROOT,
            node_runtime_root=os.environ["MIRRORGATE_NODE_RUNTIME_ROOT"])

    def start(self, **options):
        self.policy.write_text(json.dumps(self.document))
        wire = ControlWire(self.policy, self.work, **options)
        self.addCleanup(wire.shutdown)
        return wire

    def opened(self, wire, *, source=False, limits=None):
        submission = {"kind": "source" if source else "prebuilt", "input": {
            "rootId": "submission", "relativePath": "counter"}}
        if source:
            submission.update(buildPlanId="copy", authoring=True)
        arguments = {"policyId": "test.node", "submission": submission,
                     "runtime": "node-v1", "manifestJson": MANIFEST_JSON}
        if limits is not None:
            arguments["limits"] = limits
        return wire.request("session.open", arguments)["sessionId"]

    def prepared(self, wire, session):
        return wire.finished(session, wire.request("session.prepare", {"sessionId": session}))

    def authorization_args(self, session, prepared):
        return {"sessionId": session, "preparedRevision": prepared["preparedRevision"],
                "challenge": prepared["challenge"], "attestation": {
                    "registrationId": "01234567-89ab-cdef-0123-456789abcdef",
                    "request": "verify", "policy": "require", "status": "matched",
                    "descriptorSchema": "mirrors.model-interface-descriptor/v1",
                    "semanticDigest": DIGEST, "adapterId": "mirrorgate/node-v1",
                    "targetProfile": "node-v1",
                    "stateComputerContractVersion": "mirrors.state-computer/v1"}}

    def attached(self, wire, session, prepared):
        authorization = wire.request("session.authorize", self.authorization_args(session, prepared))
        descriptor = wire.request("worker.acquire", dict(sessionId=session, **authorization))
        status = wire.request("session.status", {"sessionId": session})
        self.assertEqual(status["phase"], "reserved")
        self.assertFalse(any(item["event"] == "worker.started" for item in wire.events))
        connection = socket.socket(socket.AF_UNIX)
        self.addCleanup(connection.close)
        connection.settimeout(5)
        connection.connect(descriptor["endpoint"]["path"])
        stream = connection.makefile("rwb", buffering=0)
        self.addCleanup(stream.close)
        attach = {"v": 1, "kind": "attach", "sessionId": session,
                  "workerId": descriptor["workerId"], "attachmentToken": descriptor["attachmentToken"]}
        stream.write(json.dumps(attach).encode() + b"\n")
        self.assertEqual(json.loads(stream.readline())["kind"], "attached")
        self.worker_request(stream, 1, "hello", interfaceDigest=DIGEST, runtime="node-v1")
        self.worker_request(stream, 2, "create")
        return descriptor, stream

    def worker_request(self, stream, request_id, op, **arguments):
        stream.write(json.dumps(dict(v=1, id=request_id, op=op, **arguments)).encode() + b"\n")
        response = json.loads(stream.readline())
        self.assertEqual(response["id"], request_id)
        self.assertTrue(response["ok"], response)
        return response["result"]

    def test_source_profiles_deny_private_data_and_inherited_fd_then_freeze_output(self):
        canary = self.root / "private-model.txt"
        canary.write_text("private-model-content")
        fd = os.open(canary, os.O_RDONLY)
        self.addCleanup(os.close, fd)
        # The trusted Gate receives this descriptor. None of its sandbox profiles may inherit it.
        import fcntl
        private_fd = fcntl.fcntl(fd, fcntl.F_DUPFD, 80)
        self.addCleanup(os.close, private_fd)
        denied_paths = [str(canary), str(self.policy), str(ROOT / "docs/architecture.md"),
                        "/runtime/mirrorgate-node-shim/docs/architecture.md"]
        probe = ("import os\n"
                 f"paths={denied_paths!r}\n"
                 "assert all(not os.path.exists(p) for p in paths)\n"
                 "assert 'MIRRORGATE_TEST_PRIVATE' not in os.environ\n"
                 f"try: os.read({private_fd},1)\n"
                 "except OSError: pass\n"
                 "else: raise AssertionError('inherited host descriptor')\n"
                 "print('ACCESS_DENIED',flush=True)\n")
        (self.submission / "build.py").write_text(
            probe + "import shutil\nshutil.copytree('/source','/output',dirs_exist_ok=True)\n")
        self.document["policies"][0]["buildPlans"][0]["command"] = [
            "/usr/bin/python3", "/source/build.py"]
        adapter = ("import {existsSync,readSync} from 'node:fs';\n"
                   f"const paths={json.dumps(denied_paths)};\n"
                   "if(paths.some(existsSync)||process.env.MIRRORGATE_TEST_PRIVATE) throw Error('private access');\n"
                   f"let inherited=false;try{{readSync({private_fd},Buffer.alloc(1),0,1,null);inherited=true;}}catch{{}}\n"
                   "if(inherited) throw Error('host descriptor');\n"
                   "export function createAdapter(){return {actions:{Initialize(){},Tick(){}},"
                   "observe(){return {Count:0n};}};}\n")
        (self.submission / "adapter.mjs").write_text(adapter)
        wire = self.start(inherited_fd=private_fd)
        session = self.opened(wire, source=True)
        authoring = wire.request("authoring.exec", {"sessionId": session, "toolId": "python",
                                  "arguments": ["-c", probe], "cwd": "."})
        self.assertEqual(wire.finished(session, authoring)["exitCode"], 0)
        prepared = self.prepared(wire, session)
        self.assertIn("sourceHash", prepared)
        (self.submission / "adapter.mjs").write_text("throw Error('live source was mounted');")
        invalid = self.authorization_args(session, prepared)
        invalid["attestation"]["semanticDigest"] = "0" * 64
        wire.request("session.authorize", invalid, error="NEGOTIATION_ATTESTATION_INVALID")
        self.assertEqual(wire.request("session.status", {"sessionId": session})["phase"], "prepared")
        descriptor, stream = self.attached(wire, session, prepared)
        self.worker_request(stream, 3, "invoke", action="Initialize", inputs={})
        self.assertEqual(self.worker_request(stream, 4, "observe"), {"Count": {"#bigint": "0"}})
        release = wire.request("worker.release", {"sessionId": session,
                               "workerId": descriptor["workerId"], "reason": "normal"})
        self.assertEqual(release["cleanupMode"], "dispose-then-terminate")
        self.worker_request(stream, 5, "dispose")
        self.assertEqual(wire.finished(session, release)["phase"], "closed")
        for stage in ("authoring.output", "build.output"):
            output = b"".join(base64.b64decode(item["data"]["bytesBase64"])
                              for item in wire.events if item["event"] == stage)
            self.assertIn(b"ACCESS_DENIED", output)
        stream.close()
        wire.shutdown()
        self.assertEqual(list(self.work.iterdir()), [])

    def test_control_eof_during_submitted_build_reaps_writers_and_snapshots(self):
        (self.submission / "build.py").write_text(
            "import subprocess,sys,time\n"
            "subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True)\n"
            "print('BUILD_RUNNING',flush=True)\n"
            "time.sleep(30)\n")
        self.document["policies"][0]["buildPlans"][0]["command"] = [
            "/usr/bin/python3", "/source/build.py"]
        wire = self.start()
        session = self.opened(wire, source=True)
        wire.request("session.prepare", {"sessionId": session})
        deadline = time.monotonic() + 5
        while not any(event["event"] == "build.output" for event in wire.events):
            wire.receive(max(0.001, deadline - time.monotonic()))
        wire.shutdown()
        self.assertEqual(list(self.work.iterdir()), [], "EOF cleanup leaked preparation resources")

    def test_idle_deadline_closes_session_and_closed_sessions_do_not_exhaust_active_limit(self):
        wire = self.start()
        for _ in range(6):
            session = self.opened(wire)
            result = wire.finished(session, wire.request("session.close", {"sessionId": session}))
            self.assertEqual(result["phase"], "closed")
        session = self.opened(wire, limits={"sessionWallMs": 200})
        deadline = time.monotonic() + 3
        while not any(event["event"] == "session.closed" and event["sessionId"] == session
                      for event in wire.events):
            wire.receive(max(0.001, deadline - time.monotonic()))
        self.assertEqual(wire.request("session.status", {"sessionId": session})["phase"], "closed")

    def test_failed_cooperative_disposal_remains_cleanup_failure_after_process_exit(self):
        (self.submission / "adapter.mjs").write_text(
            "export function createAdapter(){return {actions:{Initialize(){},Tick(){}},"
            "observe(){return {Count:0n};},dispose(){throw Error('disposal failed');}};}\n")
        wire = self.start()
        session = self.opened(wire)
        descriptor, stream = self.attached(wire, session, self.prepared(wire, session))
        release = wire.request("worker.release", {"sessionId": session,
                               "workerId": descriptor["workerId"], "reason": "normal"})
        self.assertEqual(release["cleanupMode"], "dispose-then-terminate")
        stream.write(b'{"v":1,"id":3,"op":"dispose"}\n')
        response = json.loads(stream.readline())
        self.assertFalse(response["ok"])
        wire.finished(session, release, error="CLEANUP_FAILED")
        status = wire.request("session.status", {"sessionId": session})
        self.assertEqual(status["phase"], "cleanupFailed")
        self.assertEqual(status["cleanup"]["status"], "failed")
        self.assertEqual(status["cleanup"]["remainingResources"], [])
        self.assertEqual(status["resources"], {
            "authoringProcesses": 0, "buildProcesses": 0, "workers": 0, "snapshots": 0})
        repeated = wire.request("session.close", {"sessionId": session})
        self.assertEqual(repeated["operationId"], release["operationId"])
        stream.close()
        wire.shutdown()
        self.assertEqual(list(self.work.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
