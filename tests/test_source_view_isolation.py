"""Real backend tests for filtered source views.

MIRRORGATE_REQUIRE_SANDBOX=1 makes an unavailable backend a failure rather than
a skip, matching the repository isolation gate.
"""
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

from mirrorgate.control_policy import PolicyCatalog, example_policy_document
from mirrorgate.preparation import BackendOwner, ControlBackend
from mirrorgate.sandbox import GateSession
from mirrorgate.policy import AdmissionError, ToolRequest, TrustedConfig
from mirrorgate.source_view import SOURCE_VIEW_SCHEMA


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_BYTES = (ROOT / "conformance/manifests/counter.json").read_bytes()
PRIVATE_TEXT = "PRIVATE_ORACLE_SENTINEL"


class SourceViewIsolationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
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

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.repo = self.base / "repository"
        for relative in (".mirrors/private", ".mirrors/public", "src", ".git"):
            (self.repo / relative).mkdir(parents=True)
        (self.repo / ".mirrors" / "private" / "RBT.tla").write_text(PRIVATE_TEXT + "\n")
        (self.repo / ".git" / "config").write_text("[core]\n")
        (self.repo / ".mirrors" / "public" / "contract.json").write_text('{"public":true}\n')
        (self.repo / "adapter.mjs").write_text("export function createAdapter(){}\n")
        (self.repo / "src" / "index.ts").write_text("export const x = 1;\n")
        (self.repo / "package.json").write_text('{"name":"demo"}\n')
        self.workspace = self.repo / ".mirrors" / "work"
        self.workspace.mkdir(mode=0o700)
        self.backends = []

    def tearDown(self):
        for backend in self.backends:
            try:
                backend.close()
            except BaseException:
                pass
        self.temp.cleanup()

    def document(self, *, filtered=True):
        document = example_policy_document(submission_root=self.repo, node_shim_root=ROOT)
        document["schema"] = "mirrorgate.control-policy/v2"
        document["agentProfiles"] = []
        document["policies"][0]["agentProfileIds"] = []
        root = {"id": "application-source", "path": str(self.repo), "kinds": ["source"],
                "allowedUids": [os.getuid()]}
        if filtered:
            root["sourceView"] = {"schema": SOURCE_VIEW_SCHEMA,
                                  "workspaceRoot": str(self.workspace),
                                  "includePaths": [".mirrors/public", "adapter.mjs", "package.json", "src"]}
        document["policies"][0]["roots"] = [root]
        return document

    def backend(self, *, filtered=True):
        backend = ControlBackend(PolicyCatalog.from_document(self.document(filtered=filtered)))
        self.backends.append(backend)
        return backend

    def open_session(self, backend, *, authoring):
        owner = BackendOwner("connection", os.getuid(), "1" * 32)
        return backend.open_session(
            owner=owner, policy_id="test.node",
            submission={"kind": "source",
                        "input": {"rootId": "application-source", "relativePath": "."},
                        "buildPlanId": "copy", "authoring": authoring},
            runtime="node-v1", manifest_bytes=MANIFEST_BYTES)

    def author(self, backend, state, program):
        output = []
        outcome = backend.authoring_exec(
            state, tool_id="python", arguments=["-c", program], cwd=".",
            cancel_event=threading.Event(),
            emit_output=lambda stream, chunk: output.append(chunk))
        return outcome, b"".join(output).decode(errors="replace")

    def test_authoring_mount_excludes_repository_and_private_paths(self):
        backend = self.backend()
        state = self.open_session(backend, authoring=True)
        program = f"""
import json, os
result = {{}}
result['cwd'] = os.getcwd()
result['workspace'] = sorted(os.listdir('.'))
result['public_src'] = open('src/index.ts').read().strip()
try:
    open('src/index.ts', 'w').write('export const x = 2;\\n')
    result['write_public'] = True
except OSError:
    result['write_public'] = False
try:
    open('src/authored.txt', 'w').write('authored\\n')
    result['create_new'] = True
except OSError:
    result['create_new'] = False
for label, path in (('private_relative', '.mirrors/private/RBT.tla'),
                    ('repository_absolute', {str(self.repo / '.mirrors' / 'private' / 'RBT.tla')!r}),
                    ('repository_root', {str(self.repo)!r}),
                    ('git_metadata', '.git/config'),
                    ('workspace_parent', '..'),
                    ('host_private', {str(self.base)!r})):
    try:
        if os.path.isdir(path):
            result[label] = sorted(os.listdir(path))
        else:
            result[label] = open(path).read()[:80]
    except OSError as exc:
        result[label] = 'DENIED:' + type(exc).__name__
print(json.dumps(result))
"""
        outcome, output = self.author(backend, state, program)
        self.assertEqual((outcome.returncode, outcome.reason), (0, "exited"), output)
        result = json.loads(output.strip().splitlines()[-1])
        self.assertEqual(result["workspace"], [".mirrors", "adapter.mjs", "package.json", "src"])
        self.assertEqual(result["public_src"], "export const x = 1;")
        self.assertTrue(result["write_public"])
        self.assertTrue(result["create_new"])
        for label in ("private_relative", "repository_absolute", "repository_root",
                      "git_metadata", "host_private"):
            self.assertTrue(str(result[label]).startswith("DENIED:"), (label, result[label]))
        self.assertNotIn(PRIVATE_TEXT, output)
        self.assertTrue((state.input_path / "src" / "authored.txt").exists())
        self.assertTrue((state.input_path / "src" / "index.ts").read_text().startswith("export const x = 2;"))
        self.assertEqual((self.repo / "src" / "index.ts").read_text(), "export const x = 1;\n")
        self.assertFalse((self.repo / "src" / "authored.txt").exists())
        view = state.source_view_path
        self.assertTrue(backend.cleanup_session(
            state, reason="normal", cancel_event=threading.Event()).complete)
        self.assertFalse(view.exists(), "unsubmitted authoring view was retained")

    def test_submission_and_preparation_report_one_filtered_source_hash(self):
        backend = self.backend()
        state = self.open_session(backend, authoring=True)
        outcome, output = self.author(backend, state,
                                      "open('src/authored.txt','w').write('authored\\n')\n")
        self.assertEqual((outcome.returncode, outcome.reason), (0, "exited"), output)
        submission = backend.submit_source(state, cancel_event=threading.Event())
        prepared = backend.prepare(state, cancel_event=threading.Event(), emit_output=lambda *_: None)
        self.assertEqual(prepared.source_hash, submission["sourceHash"])
        self.assertEqual(state.source_view_receipt.source_hash, submission["sourceHash"])
        self.assertNotEqual(submission["sourceHash"], state.source_lease.digest)
        self.assertNotEqual(state.source_view_receipt.source_snapshot_sha256,
                            state.source_view.selected_manifest_sha256)
        artifact = state.artifact_lease._mount_path(state.owner)
        self.assertEqual((artifact / "src" / "authored.txt").read_text(), "authored\n")
        self.assertFalse((artifact / ".mirrors" / "private").exists())
        self.assertFalse((artifact / ".git").exists())
        view = state.source_view_path
        self.assertTrue(backend.cleanup_session(state, reason="normal",
                                                cancel_event=threading.Event()).complete)
        self.assertTrue(state.source_view_retained)
        self.assertTrue(view.exists(), "committed authored view was not retained")
        self.assertEqual((view / "src" / "authored.txt").read_text(), "authored\n")

    def test_no_author_filtered_view_is_removed_after_preparation(self):
        backend = self.backend()
        state = self.open_session(backend, authoring=False)
        view = state.source_view_path
        prepared = backend.prepare(state, cancel_event=threading.Event(),
                                   emit_output=lambda *_: None)
        self.assertEqual(prepared.source_hash, state.source_view_receipt.source_hash)
        self.assertTrue(view.exists())
        self.assertTrue(backend.cleanup_session(state, reason="normal",
                                                cancel_event=threading.Event()).complete)
        self.assertFalse(state.source_view_retained)
        self.assertFalse(view.exists(), "no-author view was retained")

    def test_unfiltered_source_hash_and_mount_are_unchanged(self):
        backend = self.backend(filtered=False)
        state = self.open_session(backend, authoring=False)
        self.assertEqual(state.input_path, self.repo)
        self.assertIsNone(state.source_view)
        prepared = backend.prepare(state, cancel_event=threading.Event(), emit_output=lambda *_: None)
        self.assertEqual(prepared.source_hash, state.source_lease.digest)
        self.assertIsNone(state.source_view_receipt)
        artifact = state.artifact_lease._mount_path(state.owner)
        self.assertTrue((artifact / ".mirrors" / "private" / "RBT.tla").exists())
        self.assertTrue(backend.cleanup_session(state, reason="normal",
                                                cancel_event=threading.Event()).complete)


if __name__ == "__main__":
    unittest.main()
