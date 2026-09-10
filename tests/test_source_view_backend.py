"""Filtered source-view backend lifecycle, identity, receipt, and cleanup tests."""
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest
from unittest import mock

from mirrorgate import AdmissionError, GateSession, ToolRequest, TrustedConfig
from mirrorgate.artifacts import remove_snapshot
from mirrorgate.control_policy import PolicyCatalog, example_policy_document
from mirrorgate import control_protocol_v2 as control_v2
from mirrorgate.orchestration import OrchestrationController
from mirrorgate.preparation import (SOURCE_VIEW_RECEIPT_SCHEMA, BackendError,
                                    BackendOwner, ControlBackend, filtered_source_hash)


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_BYTES = (ROOT / "conformance/manifests/counter.json").read_bytes()
ADAPTER_BYTES = (ROOT / "runtimes/node/examples/counter.mjs").read_bytes()
DEFAULT_INCLUDES = ("package.json", "adapter.mjs", "src", ".mirrors/public")
EXPECTED_PATHS = {".mirrors", ".mirrors/public", ".mirrors/public/contract.json",
                  "adapter.mjs", "package.json", "src", "src/main.mjs"}


def require_real_backend():
    """Skip unless Bubblewrap works; MIRRORGATE_REQUIRE_SANDBOX=1 makes it fatal."""
    with tempfile.TemporaryDirectory() as source:
        try:
            with GateSession(TrustedConfig("execution", source)) as gate:
                result = gate.run(ToolRequest(("/usr/bin/true",)))
            if result.returncode != 0:
                raise AdmissionError(result.stderr.decode(errors="replace"))
        except (AdmissionError, OSError) as exc:
            if os.environ.get("MIRRORGATE_REQUIRE_SANDBOX") == "1":
                raise RuntimeError(f"required sandbox unavailable: {exc}") from exc
            raise unittest.SkipTest(f"real bubblewrap backend unavailable: {exc}")


def runtime_root():
    return os.environ.get("MIRRORGATE_NODE_RUNTIME_ROOT", "/usr/local")


def source_view_document(submission_root, workspace_root, include_paths=DEFAULT_INCLUDES):
    document = example_policy_document(submission_root=submission_root, node_shim_root=ROOT,
                                       node_runtime_root=runtime_root())
    document["schema"] = "mirrorgate.control-policy/v2"
    document["agentProfiles"] = []
    policy = document["policies"][0]
    policy["agentProfileIds"] = []
    policy["roots"][0]["kinds"] = ["source"]
    policy["roots"][0]["sourceView"] = {"schema": "mirrorgate.source-view/v1",
                                        "workspaceRoot": str(workspace_root),
                                        "includePaths": list(include_paths)}
    return document


def unfiltered_document(submission_root):
    return example_policy_document(submission_root=submission_root, node_shim_root=ROOT,
                                   node_runtime_root=runtime_root())


def unfiltered_v2_document(submission_root):
    document = unfiltered_document(submission_root)
    document["schema"] = "mirrorgate.control-policy/v2"
    document["agentProfiles"] = []
    document["policies"][0]["agentProfileIds"] = []
    return document


class StubBuildProcess:
    """Minimal SandboxProcess surface for gate-free prepare coverage."""

    def __init__(self):
        self.returncode = 0
        self.reason = "exited"
        self.started = time.monotonic()

    def read_stdout(self):
        return b""

    def read_stderr(self):
        return b""

    def wait(self, timeout=None):
        return self.returncode

    def cancel(self):
        self.returncode = -9


class StubBuildGate:
    """Copy the frozen source to /output without a real Bubblewrap launch."""

    def __init__(self, source, output):
        self.source = Path(source)
        self.output = Path(output)

    @classmethod
    def from_frozen(cls, *, profile, lease, owner, runtime_mounts=(), limits=None,
                    output=None, readonly_leases=()):
        return cls(lease._mount_path(owner), output)

    def start(self, request):
        shutil.copytree(self.source, self.output, dirs_exist_ok=True)
        return StubBuildProcess()

    def close(self, *, timeout=5.0):
        pass


