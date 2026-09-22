import json
import hashlib
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "supervisor"))

from mirrorgate.recovery_journal import (JournalBusy, JournalError,
    RecoveryJournal, filesystem_identity, inspect_records)


class RecoveryJournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "state"
        self.root.mkdir(mode=0o700)

    def tearDown(self):
        self.temp.cleanup()

    def _owned(self, journal, name="owned"):
        path = journal.resources_dir / name
        path.mkdir(mode=0o700)
        return path

    def test_closed_record_transitions_and_terminal_state(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            journal.claim_intent(session_id="session-a", resource_id="resource-a",
                                 kind="filesystem", stage="preparation")
            owned = self._owned(journal)
            record = journal.transition("resource-a", "durable_owned",
                                        identity=filesystem_identity(self.root, owned))
            self.assertEqual(record["sequence"], 2)
            journal.transition("resource-a", "cleanup_intent")
            journal.transition("resource-a", "reclaimed")
            with self.assertRaisesRegex(JournalError, "invalid journal transition"):
                journal.transition("resource-a", "cleanup_intent")
            with self.assertRaisesRegex(JournalError, "duplicate resource ID"):
                journal.claim_intent(session_id="session-a", resource_id="resource-a",
                                     kind="filesystem", stage="build")

    def test_exclusive_owner_and_root_validation(self):
        first = RecoveryJournal(self.root, role="controller")
        try:
            with self.assertRaises(JournalBusy):
                RecoveryJournal(self.root, role="recoverer", initialize=False)
        finally:
            first.close()
        self.root.chmod(0o755)
        with self.assertRaisesRegex(JournalError, "mode 0700"):
            RecoveryJournal(self.root, role="controller")
        self.root.chmod(0o700)
        with mock.patch("mirrorgate.recovery_journal.os.geteuid",
                        return_value=os.geteuid() + 1):
            with self.assertRaisesRegex(JournalError, "owned by the serving UID"):
                RecoveryJournal(self.root, role="controller")
        alias = Path(self.temp.name) / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(JournalError, "cannot be pinned"):
            RecoveryJournal(alias, role="controller")

    def test_corrupt_future_truncated_and_duplicate_field_records_are_rejected(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            journal.claim_intent(session_id="session-a", resource_id="valid",
                                 kind="filesystem", stage="preparation")
            valid = journal.journal_dir / "valid.json"
            document = json.loads(valid.read_text())
            document["schema"] = "mirrorgate.recovery-journal/v99"
            valid.write_text(json.dumps(document) + "\n")
            (journal.journal_dir / "truncated.json").write_bytes(b'{"schema":')
            (journal.journal_dir / "duplicate.json").write_text(
                '{"schema":"x","schema":"y"}\n')
            snapshot = inspect_records(self.root)
            self.assertEqual(snapshot.records, ())
            self.assertEqual(len(snapshot.invalid), 3)

    def test_checksum_and_filename_identity_are_enforced(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            journal.claim_intent(session_id="session-a", resource_id="resource-a",
                                 kind="filesystem", stage="preparation")
            source = journal.journal_dir / "resource-a.json"
            data = bytearray(source.read_bytes())
            data[data.index(b"preparation")] = ord("x")
            source.write_bytes(data)
            self.assertEqual(len(inspect_records(self.root).invalid), 1)

    def test_every_publication_cut_is_recoverable_as_old_new_or_absent(self):
        cuts = ("before-open", "after-open", "after-write", "after-file-sync",
                "after-rename", "after-directory-sync")
        for cut in cuts:
            with self.subTest(cut=cut):
                other = Path(self.temp.name) / ("state-" + cut)
                other.mkdir(mode=0o700)
                fired = False
                def fault(name):
                    nonlocal fired
                    if name == cut and not fired:
                        fired = True
                        raise RuntimeError(cut)
                with RecoveryJournal(other, role="controller", fault=fault) as journal:
                    with self.assertRaises(RuntimeError):
                        journal.claim_intent(session_id="session-a", resource_id="resource-a",
                                             kind="filesystem", stage="preparation")
                    snapshot = inspect_records(other)
                    self.assertFalse(snapshot.invalid)
                    self.assertLessEqual(len(snapshot.records), 1)

    def test_short_write_and_missing_sync_fail_closed(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            with mock.patch("mirrorgate.recovery_journal.os.write", return_value=0):
                with self.assertRaisesRegex(JournalError, "short journal write"):
                    journal.claim_intent(session_id="session-a", resource_id="short",
                                         kind="filesystem", stage="preparation")
            with mock.patch("mirrorgate.recovery_journal.os.fsync", side_effect=OSError("sync")):
                with self.assertRaises(OSError):
                    journal.claim_intent(session_id="session-a", resource_id="sync",
                                         kind="filesystem", stage="preparation")

    def test_identity_rejects_absolute_parent_and_unknown_fields(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            journal.claim_intent(session_id="session-a", resource_id="resource-a",
                                 kind="filesystem", stage="preparation")
            for identity in (
                {"relativePath": "/tmp/x", "device": 1, "inode": 2,
                 "mode": stat.S_IFDIR},
                {"relativePath": "../x", "device": 1, "inode": 2,
                 "mode": stat.S_IFDIR},
                {"relativePath": "resources/x", "device": 1, "inode": 2,
                 "mode": stat.S_IFDIR, "secret": "x"},
            ):
                with self.subTest(identity=identity), self.assertRaises(JournalError):
                    journal.transition("resource-a", "durable_owned", identity=identity)

    def test_opaque_ids_raw_components_fifo_and_malformed_types_fail_closed(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            for bad in ("../escape", ".hidden", "a/b", "a//b"):
                with self.subTest(resource_id=bad), self.assertRaises(JournalError):
                    journal.claim_intent(session_id="session-a", resource_id=bad,
                                         kind="filesystem", stage="build")
            journal.claim_intent(session_id="session-a", resource_id="typed",
                                 kind="filesystem", stage="build")
            path = journal.journal_dir / "typed.json"
            document = json.loads(path.read_text())
            document["kind"] = []
            payload = {key: value for key, value in document.items() if key != "checksum"}
            document["checksum"] = hashlib.sha256(json.dumps(
                payload, ensure_ascii=True, separators=(",", ":"),
                sort_keys=True).encode("ascii")).hexdigest()
            path.write_text(json.dumps(document, separators=(",", ":")) + "\n")
            fifo = journal.journal_dir / "fifo.json"
            os.mkfifo(fifo, 0o600)
            snapshot = inspect_records(self.root)
            self.assertEqual(len(snapshot.invalid), 2)

    def test_symlinked_ancestor_state_root_is_rejected(self):
        ancestor = Path(self.temp.name) / "real-parent"
        ancestor.mkdir()
        nested = ancestor / "nested"
        nested.mkdir(mode=0o700)
        alias = Path(self.temp.name) / "parent-alias"
        alias.symlink_to(ancestor, target_is_directory=True)
        with self.assertRaises(JournalError):
            RecoveryJournal(alias / "nested", role="controller")

    def test_concurrent_terminal_cleanup_is_idempotent_and_preserves_history(self):
        with RecoveryJournal(self.root, role="controller") as journal:
            journal.claim_intent(session_id="session-a", resource_id="concurrent",
                                 kind="filesystem", stage="build")
            owned = self._owned(journal, "concurrent")
            journal.transition("concurrent", "durable_owned",
                               identity=filesystem_identity(self.root, owned))
            journal.transition("concurrent", "active")
            barrier = threading.Barrier(3)
            errors = []
            def finish():
                try:
                    barrier.wait()
                    journal.begin_cleanup("concurrent")
                    journal.finish_cleanup("concurrent", complete=True)
                except BaseException as exc:
                    errors.append(exc)
            threads = [threading.Thread(target=finish) for _ in range(2)]
            for thread in threads:
                thread.start()
            barrier.wait()
            for thread in threads:
                thread.join(2)
            self.assertEqual(errors, [])
            record = journal.read("concurrent")
            self.assertEqual(record["phase"], "reclaimed")
            self.assertEqual(record["sequence"], 5)


if __name__ == "__main__":
    unittest.main()
