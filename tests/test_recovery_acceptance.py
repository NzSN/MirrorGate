import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "supervisor"))

from mirrorgate.recovery import reclaim
from mirrorgate.control_policy import PolicyCatalog, example_policy_document
from mirrorgate.preparation import BackendOwner, ControlBackend
from mirrorgate.recovery_journal import inspect_records
from mirrorgate.policy import ToolRequest, TrustedConfig
from mirrorgate.sandbox import GateSession
import threading

MANIFEST_BYTES = (ROOT / "conformance/manifests/counter.json").read_bytes()


class RecoveryAcceptanceTests(unittest.TestCase):
    def test_abrupt_controller_exit_leaves_only_exact_owned_tree_for_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "state"
            root.mkdir(mode=0o700)
            foreign = Path(tmp) / "foreign"
            foreign.mkdir()
            script = r'''
import os
from pathlib import Path
from mirrorgate.recovery_journal import RecoveryJournal, filesystem_identity
root = Path(os.environ["RECOVERY_ROOT"])
journal = RecoveryJournal(root, role="controller")
journal.claim_intent(session_id="abrupt-session", resource_id="abrupt-resource",
                     kind="filesystem", stage="replay")
owned = journal.resources_dir / "abrupt-resource"
owned.mkdir(mode=0o700)
(owned / "survivor").write_text("owned")
journal.transition("abrupt-resource", "durable_owned",
                   identity=filesystem_identity(root, owned))
os._exit(73)
'''
            environment = dict(os.environ, PYTHONPATH=str(ROOT / "supervisor"),
                               RECOVERY_ROOT=str(root))
            process = subprocess.run([sys.executable, "-c", script], env=environment,
                                     check=False, timeout=10)
            self.assertEqual(process.returncode, 73)
            owned = root / "resources" / "abrupt-resource"
            self.assertTrue(owned.exists())
            result = reclaim(root)
            self.assertEqual(result["counts"]["reclaimed"], 1)
            self.assertFalse(owned.exists())
            self.assertTrue(foreign.exists())

    def test_abrupt_real_backend_session_is_reclaimed_from_durable_hooks(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "state"
            root.mkdir(mode=0o700)
            submissions = base / "submissions"
            submission = submissions / "app"
            submission.mkdir(parents=True)
            (submission / "adapter.mjs").write_text("export function createAdapter(){}")
            policy = base / "policy.json"
            policy.write_text(json.dumps(example_policy_document(
                submission_root=submissions, node_shim_root=ROOT,
                node_runtime_root=Path("/usr/local")), separators=(",", ":")))
            manifest = base / "manifest.json"
            manifest.write_bytes(MANIFEST_BYTES)
            script = r'''
import os
from pathlib import Path
from mirrorgate.preparation import BackendOwner, ControlBackend
backend = ControlBackend(os.environ["POLICY"], state_root=os.environ["RECOVERY_ROOT"])
backend.open_session(owner=BackendOwner("connection", os.getuid(), "a" * 32),
    policy_id="test.node", submission={"kind":"prebuilt","input":{
      "rootId":"submission","relativePath":"app"}}, runtime="node-v1",
    manifest_bytes=Path(os.environ["MANIFEST"]).read_bytes())
os._exit(74)
'''
            environment = dict(os.environ, PYTHONPATH=str(ROOT / "supervisor"),
                               RECOVERY_ROOT=str(root), POLICY=str(policy),
                               MANIFEST=str(manifest))
            process = subprocess.run([sys.executable, "-c", script], env=environment,
                                     check=False, timeout=15)
            self.assertEqual(process.returncode, 74)
            result = reclaim(root)
            self.assertGreaterEqual(result["counts"]["reclaimed"], 3, result)
            self.assertEqual(result["counts"]["ambiguous"], 0, result)
            self.assertEqual(tuple((root / "resources").iterdir()), ())

    @unittest.skipUnless(os.environ.get("MIRRORGATE_REQUIRE_SANDBOX") == "1",
                         "real Bubblewrap evidence not required")
    def test_normal_real_process_launch_has_durable_intent_and_terminal_observation(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "state"
            root.mkdir(mode=0o700)
            submissions = base / "submissions"
            source = submissions / "source"
            source.mkdir(parents=True)
            (source / "adapter.mjs").write_text("export function createAdapter(){}")
            backend = ControlBackend(PolicyCatalog.from_document(example_policy_document(
                submission_root=submissions, node_shim_root=ROOT,
                node_runtime_root=Path("/usr/local"))), state_root=root)
            try:
                owner = BackendOwner("connection", os.getuid(), "b" * 32)
                state = backend.open_session(owner=owner, policy_id="test.node",
                    submission={"kind":"source","input":{"rootId":"submission",
                    "relativePath":"source"},"buildPlanId":"copy","authoring":True},
                    runtime="node-v1", manifest_bytes=MANIFEST_BYTES)
                outcome = backend.authoring_exec(
                    state, tool_id="python", arguments=["-c", "pass"], cwd=".",
                    cancel_event=threading.Event(), emit_output=lambda *_: None)
                self.assertEqual(outcome.returncode, 0)
                processes = [record for record in inspect_records(root).records
                             if record["kind"] == "process"]
                self.assertEqual(len(processes), 1)
                self.assertEqual(processes[0]["phase"], "reclaimed")
                self.assertTrue(processes[0]["identity"]["startTime"])
            finally:
                backend.close()

    @unittest.skipUnless(os.environ.get("MIRRORGATE_REQUIRE_SANDBOX") == "1",
                         "real Bubblewrap evidence not required")
    def test_launch_barrier_prevents_submitted_code_before_identity_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            sentinel = workspace / "started"
            imported = workspace / "imported"
            hostile = workspace / "mirrorgate"
            hostile.mkdir()
            (hostile / "__init__.py").write_text(
                f"open({str(imported)!r},'w').write('cwd import')")
            (workspace / "sitecustomize.py").write_text(
                f"open({str(imported)!r},'w').write('sitecustomize')")
            events = []
            def intent():
                events.append("intent")
            def reject(_process):
                events.append("commit")
                raise RuntimeError("injected identity commit failure")
            def failed():
                events.append("failed")
            gate = GateSession(TrustedConfig("authoring", workspace),
                               _process_intent=intent, _process_started=reject,
                               _process_failed=failed)
            try:
                original_cwd = os.getcwd()
                os.chdir(workspace)
                try:
                    with self.assertRaisesRegex(RuntimeError, "identity commit failure"):
                        gate.start(ToolRequest(("/usr/bin/python3", "-c",
                            "open('/workspace/started','w').write('ran')")))
                finally:
                    os.chdir(original_cwd)
            finally:
                gate.close()
            self.assertEqual(events, ["intent", "commit", "failed"])
            self.assertFalse(sentinel.exists())
            self.assertFalse(imported.exists())

    @unittest.skipUnless(os.environ.get("MIRRORGATE_REQUIRE_SANDBOX") == "1",
                         "real Bubblewrap evidence not required")
    def test_real_backend_namespace_is_available_for_recovery_profile(self):
        command = ["bwrap", "--unshare-user", "--unshare-pid", "--unshare-ipc",
                   "--unshare-uts", "--unshare-net", "--ro-bind", "/", "/",
                   "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"]
        outcome = subprocess.run(command, check=False, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(outcome.returncode, 0, outcome.stderr.decode(errors="replace"))


if __name__ == "__main__":
    unittest.main()
