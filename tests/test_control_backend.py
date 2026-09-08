import json
import os
from pathlib import Path
import socket
import shutil
import tempfile
import threading
import time
import unittest
from unittest import mock

from mirrorgate.artifacts import FrozenStore
from mirrorgate.control_policy import (PolicyCatalog, example_policy_document,
                                       example_rust_policy_document)
from mirrorgate.preparation import BackendError, BackendOwner, ControlBackend
from mirrorgate.protocol import encode_frame


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_BYTES = (ROOT / "conformance/manifests/counter.json").read_bytes()


def attestation(digest):
    return {
        "registrationId": "registration-1", "request": "verify", "policy": "require",
        "status": "matched", "descriptorSchema": "mirrors.model-interface-descriptor/v1",
        "semanticDigest": digest, "adapterId": "mirrorgate/node-v1",
        "targetProfile": "node-v1",
        "stateComputerContractVersion": "mirrors.state-computer/v1",
    }


class ControlBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.submissions = self.root / "submissions"
        self.submissions.mkdir()
        self.runtime_root = Path(os.environ.get("MIRRORGATE_NODE_RUNTIME_ROOT", "/usr/local"))

    def tearDown(self):
        self.temp.cleanup()

    def document(self, adapter_entry="adapter.mjs"):
        return example_policy_document(submission_root=self.submissions, node_shim_root=ROOT,
                                       node_runtime_root=self.runtime_root,
                                       adapter_entry=adapter_entry)

    def backend(self, adapter_entry="adapter.mjs"):
        return ControlBackend(PolicyCatalog.from_document(self.document(adapter_entry)),
                              attachment_timeout_ms=2000, graceful_stop_ms=300,
                              teardown_timeout_ms=3000)

    def test_catalog_rejects_unknown_fields_looser_limits_and_root_escape(self):
        document = self.document()
        document["extra"] = True
        with self.assertRaisesRegex(ValueError, "fields"):
            PolicyCatalog.from_document(document)
        for bad in (True, 9_007_199_254_740_992):
            document = self.document()
            document["policies"][0]["limits"]["stdoutBytes"] = bad
            with self.subTest(limit=bad), self.assertRaisesRegex(ValueError, "positive bounded integer"):
                PolicyCatalog.from_document(document)
        document = self.document()
        document["policies"][0]["tools"][0]["command"].append("\ud800")
        with self.assertRaisesRegex(ValueError, "Unicode scalars"):
            PolicyCatalog.from_document(document)
        backend = self.backend()
        submission = self.submissions / "submission"
        submission.mkdir()
        (submission / "adapter.mjs").write_text("export function createAdapter(){}")
        owner = BackendOwner("connection", os.getuid(), "1" * 32)
        with self.assertRaisesRegex(BackendError, "no looser"):
            backend.open_session(owner=owner, policy_id="test.node",
                                 submission={"kind": "prebuilt", "input": {"rootId": "submission", "relativePath": "submission"}},
                                 runtime="node-v1", manifest_bytes=MANIFEST_BYTES,
                                 tightened_limits={"stdoutBytes": 2**60})
        foreign = BackendOwner("connection", os.getuid(), "2" * 32)
        with self.assertRaises(BackendError):
            backend.open_session(owner=foreign, policy_id="test.node",
                                 submission={"kind": "prebuilt", "input": {"rootId": "submission", "relativePath": "../private"}},
                                 runtime="node-v1", manifest_bytes=MANIFEST_BYTES)
        backend.close()

    def test_fd_pinned_frozen_lease_is_owner_checked(self):
        source = self.root / "source"
        source.mkdir()
        (source / "worker").write_text("fixed")
        owned = self.root / "owned"
        owned.mkdir()
        store = FrozenStore(owned)
        owner = ("connection", 1)
        lease = store.freeze(owner, source)
        with self.assertRaisesRegex(ValueError, "owner mismatch"):
            lease.duplicate_fd(("connection", 2))
        fd = lease.duplicate_fd(owner)
        os.close(fd)
        lease.close(owner)
        with self.assertRaisesRegex(ValueError, "closed"):
            lease.duplicate_fd(owner)

    def test_blocked_snapshot_does_not_delay_other_owner_release_and_failed_removal_retries(self):
        first = self.root / "first"
        second = self.root / "second"
        first.mkdir(); second.mkdir()
        (first / "a").write_text("a")
        (second / "b").write_text("b")
        owned = self.root / "owned"
        owned.mkdir()
        store = FrozenStore(owned)
        second_lease = store.freeze("owner-2", second)
        import mirrorgate.artifacts as artifacts
        original = artifacts.freeze_path
        entered = threading.Event()
        resume = threading.Event()
        created = []
        def delayed(source, *args, **kwargs):
            if Path(source) == first:
                entered.set(); resume.wait(2)
            return original(source, *args, **kwargs)
        with mock.patch("mirrorgate.artifacts.freeze_path", side_effect=delayed):
            thread = threading.Thread(target=lambda: created.append(store.freeze("owner-1", first)), daemon=True)
            thread.start()
            self.assertTrue(entered.wait(1))
            before = time.monotonic()
            second_lease.close("owner-2")
            self.assertLess(time.monotonic() - before, 0.2, "unrelated cleanup waited for snapshot copying")
            resume.set(); thread.join(2)
        self.assertEqual(len(created), 1)
        lease = created[0]
        snapshot_path = lease._mount_path("owner-1")
        with mock.patch("mirrorgate.artifacts.remove_snapshot", side_effect=OSError("injected removal failure")):
            with self.assertRaisesRegex(ValueError, "removal failed"):
                lease.close("owner-1")
        self.assertEqual(store.pending_removals, (snapshot_path,))
        lease.close("owner-1")
        self.assertEqual(store.pending_removals, ())

    def test_prebuilt_prepare_is_immutable_and_returns_no_snapshot_path(self):
        submission = self.submissions / "node"
        submission.mkdir()
        adapter = submission / "adapter.mjs"
        adapter.write_text("first")
        backend = self.backend()
        owner = BackendOwner("connection", os.getuid(), "1" * 32)
        state = backend.open_session(
            owner=owner, policy_id="test.node",
            submission={"kind": "prebuilt", "input": {"rootId": "submission", "relativePath": "node"}},
            runtime="node-v1", manifest_bytes=MANIFEST_BYTES)
        self.assertEqual(backend.resource_counts(state), {
            "authoringProcesses": 0, "buildProcesses": 0,
            "workers": 0, "snapshots": 2})
        self.assertEqual({entry["path"] for entry in state.node_shim_lease.manifest},
                         {"runtimes", "runtimes/node", "runtimes/node/worker.mjs",
                          "sdk", "sdk/node", "sdk/node/protocol.mjs"})
        self.assertEqual({entry["path"] for entry in state.manifest_lease.manifest}, {"port.json"})
        prepared = backend.prepare(state, cancel_event=threading.Event(), emit_output=lambda *_: None)
        self.assertEqual(backend.resource_counts(state)["snapshots"], 3)
        adapter.write_text("changed")
        frozen = state.artifact_lease._mount_path(owner)
        self.assertEqual((frozen / "adapter.mjs").read_text(), "first")
        self.assertEqual(set(prepared.__dict__), {"artifact_id", "artifact_hash", "source_hash", "runtime_id", "policy_id"})
        self.assertNotIn(str(frozen), repr(prepared))
        self.assertTrue(backend.cleanup_session(state, reason="normal", cancel_event=threading.Event()).complete)
        self.assertEqual(backend.resource_counts(state), {
            "authoringProcesses": 0, "buildProcesses": 0,
            "workers": 0, "snapshots": 0})
        self.assertTrue(backend.close().complete)

    def test_cleanup_does_not_remove_leases_under_an_inflight_freeze(self):
        submission = self.submissions / "node"
        submission.mkdir()
        (submission / "adapter.mjs").write_text("fixed")
        backend = ControlBackend(PolicyCatalog.from_document(self.document()),
                                 teardown_timeout_ms=50)
        owner = BackendOwner("connection", os.getuid(), "1" * 32)
        state = backend.open_session(
            owner=owner, policy_id="test.node",
            submission={"kind": "prebuilt", "input": {"rootId": "submission", "relativePath": "node"}},
            runtime="node-v1", manifest_bytes=MANIFEST_BYTES)
        entered = threading.Event()
        release = threading.Event()
        original_freeze = backend._store.freeze
        def delayed_freeze(actual_owner, source, **kwargs):
            if Path(source) == submission:
                entered.set()
                release.wait(2)
            return original_freeze(actual_owner, source, **kwargs)
        errors = []
        with mock.patch.object(backend._store, "freeze", side_effect=delayed_freeze):
            def capture():
                try:
                    backend.prepare(state, cancel_event=threading.Event(), emit_output=lambda *_: None)
                except BaseException as exc:
                    errors.append(exc)
            thread = threading.Thread(target=capture, daemon=True)
            thread.start()
            self.assertTrue(entered.wait(1))
            first = backend.cleanup_session(state, reason="client-failure", cancel_event=threading.Event())
            self.assertFalse(first.complete)
            self.assertIn("preparation", first.remaining_resources)
            release.set()
            thread.join(2)
        self.assertTrue(errors)
        deadline = time.monotonic() + 2
        while not state.closed and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(state.closed, "late preparation cleanup did not reclaim its registered resources")
        self.assertEqual(backend._store._leases, {})
        backend.close()


