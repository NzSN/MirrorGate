import json
import contextlib
import io
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "supervisor"))

from mirrorgate.recovery import inspect, reclaim
from mirrorgate.cli import main as cli_main
from mirrorgate.recovery_journal import (JournalBusy, JournalError,
    RecoveryJournal, filesystem_identity)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "state"
        self.root.mkdir(mode=0o700)

    def tearDown(self):
        self.temp.cleanup()

    def _claim_directory(self, journal, resource_id, *, session="session-a",
                         kind="filesystem", retained=False):
        journal.claim_intent(session_id=session, resource_id=resource_id,
                             kind=kind, stage="snapshot_freeze",
                             retained_recoverable=retained)
        path = journal.resources_dir / resource_id
        path.mkdir(mode=0o700)
        phase = "retained_by_policy" if kind == "retained_source" else "durable_owned"
        journal.transition(resource_id, phase,
                           identity=filesystem_identity(self.root, path))
        return path

    def test_reclaims_exact_directory_and_retry_is_idempotent(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            owned = self._claim_directory(journal, "resource-a")
        self.assertEqual(inspect(self.root)["counts"]["abandoned"], 1)
        first = reclaim(self.root)
        self.assertEqual(first["counts"]["reclaimed"], 1)
        self.assertFalse(owned.exists())
        second = reclaim(self.root)
        self.assertEqual(second["counts"]["reclaimed"], 1)

    def test_inode_replacement_and_symlink_are_never_removed(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            replaced = self._claim_directory(journal, "replace")
            symlinked = self._claim_directory(journal, "link")
        replaced.rmdir()
        replaced.mkdir(mode=0o700)
        target = Path(self.temp.name) / "foreign"
        target.mkdir()
        symlinked.rmdir()
        symlinked.symlink_to(target, target_is_directory=True)
        result = reclaim(self.root)
        self.assertEqual(result["counts"]["ambiguous"], 2, result)
        self.assertTrue(replaced.is_dir())
        self.assertTrue(target.is_dir())
        self.assertTrue(symlinked.is_symlink())

    def test_reused_inode_fixture_still_requires_ownership_token(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            replaced = self._claim_directory(journal, "reused-inode")
            record_path = journal.journal_dir / "reused-inode.json"
        replaced.rmdir()
        replaced.mkdir(mode=0o700)
        os.setxattr(replaced, "user.mirrorgate.identity", b"f" * 64)
        info = replaced.stat()
        document = json.loads(record_path.read_text())
        document["identity"].update(device=info.st_dev, inode=info.st_ino,
                                    mode=stat.S_IFMT(info.st_mode), ctimeNs=info.st_ctime_ns)
        payload = {key: value for key, value in document.items() if key != "checksum"}
        import hashlib
        document["checksum"] = hashlib.sha256(json.dumps(
            payload, ensure_ascii=True, separators=(",", ":"),
            sort_keys=True).encode("ascii")).hexdigest()
        record_path.write_text(json.dumps(document, separators=(",", ":")) + "\n")
        result = reclaim(self.root)
        self.assertEqual(result["counts"]["ambiguous"], 1)
        self.assertTrue(replaced.exists())

    def test_retained_source_requires_explicit_policy(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            retained = self._claim_directory(journal, "retained", kind="retained_source")
        result = reclaim(self.root)
        self.assertEqual(result["counts"]["retained"], 1)
        self.assertTrue(retained.exists())

    def test_reused_pid_and_stale_boot_observations_never_authorize_signal(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            owned = self._claim_directory(journal, "process-session",
                                          session="session-a")
            journal.claim_intent(session_id="session-a", resource_id="process-a",
                                 kind="process", stage="worker_launch")
            journal.transition("process-a", "durable_owned", identity={
                "pid": os.getpid(), "startTime": "reused-start",
                "bootId": "00000000-0000-0000-0000-000000000000",
                "cgroup": "/same-looking-cgroup"})
        with mock.patch("os.kill") as kill:
            result = reclaim(self.root)
        kill.assert_not_called()
        self.assertEqual(result["counts"]["ambiguous"], 2)
        self.assertTrue(owned.exists())

    def test_live_owner_and_invalid_record_stop_reclamation(self):
        journal = RecoveryJournal(self.root, role="controller")
        try:
            with self.assertRaises(JournalBusy):
                reclaim(self.root)
        finally:
            journal.close()
        (self.root / "journal" / "bad.json").write_bytes(b"bad")
        with self.assertRaisesRegex(JournalError, "manual intervention"):
            reclaim(self.root)
        self.assertFalse((self.root / "journal" / "bad.json").exists())
        self.assertEqual(len(tuple((self.root / "quarantine").iterdir())), 1)
        with self.assertRaisesRegex(JournalError, "manual intervention"):
            reclaim(self.root)

    def test_concurrent_sessions_do_not_broaden_paths(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            first = self._claim_directory(journal, "first", session="session-a")
            second = self._claim_directory(journal, "second", session="session-b")
            foreign = Path(self.temp.name) / "foreign"
            foreign.mkdir()
        result = reclaim(self.root)
        self.assertEqual(result["counts"]["reclaimed"], 2)
        self.assertFalse(first.exists())
        self.assertFalse(second.exists())
        self.assertTrue(foreign.exists())

    def test_protected_nested_claim_blocks_ancestor_even_across_sessions(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            journal.claim_intent(session_id="session-a", resource_id="parent",
                                 kind="filesystem", stage="preparation")
            parent = journal.resources_dir / "parent"
            parent.mkdir(mode=0o700)
            journal.transition("parent", "durable_owned",
                               identity=filesystem_identity(self.root, parent))
            journal.claim_intent(session_id="session-b", resource_id="child",
                                 kind="retained_source", stage="preparation")
            child = parent / "retained-child"
            child.mkdir(mode=0o700)
            journal.transition("child", "retained_by_policy",
                               identity=filesystem_identity(self.root, child))
        result = reclaim(self.root)
        self.assertEqual(result["counts"]["retained"], 1)
        self.assertEqual(result["counts"]["ambiguous"], 1)
        self.assertTrue(parent.exists())
        self.assertTrue(child.exists())

    def test_retry_after_crash_between_quarantine_rename_and_terminal_record(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            owned = self._claim_directory(journal, "interrupted")
        def fault(name):
            if name == "after-rename":
                raise RuntimeError("simulated abrupt recovery death")
        with self.assertRaises(RuntimeError):
            reclaim(self.root, fault=fault)
        self.assertFalse(owned.exists())
        result = reclaim(self.root)
        self.assertEqual(result["counts"]["reclaimed"], 1)
        self.assertFalse((self.root / "quarantine" / "reclaim-interrupted").exists())

    def test_foreign_uid_record_cannot_authorize_removal(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            owned = self._claim_directory(journal, "foreign-owner")
            path = journal.journal_dir / "foreign-owner.json"
            document = json.loads(path.read_text())
            document["principalUid"] += 1
            payload = {key: value for key, value in document.items() if key != "checksum"}
            import hashlib
            document["checksum"] = hashlib.sha256(json.dumps(
                payload, ensure_ascii=True, separators=(",", ":"),
                sort_keys=True).encode("ascii")).hexdigest()
            path.write_text(json.dumps(document, separators=(",", ":")) + "\n")
        result = reclaim(self.root)
        self.assertEqual(result["counts"]["ambiguous"], 1)
        self.assertTrue(owned.exists())

    def test_trusted_cli_inspect_and_explicit_reclaim(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            owned = self._claim_directory(journal, "cli-owned")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(cli_main(["recovery", "inspect", "--state-root",
                                      str(self.root)]), 0)
        inspection = json.loads(output.getvalue())
        self.assertNotIn(str(owned), output.getvalue())
        self.assertEqual(inspection["counts"]["abandoned"], 1)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(cli_main(["recovery", "reclaim", "--state-root",
                                      str(self.root)]), 0)
        self.assertEqual(json.loads(output.getvalue())["counts"]["reclaimed"], 1)

    def test_cli_writes_one_exclusive_owner_only_native_receipt(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            self._claim_directory(journal, "receipt-owned")
        output_dir = Path(self.temp.name) / "private-output"
        output_dir.mkdir(mode=0o700)
        receipt_path = output_dir / "recovery-receipt.json"
        output = io.StringIO()
        arguments = ["recovery", "reclaim", "--state-root", str(self.root),
                     "--receipt", str(receipt_path)]
        with contextlib.redirect_stdout(output):
            self.assertEqual(cli_main(arguments), 0)
        result = json.loads(output.getvalue())
        self.assertEqual(json.loads(receipt_path.read_text()), result["receipt"])
        self.assertEqual(stat.S_IMODE(receipt_path.stat().st_mode), 0o600)
        original = receipt_path.read_bytes()
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli_main(arguments), 125)
        self.assertEqual(receipt_path.read_bytes(), original)
        reclaim_only = [
            ["--cgroup-parent", str(output_dir)],
            ["--run-ref", "run-1"],
            ["--envelope-sha256", "a" * 64],
            ["--original-behavior", "failed"],
            ["--original-cleanup", "unconfirmed"],
            ["--receipt", str(output_dir / "inspect.json")],
        ]
        for extra in reclaim_only:
            with self.subTest(arguments=extra), contextlib.redirect_stderr(
                    io.StringIO()):
                self.assertEqual(cli_main([
                    "recovery", "inspect", "--state-root", str(self.root),
                    *extra]), 125)

    def test_cgroup_cleanup_failure_stays_retryable_and_receipt_is_complete(self):
        from mirrorgate.cgroup import CgroupDelegation as RealDelegation

        parent = Path(self.temp.name) / "delegated"
        parent.mkdir(mode=0o700)
        (parent / "cgroup.controllers").write_text("cpu memory pids\n")
        (parent / "cgroup.subtree_control").write_text("cpu memory pids\n")
        child = parent / "owned-cgroup"
        child.mkdir(mode=0o700)
        for name, value in {
                "pids.max": "8\n", "memory.max": "1048576\n",
                "memory.swap.max": "0\n", "cpu.max": "10000 100000\n",
                "cgroup.kill": "", "pids.current": "0\n",
                "pids.events": "max 0\n", "memory.current": "0\n",
                "memory.events": "oom 0\n", "cpu.stat": "usage_usec 1\n",
                "cgroup.events": "populated 0\n"}.items():
            (child / name).write_text(value)
        info = child.stat()
        with RecoveryJournal(self.root, role="controller") as journal:
            journal.claim_intent(session_id="session-cgroup",
                                 resource_id="cgroup-resource", kind="cgroup",
                                 stage="authorization")
            journal.transition("cgroup-resource", "durable_owned", identity={
                "relativePath": child.name, "device": info.st_dev,
                "inode": info.st_ino, "mode": stat.S_IFMT(info.st_mode)})

        def delegation(path):
            return RealDelegation(path, require_cgroupfs=False)

        with mock.patch("mirrorgate.recovery.CgroupDelegation",
                        side_effect=delegation), mock.patch(
                            "mirrorgate.cgroup.os.rmdir",
                            side_effect=OSError("busy")):
            first = reclaim(self.root, cgroup_parent=parent)
        self.assertEqual(first["results"][0]["disposition"], "failed", first)
        self.assertEqual(first["receipt"]["remainingResources"],
                         ["cgroup-resource"])
        observation = first["receipt"]["cgroupObservations"][0]
        self.assertEqual(observation["resourceId"], "cgroup-resource")
        self.assertEqual(observation["settings"]["pids.max"], "8")
        self.assertIn("cgroup.events", observation["counters"])
        self.assertEqual(inspect(self.root)["claims"][0]["phase"],
                         "cleanup_failed")

        without_delegation = reclaim(self.root)
        self.assertEqual(without_delegation["results"][0]["disposition"],
                         "failed")
        self.assertEqual(inspect(self.root)["claims"][0]["phase"],
                         "cleanup_failed")

        with mock.patch("mirrorgate.recovery.CgroupDelegation",
                        side_effect=delegation), mock.patch(
                            "mirrorgate.cgroup.os.rmdir"):
            final = reclaim(self.root, cgroup_parent=parent)
        self.assertEqual(final["results"][0]["disposition"], "reclaimed")
        self.assertEqual(final["receipt"]["remainingResources"], [])
        self.assertEqual(final["receipt"]["cleanup"]["status"], "confirmed")


if __name__ == "__main__":
    unittest.main()