class StubAuthoringGate:
    """Record the admitted root and emulate one sandboxed writer in the view."""

    roots = []

    def __init__(self, config):
        self.config = config
        StubAuthoringGate.roots.append(Path(config.workspace))

    def start(self, request):
        root = Path(self.config.workspace)
        (root / "src" / "from-tool.txt").write_text("via tool\n")
        return StubBuildProcess()

    def close(self, *, timeout=5.0):
        pass


class SourceViewBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.submissions = self.root / "submissions"
        self.repository = self.submissions / "app"
        (self.repository / "src").mkdir(parents=True)
        (self.repository / "src" / "main.mjs").write_text("export const value = 1;\n")
        (self.repository / "package.json").write_text('{"name":"app"}\n')
        (self.repository / "adapter.mjs").write_bytes(ADAPTER_BYTES)
        (self.repository / ".mirrors" / "private").mkdir(parents=True)
        (self.repository / ".mirrors" / "private" / "RBT.tla").write_text("secret\n")
        (self.repository / ".mirrors" / "public").mkdir(parents=True)
        (self.repository / ".mirrors" / "public" / "contract.json").write_text("{}\n")
        (self.repository / ".git").mkdir()
        (self.repository / ".git" / "config").write_text("[core]\n")
        (self.repository / "notes.txt").write_text("omitted\n")
        self.workspace = self.root / "workspace"
        self.workspace.mkdir(mode=0o700)

    def tearDown(self):
        self.temp.cleanup()

    def document(self, include_paths=DEFAULT_INCLUDES):
        return source_view_document(self.submissions, self.workspace, include_paths)

    def view_path(self, session_id="1" * 32):
        return self.workspace / ("session-" + session_id)

    def backend(self, document=None, *, teardown_timeout_ms=4000):
        return ControlBackend(PolicyCatalog.from_document(document or self.document()),
                              attachment_timeout_ms=2000, graceful_stop_ms=300,
                              teardown_timeout_ms=teardown_timeout_ms)

    @staticmethod
    def owner(session_id="1" * 32):
        return BackendOwner("connection", os.getuid(), session_id)

    @staticmethod
    def source_submission(*, relative="app", authoring=True):
        return {"kind": "source", "input": {"rootId": "submission", "relativePath": relative},
                "buildPlanId": "copy", "authoring": authoring}

    def open(self, backend, *, submission=None, owner=None):
        return backend.open_session(owner=owner or self.owner(), policy_id="test.node",
                                    submission=submission or self.source_submission(),
                                    runtime="node-v1", manifest_bytes=MANIFEST_BYTES)

    def cleanup(self, backend, state, reason="normal", retained=False):
        result = backend.cleanup_session(state, reason=reason, cancel_event=threading.Event())
        self.assertTrue(result.complete, result.failures)
        self.assertFalse(state.owned.exists())
        if state.source_view_path is not None:
            self.assertEqual(state.source_view_retained, retained)
            self.assertEqual(state.source_view_path.exists(), retained)
        self.assertTrue(backend.close().complete)

    def test_open_materializes_only_included_paths_into_private_view(self):
        backend = self.backend()
        state = self.open(backend)
        view = state.input_path
        self.assertNotEqual(view.resolve(), self.repository.resolve())
        self.assertTrue(view.is_dir())
        self.assertEqual((view / "package.json").read_text(), '{"name":"app"}\n')
        self.assertEqual((view / "src" / "main.mjs").read_text(), "export const value = 1;\n")
        self.assertEqual((view / ".mirrors" / "public" / "contract.json").read_text(), "{}\n")
        self.assertFalse((view / ".mirrors" / "private").exists())
        self.assertFalse((view / ".git").exists())
        self.assertFalse((view / "notes.txt").exists())
        for node in [view, *view.rglob("*")]:
            self.assertEqual(node.stat().st_mode & 0o077, 0, f"{node} is reachable by another UID")
        self.assertEqual(view, self.view_path())
        self.assertEqual(state.source_view_path, view)
        binding = state.source_view
        self.assertEqual(binding.source_view_id, "submission")
        self.assertEqual({entry["path"] for entry in binding.selected_manifest}, EXPECTED_PATHS)
        self.assertRegex(binding.selected_manifest_sha256, r"^[0-9a-f]{64}$")
        self.assertRegex(binding.policy.selector_sha256, r"^[0-9a-f]{64}$")
        self.assertIsNone(state.source_view_receipt)
        (view / "src" / "authored.txt").write_text("edited\n")
        self.assertFalse((self.repository / "src" / "authored.txt").exists())
        self.assertEqual((self.repository / "src" / "main.mjs").read_text(),
                         "export const value = 1;\n")
        self.cleanup(backend, state)

    def test_existing_control_request_selects_view_by_root_id(self):
        backend = self.backend()
        events = []
        controller = OrchestrationController(
            backend, connection_id="source-view-control", principal_uid=os.getuid(),
            connection_mode="stdio", emit=events.append)
        hello = {"v": 1, "kind": "request", "id": 1, "op": "hello", "args": {
            "controlVersions": [2],
            "requiredCapabilities": ["submission.source-view-v1"]}}
        response = controller.dispatch(hello)
        controller.after_response()
        control_v2.validate_result(hello, response)
        self.assertEqual(response["result"]["controlVersion"], 2)
        request = {"v": 2, "kind": "request", "id": 2, "op": "session.open",
                   "args": {"policyId": "test.node", "runtime": "node-v1",
                            "manifestJson": MANIFEST_BYTES.decode(),
                            "submission": self.source_submission(authoring=False)}}
        response = controller.dispatch(request)
        controller.after_response()
        control_v2.validate_result(request, response)
        session_id = response["result"]["sessionId"]
        state = controller._sessions[session_id]
        view = state.backend_state.source_view_path
        self.assertEqual(view, self.workspace / ("session-" + session_id))
        self.assertFalse((view / ".mirrors/private").exists())
        controller.close()
        self.assertFalse(view.exists())
        self.assertTrue(backend.close().complete)

    def test_capability_reports_filtered_selection_without_host_paths(self):
        backend = self.backend()
        report = {item["id"]: item for item in backend.capability_reports("stdio")}["submission.source-view-v1"]
        self.assertTrue(report["available"])
        self.assertEqual(report["enforcedScope"], "session")
        self.assertEqual(report["limits"], {})
        self.assertNotIn(str(self.repository), json.dumps(report))
        self.assertNotIn(str(self.workspace), json.dumps(report))
        backend.close()

        other = ControlBackend(PolicyCatalog.from_document(unfiltered_document(self.submissions)),
                               teardown_timeout_ms=4000)
        report = {item["id"]: item for item in other.capability_reports("stdio")}["submission.source-view-v1"]
        self.assertFalse(report["available"])
        self.assertEqual(report["enforcedScope"], "none")
        self.assertTrue(other.close().complete)

    def test_unfiltered_source_hash_remains_the_snapshot_digest(self):
        backend = ControlBackend(PolicyCatalog.from_document(unfiltered_document(self.submissions)),
                                 teardown_timeout_ms=4000)
        state = self.open(backend)
        (state.input_path / "authored.txt").write_text("fixed\n")
        submission = backend.submit_source(state, cancel_event=threading.Event())
        self.assertEqual(submission["sourceHash"], state.source_lease.digest)
        self.assertIsNone(state.source_view)
        self.assertIsNone(state.source_view_receipt)
        self.cleanup(backend, state)

    def test_viewless_v2_root_preserves_unfiltered_behavior_and_hash(self):
        backend = ControlBackend(
            PolicyCatalog.from_document(unfiltered_v2_document(self.submissions)),
            teardown_timeout_ms=4000)
        report = {item["id"]: item for item in
                  backend.capability_reports("stdio")}["submission.source-view-v1"]
        self.assertFalse(report["available"])
        state = self.open(
            backend, submission=self.source_submission(authoring=False))
        self.assertEqual(state.input_path, self.repository)
        self.assertIsNone(state.source_view)
        with mock.patch("mirrorgate.preparation.GateSession", StubBuildGate):
            prepared = backend.prepare(
                state, cancel_event=threading.Event(), emit_output=lambda *_: None)
        self.assertEqual(prepared.source_hash, state.source_lease.digest)
        self.assertIsNone(state.source_view_receipt)
        self.cleanup(backend, state)

    def test_submit_binds_selector_manifest_and_snapshot_into_receipt(self):
        backend = self.backend()
        state = self.open(backend)
        (state.input_path / "src" / "authored.txt").write_text("fixed\n")
        submission = backend.submit_source(state, cancel_event=threading.Event())
        binding = state.source_view
        receipt = state.source_view_receipt
        self.assertEqual(receipt.schema, SOURCE_VIEW_RECEIPT_SCHEMA)
        self.assertEqual(receipt.source_view_id, "submission")
        self.assertEqual(receipt.selector_sha256, binding.policy.selector_sha256)
        self.assertEqual(receipt.selected_manifest_sha256, binding.selected_manifest_sha256)
        self.assertEqual(receipt.source_snapshot_sha256, state.source_lease.digest)
        expected = filtered_source_hash("submission", binding.policy.selector_sha256,
                                        binding.selected_manifest_sha256, state.source_lease.digest)
        self.assertEqual(submission["sourceHash"], expected)
        self.assertEqual(receipt.source_hash, expected)
        self.assertNotEqual(submission["sourceHash"], state.source_lease.digest)
        self.assertEqual(submission["sourceRevision"], 1)
        frozen = state.source_lease._mount_path(state.owner)
        self.assertEqual((frozen / "src" / "authored.txt").read_text(), "fixed\n")
        self.assertEqual((frozen / "src" / "main.mjs").read_text(), "export const value = 1;\n")
        self.assertTrue((frozen / ".mirrors" / "public" / "contract.json").exists())
        self.assertFalse((frozen / ".mirrors" / "private").exists())
        self.assertFalse((frozen / ".git").exists())
        self.assertFalse((frozen / "notes.txt").exists())
        view = state.source_view_path
        self.cleanup(backend, state, retained=True)
        self.assertEqual((view / "src" / "authored.txt").read_text(), "fixed\n")

    def test_filtered_hash_is_domain_separated(self):
        base = filtered_source_hash("submission", "a" * 64, "b" * 64, "c" * 64)
        self.assertRegex(base, r"^[0-9a-f]{64}$")
        self.assertNotEqual(base, "c" * 64)
        for changed in (("other-root", "a" * 64, "b" * 64, "c" * 64),
                        ("submission", "0" * 64, "b" * 64, "c" * 64),
                        ("submission", "a" * 64, "0" * 64, "c" * 64),
                        ("submission", "a" * 64, "b" * 64, "0" * 64)):
            self.assertNotEqual(base, filtered_source_hash(*changed))

    def test_missing_selected_path_publishes_no_session_or_view(self):
        backend = self.backend(self.document(include_paths=("src", "missing.txt")))
        owner = self.owner()
        before = {entry.name for entry in backend._owned.iterdir()}
        with self.assertRaises(BackendError) as caught:
            self.open(backend, owner=owner)
        self.assertEqual((caught.exception.code, caught.exception.stage), ("POLICY_DENIED", "policy"))
        message = str(caught.exception)
        self.assertNotIn(str(self.repository.resolve()), message)
        self.assertNotIn("RBT.tla", message)
        self.assertNotIn("mirrorgate-control-backend", message)
        self.assertNotIn(str(self.workspace), message)
        self.assertNotIn(owner, backend._sessions)
        self.assertEqual(list(self.workspace.iterdir()), [])
        self.assertEqual({entry.name for entry in backend._owned.iterdir()}, before)
        self.assertEqual(backend._store._leases, {})
        self.assertTrue(backend.close().complete)

    def test_materializer_rollback_failure_is_owned_until_backend_close(self):
        backend = self.backend(self.document(include_paths=("src", "missing.txt")))
        owner = self.owner()
        view = self.view_path()
        with mock.patch("mirrorgate.source_view.remove_snapshot",
                        side_effect=OSError("injected materializer rollback failure")):
            with self.assertRaises(BackendError) as caught:
                self.open(backend, owner=owner)
        self.assertEqual((caught.exception.code, caught.exception.stage),
                         ("CLEANUP_FAILED", "cleanup"))
        self.assertNotIn(str(view), str(caught.exception))
        self.assertNotIn(owner, backend._sessions)
        self.assertTrue(view.exists())
        self.assertIn(view, backend._pending_source_views)
        closed = backend.close()
        self.assertTrue(closed.complete, closed.failures)
        self.assertFalse(view.exists())
        self.assertEqual(backend._pending_source_views, set())

    def test_open_rollback_failure_is_reported_and_retried_by_backend_close(self):
        backend = self.backend()
        owner = self.owner()
        view = self.view_path()
        failed = {"once": False}

        def remove(path):
            if Path(path) == view and not failed["once"]:
                failed["once"] = True
                raise OSError("injected source view rollback failure")
            return remove_snapshot(path)

        with mock.patch("mirrorgate.preparation._freeze_manifest",
                        side_effect=OSError("injected post-view failure")), \
             mock.patch("mirrorgate.preparation.remove_snapshot", side_effect=remove):
            with self.assertRaises(BackendError) as caught:
                self.open(backend, owner=owner)
        self.assertEqual((caught.exception.code, caught.exception.stage),
                         ("CLEANUP_FAILED", "cleanup"))
        self.assertNotIn(str(view), str(caught.exception))
        self.assertNotIn(owner, backend._sessions)
        self.assertTrue(view.exists())
        self.assertIn(view, backend._pending_source_views)
        closed = backend.close()
        self.assertTrue(closed.complete, closed.failures)
        self.assertFalse(view.exists())
        self.assertEqual(backend._pending_source_views, set())

    def test_linked_selected_component_publishes_no_session(self):
        (self.repository / "src" / "link").symlink_to(self.repository / ".mirrors" / "private")
        backend = self.backend()
        owner = self.owner()
        with self.assertRaises(BackendError) as caught:
            self.open(backend, owner=owner)
        self.assertEqual((caught.exception.code, caught.exception.stage), ("POLICY_DENIED", "policy"))
        self.assertNotIn("private", str(caught.exception))
        self.assertNotIn(owner, backend._sessions)
        self.assertEqual(list(self.workspace.iterdir()), [])
        self.assertEqual(backend._store._leases, {})
        self.assertTrue(backend.close().complete)

    def test_view_removal_failure_is_a_source_view_failure(self):
        backend = self.backend()
        state = self.open(backend)

        def fail_view(path):
            if Path(path) == state.source_view_path:
                raise OSError("injected removal failure")
            return remove_snapshot(path)

        with mock.patch("mirrorgate.preparation.remove_snapshot", side_effect=fail_view):
            first = backend.cleanup_session(state, reason="client-failure", cancel_event=threading.Event())
        self.assertFalse(first.complete)
        self.assertIn("source-view", first.remaining_resources)
        self.assertTrue(state.source_view_path.exists())
        self.assertFalse(state.owned.exists())
        second = backend.cleanup_session(state, reason="client-failure", cancel_event=threading.Event())
        self.assertTrue(second.complete, second.failures)
        self.assertFalse(state.source_view_path.exists())
        self.assertTrue(backend.close().complete)

    def test_backend_close_reconciles_a_transient_view_removal_failure(self):
        backend = self.backend()
        state = self.open(backend)
        view = state.source_view_path
        failed = {"once": False}

        def remove(path):
            if Path(path) == view and not failed["once"]:
                failed["once"] = True
                raise OSError("injected one-shot removal failure")
            return remove_snapshot(path)

        with mock.patch("mirrorgate.preparation.remove_snapshot", side_effect=remove):
            result = backend.close()
        self.assertTrue(failed["once"])
        self.assertTrue(result.complete, result.failures)
        self.assertEqual(result.remaining_resources, ())
        self.assertFalse(view.exists())

    def test_backend_close_reconciles_view_with_another_remaining_resource(self):
        backend = self.backend()
        state = self.open(backend)
        view = state.source_view_path
        view_failed = {"once": False}

        def remove(path):
            if Path(path) == view and not view_failed["once"]:
                view_failed["once"] = True
                raise OSError("injected one-shot view failure")
            if Path(path) == state.owned:
                raise OSError("injected persistent session-directory failure")
            return remove_snapshot(path)

        with mock.patch("mirrorgate.preparation.remove_snapshot", side_effect=remove):
            result = backend.close()
        self.assertFalse(result.complete)
        self.assertEqual(result.remaining_resources, ("session-directory",))
        self.assertNotIn("source-view", result.remaining_resources)
        self.assertFalse(view.exists())
        self.assertEqual(backend._pending_source_views, set())
        recovered = backend.close()
        self.assertTrue(recovered.complete, recovered.failures)

    def test_session_directory_removal_failure_is_reported(self):
        backend = self.backend()
        state = self.open(backend)

        def fail_owned(path):
            if Path(path) == state.owned:
                raise OSError("injected removal failure")
            return remove_snapshot(path)

        with mock.patch("mirrorgate.preparation.remove_snapshot", side_effect=fail_owned):
            first = backend.cleanup_session(state, reason="client-failure", cancel_event=threading.Event())
        self.assertFalse(first.complete)
        self.assertIn("session-directory", first.remaining_resources)
        self.assertTrue(state.owned.exists())
        second = backend.cleanup_session(state, reason="client-failure", cancel_event=threading.Event())
        self.assertTrue(second.complete, second.failures)
        self.assertFalse(state.owned.exists())
        self.assertTrue(backend.close().complete)

    def test_failed_submit_removes_the_uncommitted_view(self):
        backend = self.backend()
        state = self.open(backend)
        (state.input_path / "src" / "authored.txt").write_text("doomed\n")
        view = state.source_view_path
        with mock.patch.object(backend._store, "freeze",
                               side_effect=AdmissionError("injected freeze failure")):
            with self.assertRaises(BackendError) as caught:
                backend.submit_source(state, cancel_event=threading.Event())
        self.assertEqual((caught.exception.code, caught.exception.stage),
                         ("PREPARATION_FAILED", "authoring"))
        self.assertIsNone(state.submission)
        self.assertIsNone(state.source_view_receipt)
        self.cleanup(backend, state, retained=False)
        self.assertFalse(view.exists())

    def test_authoring_exec_uses_the_staged_view(self):
        backend = self.backend()
        state = self.open(backend)
        StubAuthoringGate.roots = []
        with mock.patch("mirrorgate.preparation.GateSession", StubAuthoringGate):
            outcome = backend.authoring_exec(
                state, tool_id="python",
                arguments=["-c", "open('src/from-tool.txt','w').write('via tool\\n')"],
                cwd=".", cancel_event=threading.Event(), emit_output=lambda *_: None)
        self.assertEqual(outcome.returncode, 0)
        self.assertEqual(StubAuthoringGate.roots, [state.source_view_path])
        self.assertEqual((state.input_path / "src" / "from-tool.txt").read_text(), "via tool\n")
        self.assertFalse((self.repository / "src" / "from-tool.txt").exists())
        submission = backend.submit_source(state, cancel_event=threading.Event())
        self.assertEqual(submission["sourceHash"], state.source_view_receipt.source_hash)
        self.cleanup(backend, state, retained=True)

    def test_no_author_view_is_removed_after_stubbed_prepare(self):
        backend = self.backend()
        state = self.open(backend, submission=self.source_submission(authoring=False))
        with mock.patch("mirrorgate.preparation.GateSession", StubBuildGate):
            prepared = backend.prepare(state, cancel_event=threading.Event(), emit_output=lambda *_: None)
        self.assertIsNotNone(prepared.source_hash)
        self.assertEqual(state.source_view_receipt.source_hash, prepared.source_hash)
        self.cleanup(backend, state, retained=False)

    def test_workspace_root_inside_the_repository_outside_includes_is_allowed(self):
        workspace = self.repository / ".mirrors" / "work"
        workspace.mkdir(mode=0o700)
        backend = ControlBackend(PolicyCatalog.from_document(
            source_view_document(self.submissions, workspace)), teardown_timeout_ms=4000)
        state = self.open(backend)
        self.assertEqual(state.source_view_path, workspace / ("session-" + "1" * 32))
        self.assertTrue((state.input_path / "src" / "main.mjs").exists())
        self.assertFalse((state.input_path / ".mirrors" / "work").exists())
        self.cleanup(backend, state, retained=False)

    def test_include_that_contains_the_workspace_root_is_denied(self):
        workspace = self.repository / "src" / "work"
        workspace.mkdir(mode=0o700)
        backend = ControlBackend(PolicyCatalog.from_document(
            source_view_document(self.submissions, workspace)), teardown_timeout_ms=4000)
        owner = self.owner()
        with self.assertRaises(BackendError) as caught:
            self.open(backend, owner=owner)
        self.assertEqual((caught.exception.code, caught.exception.stage), ("POLICY_DENIED", "policy"))
        self.assertNotIn(str(workspace), str(caught.exception))
        self.assertNotIn(owner, backend._sessions)
        self.assertEqual(list(workspace.iterdir()), [])
        self.assertTrue(backend.close().complete)

    def test_workspace_collision_preserves_a_preexisting_destination(self):
        backend = self.backend()
        colliding = self.view_path()
        colliding.mkdir(mode=0o700)
        marker = colliding / "marker.txt"
        marker.write_text("preserved\n")
        owner = self.owner()
        with self.assertRaises(BackendError) as caught:
            self.open(backend, owner=owner)
        self.assertEqual((caught.exception.code, caught.exception.stage), ("POLICY_DENIED", "policy"))
        self.assertEqual(marker.read_text(), "preserved\n")
        self.assertNotIn(owner, backend._sessions)
        self.assertTrue(backend.close().complete)

    def test_replaced_workspace_root_denies_open_without_creating_a_view(self):
        backend = self.backend()
        moved = self.root / "workspace-moved"
        os.rename(self.workspace, moved)
        os.symlink(moved, self.workspace)
        owner = self.owner()
        with self.assertRaises(BackendError) as caught:
            self.open(backend, owner=owner)
        self.assertEqual((caught.exception.code, caught.exception.stage), ("POLICY_DENIED", "policy"))
        self.assertEqual(list(moved.iterdir()), [])
        self.assertNotIn(owner, backend._sessions)
        self.assertTrue(backend.close().complete)

    def test_invalid_session_identity_denies_open_without_a_destination(self):
        backend = self.backend()
        owner = BackendOwner("connection", os.getuid(), "../escape")
        with self.assertRaises(BackendError) as caught:
            self.open(backend, owner=owner)
        self.assertEqual((caught.exception.code, caught.exception.stage), ("POLICY_DENIED", "policy"))
        self.assertNotIn(owner, backend._sessions)
        self.assertEqual(list(self.workspace.iterdir()), [])
        self.assertTrue(backend.close().complete)

    def test_cleanup_during_submit_reclaims_the_staged_view(self):
        backend = self.backend(teardown_timeout_ms=1000)
        state = self.open(backend)
        entered, release = threading.Event(), threading.Event()
        original = backend._store.freeze

        def delayed(owner, source, **kwargs):
            if Path(source) == state.input_path:
                entered.set()
                release.wait(5)
            return original(owner, source, **kwargs)

        outcome = []

        def submit():
            try:
                outcome.append(backend.submit_source(state, cancel_event=threading.Event()))
            except BaseException as exc:
                outcome.append(exc)

        with mock.patch.object(backend._store, "freeze", side_effect=delayed):
            thread = threading.Thread(target=submit, daemon=True)
            thread.start()
            self.assertTrue(entered.wait(2))
            first = backend.cleanup_session(state, reason="client-failure", cancel_event=threading.Event())
            self.assertFalse(first.complete)
            self.assertIn("preparation", first.remaining_resources)
            release.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertIsInstance(outcome[0], BackendError)
        self.assertEqual(outcome[0].code, "CANCELLED")
        deadline = time.monotonic() + 3
        while not state.closed and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(state.closed)
        self.assertFalse(state.owned.exists())
        self.assertFalse(state.source_view_path.exists())
        self.assertEqual(backend._store._leases, {})
        self.assertTrue(backend.close().complete)

    def test_submit_then_stubbed_prepare_returns_the_committed_identity(self):
        backend = self.backend()
        state = self.open(backend)
        (state.input_path / "src" / "authored.txt").write_text("fixed\n")
        submitted = backend.submit_source(state, cancel_event=threading.Event())
        with mock.patch("mirrorgate.preparation.GateSession", StubBuildGate):
            prepared = backend.prepare(state, cancel_event=threading.Event(),
                                       emit_output=lambda *_: None)
        self.assertEqual(prepared.source_hash, submitted["sourceHash"])
        self.assertEqual(prepared.source_hash, state.source_view_receipt.source_hash)
        self.assertEqual(prepared.source_hash,
                         filtered_source_hash("submission",
                                              state.source_view.policy.selector_sha256,
                                              state.source_view.selected_manifest_sha256,
                                              state.source_lease.digest))
        artifact = state.artifact_lease._mount_path(state.owner)
        self.assertEqual((artifact / "src" / "authored.txt").read_text(), "fixed\n")
        self.assertTrue((artifact / ".mirrors" / "public" / "contract.json").exists())
        self.assertFalse((artifact / ".mirrors" / "private").exists())
        self.assertFalse((artifact / ".git").exists())
        self.assertFalse((artifact / "notes.txt").exists())
        self.assertFalse((self.repository / "src" / "authored.txt").exists())
        viewed = state.source_view_path
        self.cleanup(backend, state, retained=True)
        self.assertEqual((viewed / "src" / "authored.txt").read_text(), "fixed\n")