class RealControlBackendTests(ControlBackendTests):
    def setUp(self):
        super().setUp()
        if not os.environ.get("MIRRORGATE_NODE_RUNTIME_ROOT"):
            self.skipTest("pinned MIRRORGATE_NODE_RUNTIME_ROOT is required for real control backend tests")

    def _opened(self, *, source=False, authoring=False):
        submission = self.submissions / "node"
        submission.mkdir()
        (submission / "adapter.mjs").write_bytes((ROOT / "runtimes/node/examples/counter.mjs").read_bytes())
        backend = self.backend()
        owner = BackendOwner("connection", os.getuid(), "1" * 32)
        selected = ({"kind": "source", "input": {"rootId": "submission", "relativePath": "node"},
                     "buildPlanId": "copy", "authoring": authoring}
                    if source else
                    {"kind": "prebuilt", "input": {"rootId": "submission", "relativePath": "node"}})
        state = backend.open_session(owner=owner, policy_id="test.node", submission=selected,
                                     runtime="node-v1", manifest_bytes=MANIFEST_BYTES)
        return backend, owner, state, submission

    @staticmethod
    def _readline(stream):
        line = stream.readline()
        if not line:
            raise AssertionError("managed worker channel closed unexpectedly")
        return json.loads(line)

    def _reserve(self):
        backend, owner, state, submission = self._opened()
        prepared = backend.prepare(state, cancel_event=threading.Event(), emit_output=lambda *_: None)
        admission = backend.authorize_admission(state, prepared_revision=1, challenge="a" * 32,
                                                attestation=attestation(state.semantic_digest))
        events = []
        launches = []
        def guard(actual_owner, worker_id, actual_admission):
            self.assertEqual(actual_owner, owner)
            self.assertIs(actual_admission, admission)
            launches.append(worker_id)
            return True
        reservation = backend.reserve_worker(state, authorization=admission, worker_id="2" * 32,
                                             owner=owner, launch_guard=guard,
                                             on_worker_event=lambda name, data: events.append((name, data)))
        return backend, owner, state, prepared, reservation, events, launches

    def test_source_build_quiesces_authoring_and_normal_nonzero_is_reusable(self):
        backend, owner, state, submission = self._opened(source=True, authoring=True)
        first = backend.authoring_exec(state, tool_id="python", arguments=["-c", "raise SystemExit(7)"], cwd=".",
                                       cancel_event=threading.Event(), emit_output=lambda *_: None)
        self.assertEqual(first.returncode, 7)
        second = backend.authoring_exec(state, tool_id="python", arguments=["-c", "open('authored','w').write('fixed')"], cwd=".",
                                        cancel_event=threading.Event(), emit_output=lambda *_: None)
        self.assertEqual(second.returncode, 0)
        prepared = backend.prepare(state, cancel_event=threading.Event(), emit_output=lambda *_: None)
        (submission / "authored").write_text("later edit")
        frozen = state.artifact_lease._mount_path(owner)
        self.assertEqual((frozen / "authored").read_text(), "fixed")
        self.assertIsNotNone(prepared.source_hash)
        with self.assertRaisesRegex(BackendError, "after preparation"):
            backend.authoring_exec(state, tool_id="python", arguments=["-c", "pass"], cwd=".",
                                   cancel_event=threading.Event(), emit_output=lambda *_: None)
        backend.cleanup_session(state, reason="normal", cancel_event=threading.Event())
        backend.close()

    def test_forged_attachment_does_not_consume_reservation_then_real_worker_ready(self):
        backend, owner, state, _prepared, reservation, events, launches = self._reserve()
        self.assertEqual(launches, [])
        with socket.socket(socket.AF_UNIX) as forged:
            forged.connect(reservation.endpoint_path)
            forged.sendall(json.dumps({"v": 1, "kind": "attach", "sessionId": owner.session_id,
                                       "workerId": reservation.worker_id, "attachmentToken": "0" * 64},
                                      separators=(",", ":")).encode() + b"\n")
            self.assertEqual(forged.recv(1), b"")
        with socket.socket(socket.AF_UNIX) as malformed:
            malformed.connect(reservation.endpoint_path)
            malformed.sendall((json.dumps({"v": 1, "kind": "attach", "sessionId": owner.session_id,
                                           "workerId": reservation.worker_id,
                                           "attachmentToken": "\ud800"}) + "\n").encode())
            self.assertEqual(malformed.recv(1), b"")
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(5)
            client.connect(reservation.endpoint_path)
            client.sendall(json.dumps({"v": 1, "kind": "attach", "sessionId": owner.session_id,
                                       "workerId": reservation.worker_id,
                                       "attachmentToken": reservation.attachment_token},
                                      separators=(",", ":")).encode() + b"\n")
            stream = client.makefile("rwb", buffering=0)
            self.assertEqual(self._readline(stream)["kind"], "attached")
            stream.write(encode_frame({"v": 1, "id": 1, "op": "hello",
                                       "interfaceDigest": state.semantic_digest, "runtime": "node-v1"}))
            self.assertTrue(self._readline(stream)["ok"])
            stream.write(encode_frame({"v": 1, "id": 2, "op": "create"}))
            self.assertTrue(self._readline(stream)["ok"])
            deadline = time.monotonic() + 2
            while not any(name == "worker.ready" for name, _ in events) and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(launches, [reservation.worker_id])
            self.assertTrue(any(name == "worker.ready" for name, _ in events))
            mode = backend.arm_worker_release(state, worker_id=reservation.worker_id, reason="normal")
            self.assertEqual(mode, "dispose-then-terminate")
            stream.write(encode_frame({"v": 1, "id": 3, "op": "dispose"}))
            self.assertTrue(self._readline(stream)["ok"])
            released = backend.finish_worker_release(state, worker_id=reservation.worker_id,
                                                      reason="normal", cancel_event=threading.Event())
            self.assertTrue(released.complete, released.failures)
        self.assertTrue(backend.cleanup_session(state, reason="normal", cancel_event=threading.Event()).complete)
        self.assertTrue(backend.close().complete)

    def test_closing_rejects_new_ordinary_worker_work(self):
        backend, owner, state, _prepared, reservation, _events, _launches = self._reserve()
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(5)
            client.connect(reservation.endpoint_path)
            client.sendall(json.dumps({"v": 1, "kind": "attach", "sessionId": owner.session_id,
                                       "workerId": reservation.worker_id,
                                       "attachmentToken": reservation.attachment_token},
                                      separators=(",", ":")).encode() + b"\n")
            stream = client.makefile("rwb", buffering=0)
            self._readline(stream)
            stream.write(encode_frame({"v": 1, "id": 1, "op": "hello",
                                       "interfaceDigest": state.semantic_digest, "runtime": "node-v1"}))
            self._readline(stream)
            stream.write(encode_frame({"v": 1, "id": 2, "op": "create"}))
            self._readline(stream)
            self.assertEqual(backend.arm_worker_release(state, worker_id=reservation.worker_id,
                                                        reason="normal"), "dispose-then-terminate")
            stream.write(encode_frame({"v": 1, "id": 3, "op": "invoke", "action": "Initialize", "inputs": {}}))
            self.assertEqual(stream.readline(), b"")
        released = backend.finish_worker_release(state, worker_id=reservation.worker_id,
                                                  reason="normal", cancel_event=threading.Event())
        self.assertTrue(released.complete, released.failures)
        backend.cleanup_session(state, reason="normal", cancel_event=threading.Event())
        backend.close()

    def test_attachment_expiry_launches_no_submitted_code(self):
        submission = self.submissions / "node"
        submission.mkdir()
        (submission / "adapter.mjs").write_bytes((ROOT / "runtimes/node/examples/counter.mjs").read_bytes())
        backend = ControlBackend(PolicyCatalog.from_document(self.document()),
                                 attachment_timeout_ms=80, graceful_stop_ms=50,
                                 teardown_timeout_ms=1000)
        owner = BackendOwner("connection", os.getuid(), "1" * 32)
        state = backend.open_session(owner=owner, policy_id="test.node",
                                     submission={"kind": "prebuilt", "input": {"rootId": "submission", "relativePath": "node"}},
                                     runtime="node-v1", manifest_bytes=MANIFEST_BYTES)
        backend.prepare(state, cancel_event=threading.Event(), emit_output=lambda *_: None)
        admission = backend.authorize_admission(state, prepared_revision=1, challenge="a" * 32,
                                                attestation=attestation(state.semantic_digest))
        launches = []
        exited = threading.Event()
        reservation = backend.reserve_worker(
            state, authorization=admission, worker_id="2" * 32, owner=owner,
            launch_guard=lambda *_: launches.append(True) or True,
            on_worker_event=lambda name, _data: exited.set() if name == "worker.exited" else None)
        self.assertTrue(exited.wait(2), "attachment expiry did not become terminal")
        self.assertEqual(launches, [])
        self.assertEqual(reservation.attachment_timeout_ms, 0)
        self.assertEqual(backend.arm_worker_release(state, worker_id=reservation.worker_id,
                                                   reason="deadline"), "terminate-only")
        self.assertTrue(backend.finish_worker_release(state, worker_id=reservation.worker_id,
                                                      reason="deadline", cancel_event=threading.Event()).complete)
        backend.cleanup_session(state, reason="deadline", cancel_event=threading.Event())
        backend.close()

    def test_real_rust_binary_is_confined_before_worker_handshake(self):
        built = ROOT / "runtimes/rust/target/debug/mirrorgate-counter-worker"
        if not built.is_file():
            self.skipTest("pinned Rust worker has not been built")
        submission = self.submissions / "rust"
        submission.mkdir()
        shutil.copy2(built, submission / "worker")
        (submission / "worker").chmod(0o700)
        catalog = PolicyCatalog.from_document(example_rust_policy_document(submission_root=self.submissions))
        backend = ControlBackend(catalog, attachment_timeout_ms=2000,
                                 graceful_stop_ms=300, teardown_timeout_ms=3000)
        owner = BackendOwner("connection", os.getuid(), "3" * 32)
        state = backend.open_session(owner=owner, policy_id="test.rust",
                                     submission={"kind": "prebuilt", "input": {"rootId": "submission", "relativePath": "rust"}},
                                     runtime="rust-v1", manifest_bytes=MANIFEST_BYTES)
        backend.prepare(state, cancel_event=threading.Event(), emit_output=lambda *_: None)
        rust_attestation = attestation(state.semantic_digest)
        rust_attestation.update({"adapterId": "mirrorgate/rust-v1", "targetProfile": "rust-v1"})
        admission = backend.authorize_admission(state, prepared_revision=1, challenge="a" * 32,
                                                attestation=rust_attestation)
        launches = []
        reservation = backend.reserve_worker(state, authorization=admission, worker_id="4" * 32,
                                             owner=owner,
                                             launch_guard=lambda *_: launches.append(True) or True,
                                             on_worker_event=lambda *_: None)
        self.assertEqual(launches, [], "native executable started before attachment")
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(5)
            client.connect(reservation.endpoint_path)
            client.sendall(json.dumps({"v": 1, "kind": "attach", "sessionId": owner.session_id,
                                       "workerId": reservation.worker_id,
                                       "attachmentToken": reservation.attachment_token},
                                      separators=(",", ":")).encode() + b"\n")
            stream = client.makefile("rwb", buffering=0)
            self.assertEqual(self._readline(stream)["kind"], "attached")
            self.assertEqual(launches, [True])
            stream.write(encode_frame({"v": 1, "id": 1, "op": "hello",
                                       "interfaceDigest": state.semantic_digest, "runtime": "rust-v1"}))
            self.assertTrue(self._readline(stream)["ok"])
            stream.write(encode_frame({"v": 1, "id": 2, "op": "create"}))
            self.assertTrue(self._readline(stream)["ok"])
            self.assertEqual(backend.arm_worker_release(state, worker_id=reservation.worker_id,
                                                        reason="normal"), "dispose-then-terminate")
            stream.write(encode_frame({"v": 1, "id": 3, "op": "dispose"}))
            self.assertTrue(self._readline(stream)["ok"])
            self.assertTrue(backend.finish_worker_release(state, worker_id=reservation.worker_id,
                                                          reason="normal", cancel_event=threading.Event()).complete)
        backend.cleanup_session(state, reason="normal", cancel_event=threading.Event())
        backend.close()

    def test_release_racing_final_launch_guard_starts_no_process(self):
        backend, owner, state, _submission = self._opened()
        backend.prepare(state, cancel_event=threading.Event(), emit_output=lambda *_: None)
        admission = backend.authorize_admission(state, prepared_revision=1, challenge="a" * 32,
                                                attestation=attestation(state.semantic_digest))
        guard_entered = threading.Event()
        allow_guard = threading.Event()
        events = []
        def guard(*_args):
            guard_entered.set()
            allow_guard.wait(2)
            return True
        reservation = backend.reserve_worker(state, authorization=admission, worker_id="5" * 32,
                                             owner=owner, launch_guard=guard,
                                             on_worker_event=lambda name, data: events.append((name, data)))
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(5)
            client.connect(reservation.endpoint_path)
            client.sendall(json.dumps({"v": 1, "kind": "attach", "sessionId": owner.session_id,
                                       "workerId": reservation.worker_id,
                                       "attachmentToken": reservation.attachment_token},
                                      separators=(",", ":")).encode() + b"\n")
            self.assertTrue(guard_entered.wait(2))
            self.assertEqual(backend.arm_worker_release(state, worker_id=reservation.worker_id,
                                                        reason="user-cancel"), "terminate-only")
            allow_guard.set()
            result = backend.finish_worker_release(state, worker_id=reservation.worker_id,
                                                   reason="user-cancel", cancel_event=threading.Event())
            self.assertTrue(result.complete, result.failures)
            self.assertEqual(client.recv(1), b"")
        self.assertFalse(any(name == "worker.started" for name, _ in events))
        backend.cleanup_session(state, reason="user-cancel", cancel_event=threading.Event())
        backend.close()


if __name__ == "__main__":
    unittest.main()