class RealSourceViewBackendTests(SourceViewBackendTests):
    @classmethod
    def setUpClass(cls):
        require_real_backend()

    def test_authoring_then_submit_and_prepare_return_matching_effective_hash(self):
        backend = self.backend()
        state = self.open(backend)
        (state.input_path / "src" / "authored.txt").write_text("fixed\n")
        submitted = backend.submit_source(state, cancel_event=threading.Event())
        prepared = backend.prepare(state, cancel_event=threading.Event(), emit_output=lambda *_: None)
        self.assertEqual(prepared.source_hash, submitted["sourceHash"])
        self.assertEqual(prepared.source_hash, state.source_view_receipt.source_hash)
        self.assertEqual(state.source_view_receipt.source_snapshot_sha256, state.source_lease.digest)
        artifact = state.artifact_lease._mount_path(state.owner)
        self.assertEqual((artifact / "src" / "authored.txt").read_text(), "fixed\n")
        self.assertEqual((artifact / "adapter.mjs").read_bytes(), ADAPTER_BYTES)
        self.assertTrue((artifact / ".mirrors" / "public" / "contract.json").exists())
        self.assertFalse((artifact / ".mirrors" / "private").exists())
        self.assertFalse((artifact / ".git").exists())
        self.assertFalse((artifact / "notes.txt").exists())
        self.assertFalse((self.repository / "src" / "authored.txt").exists())
        self.assertEqual(backend.resource_counts(state)["snapshots"], 4)
        self.cleanup(backend, state, retained=True)

    def test_authoring_exec_writes_only_into_the_staged_view(self):
        backend = self.backend()
        state = self.open(backend)
        outcome = backend.authoring_exec(
            state, tool_id="python",
            arguments=["-c", "open('src/from-tool.txt','w').write('via tool\\n')"],
            cwd=".", cancel_event=threading.Event(), emit_output=lambda *_: None)
        self.assertEqual(outcome.returncode, 0)
        self.assertEqual((state.input_path / "src" / "from-tool.txt").read_text(), "via tool\n")
        self.assertFalse((self.repository / "src" / "from-tool.txt").exists())
        submission = backend.submit_source(state, cancel_event=threading.Event())
        self.assertEqual(submission["sourceHash"], state.source_view_receipt.source_hash)
        frozen = state.source_lease._mount_path(state.owner)
        self.assertEqual((frozen / "src" / "from-tool.txt").read_text(), "via tool\n")
        self.cleanup(backend, state, retained=True)

    def test_no_author_prepare_binds_the_staged_view(self):
        backend = self.backend()
        state = self.open(backend, submission=self.source_submission(authoring=False))
        prepared = backend.prepare(state, cancel_event=threading.Event(), emit_output=lambda *_: None)
        binding = state.source_view
        receipt = state.source_view_receipt
        expected = filtered_source_hash("submission", binding.policy.selector_sha256,
                                        binding.selected_manifest_sha256, state.source_lease.digest)
        self.assertEqual(prepared.source_hash, expected)
        self.assertEqual(receipt.source_hash, expected)
        artifact = state.artifact_lease._mount_path(state.owner)
        self.assertEqual((artifact / "src" / "main.mjs").read_text(), "export const value = 1;\n")
        self.assertFalse((artifact / ".mirrors" / "private").exists())
        self.cleanup(backend, state)


if __name__ == "__main__":
    unittest.main()
