"""Journal/recovery contract tests; fake controller files are not kernel acceptance."""
import os
from pathlib import Path
import stat
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from mirrorgate.cgroup import CgroupDelegation
from mirrorgate.recovery import reclaim
from mirrorgate.recovery_journal import (
    RecoveryJournal, GROUP_SCHEMA, JournalError, cgroup_identity_digest, filesystem_identity)
from mirrorgate.preparation import ControlBackend


class GroupProcessRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "state"
        self.root.mkdir(mode=0o700)
        self.parent = self.base / "delegated"
        self.parent.mkdir(mode=0o700)
        (self.parent / "cgroup.controllers").write_text("cpu memory pids\n")
        (self.parent / "cgroup.subtree_control").write_text("cpu memory pids\n")
        self.group = self.parent / "owned-group"
        self.group.mkdir(mode=0o700)
        for key, value in {
            "pids.max":"8", "memory.max":"1048576", "memory.swap.max":"0",
            "cpu.max":"10000 100000", "cgroup.kill":"untouched", "pids.current":"0",
            "pids.events":"max 0", "memory.current":"0", "memory.events":"oom 0",
            "cpu.stat":"usage_usec 1", "cgroup.events":"populated 0",
        }.items():
            (self.group / key).write_text(value)

    def claims(self, *, process_session="session-a", full=True, stale_boot=False, wrong_digest=False):
        with RecoveryJournal(self.root, role="controller") as journal:
            journal.claim_intent(session_id="session-a", resource_id="filesystem",
                                 kind="filesystem", stage="preparation")
            self.owned = journal.resources_dir / "session-files"
            self.owned.mkdir(mode=0o700)
            journal.transition("filesystem", "durable_owned", identity=filesystem_identity(self.root, self.owned))
            journal.claim_intent(session_id="session-a", resource_id="group", kind="cgroup",
                                 stage="authorization", schema=GROUP_SCHEMA)
            info = self.group.stat(); parent = self.parent.stat()
            group_identity = {"relativePath": self.group.name, "device":info.st_dev, "inode":info.st_ino,
                              "mode":stat.S_IFMT(info.st_mode), "delegation":{
                                  "device":parent.st_dev, "inode":parent.st_ino, "uid":parent.st_uid}}
            if stale_boot:
                journal.boot_id = "00000000-0000-0000-0000-000000000000"
                # Use a separate complete claim with a different original boot.
                current = journal.read("group")
                payload = {key:value for key,value in current.items() if key != "checksum"}
                payload["bootId"] = journal.boot_id
                journal._publish(payload, create=False)
            group = journal.transition("group", "durable_owned", identity=group_identity)
            link = {"cgroupResourceId":"group", "cgroupIdentityDigest":cgroup_identity_digest(group_identity)}
            if wrong_digest:
                link["cgroupIdentityDigest"] = "f" * 64
            journal.claim_intent(session_id=process_session, resource_id="process", kind="process",
                                 stage="worker_launch", schema=GROUP_SCHEMA, identity=link)
            if full:
                journal.transition("process", "durable_owned", identity={**link,
                    "pid":os.getpid(), "startTime":"reused-pid-observation", "bootId":journal.boot_id,
                    "cgroup":"not-an-ownership-authority"})
                journal.transition("process", "active")
            return group

    def delegation(self, path):
        return CgroupDelegation(path, require_cgroupfs=False)

    def remove_fake_group(self, name, *, dir_fd=None):
        if name == self.group.name:
            for child in self.group.iterdir():
                child.unlink()
        self.real_rmdir(name, dir_fd=dir_fd)

    def recover(self):
        self.real_rmdir = os.rmdir
        with mock.patch("mirrorgate.recovery.CgroupDelegation", side_effect=self.delegation), \
             mock.patch("mirrorgate.cgroup.os.rmdir", side_effect=self.remove_fake_group), \
             mock.patch("os.kill") as kill, mock.patch("os.killpg") as killpg:
            result = reclaim(self.root, cgroup_parent=self.parent)
        kill.assert_not_called(); killpg.assert_not_called()
        return result

    def test_group_empty_authorizes_linked_process_then_filesystem_and_retry(self):
        self.claims()
        result = self.recover()
        self.assertEqual(result["counts"]["reclaimed"], 3, result)
        self.assertEqual(result["receipt"]["cleanup"]["status"], "confirmed")
        self.assertEqual(result["receipt"]["journalSchema"], GROUP_SCHEMA)
        self.assertFalse(self.owned.exists())
        self.assertFalse(self.group.exists())
        self.assertEqual(self.recover()["counts"]["reclaimed"], 3)

    def test_group_failure_keeps_process_retryable_and_protects_files(self):
        self.claims()
        with mock.patch("mirrorgate.recovery.CgroupDelegation", side_effect=self.delegation), \
             mock.patch("mirrorgate.cgroup.os.rmdir", side_effect=OSError("busy")):
            first = reclaim(self.root, cgroup_parent=self.parent)
        by_id = {item["resourceId"]:item for item in first["results"]}
        self.assertEqual(by_id["group"]["phase"], "cleanup_failed")
        self.assertEqual(by_id["process"]["phase"], "cleanup_failed")
        self.assertTrue(self.owned.exists())
        self.assertEqual(self.recover()["counts"]["reclaimed"], 3)

    def test_recovery_interruption_after_group_cleanup_uses_durable_empty_observation(self):
        self.claims(); self.real_rmdir = os.rmdir
        with mock.patch("mirrorgate.recovery.CgroupDelegation", side_effect=self.delegation), \
             mock.patch("mirrorgate.cgroup.os.rmdir", side_effect=self.remove_fake_group), \
             mock.patch("mirrorgate.recovery._reclaim_group_process", side_effect=RuntimeError("cut")):
            with self.assertRaisesRegex(RuntimeError, "cut"):
                reclaim(self.root, cgroup_parent=self.parent)
        self.assertFalse(self.group.exists())
        self.assertTrue(self.owned.exists())
        self.assertEqual(self.recover()["counts"]["reclaimed"], 3)

    def test_cut_after_removal_before_terminal_publication_replays_durable_empty_evidence(self):
        self.claims(); self.real_rmdir = os.rmdir
        transition = RecoveryJournal.transition
        def cut(journal, resource_id, phase, **kwargs):
            if resource_id == "group" and phase == "reclaimed":
                raise RuntimeError("cut after remove")
            return transition(journal, resource_id, phase, **kwargs)
        with mock.patch("mirrorgate.recovery.CgroupDelegation", side_effect=self.delegation), \
             mock.patch("mirrorgate.cgroup.os.rmdir", side_effect=self.remove_fake_group), \
             mock.patch.object(RecoveryJournal, "transition", cut):
            with self.assertRaisesRegex(RuntimeError, "cut after remove"):
                reclaim(self.root, cgroup_parent=self.parent)
        self.assertFalse(self.group.exists())
        self.assertTrue(self.owned.exists())
        with RecoveryJournal(self.root, role="recoverer", initialize=False) as journal:
            record = journal.read("group")
            self.assertEqual(record["phase"], "cleanup_intent")
            self.assertIn("populated 0", record["cleanupEvidence"]["counters"]["cgroup.events"])
        self.assertEqual(self.recover()["counts"]["reclaimed"], 3)

    def test_missing_group_without_durable_empty_observation_stays_ambiguous(self):
        self.claims()
        for child in self.group.iterdir():
            child.unlink()
        self.group.rmdir()
        result = self.recover()
        self.assertNotEqual(result["receipt"]["cleanup"]["status"], "confirmed")
        self.assertTrue(self.owned.exists())

    def test_foreign_session_never_reclaims_process(self):
        self.claims(process_session="foreign")
        result = self.recover()
        process = next(item for item in result["results"] if item["resourceId"] == "process")
        self.assertEqual(process["disposition"], "ambiguous")

    def test_unpublished_membership_never_reclaims_process(self):
        self.claims(full=False)
        result = self.recover()
        process = next(item for item in result["results"] if item["resourceId"] == "process")
        self.assertEqual(process["disposition"], "ambiguous")
        self.assertTrue(self.owned.exists())

    def test_stale_boot_never_writes_group_kill(self):
        self.claims(stale_boot=True)
        result = self.recover()
        self.assertNotEqual(result["receipt"]["cleanup"]["status"], "confirmed")
        self.assertEqual((self.group / "cgroup.kill").read_text(), "untouched")

    def test_wrong_group_digest_never_reclaims_process_or_enclosing_files(self):
        self.claims(wrong_digest=True)
        result = self.recover()
        process = next(item for item in result["results"] if item["resourceId"] == "process")
        self.assertEqual(process["reasonCode"], "process_group_link_unconfirmed")
        self.assertTrue(self.owned.exists())

    def test_replaced_delegation_never_touches_original_group(self):
        self.claims()
        old = self.base / "old-delegated"
        self.parent.rename(old)
        self.parent.mkdir(mode=0o700)
        (self.parent / "cgroup.controllers").write_text("cpu memory pids\n")
        (self.parent / "cgroup.subtree_control").write_text("cpu memory pids\n")
        result = self.recover()
        self.assertNotEqual(result["receipt"]["cleanup"]["status"], "confirmed")
        self.assertEqual((old / "owned-group" / "cgroup.kill").read_text(), "untouched")
        self.assertTrue(self.owned.exists())

    def test_v2_identity_and_linkage_are_immutable(self):
        self.claims()
        with RecoveryJournal(self.root, role="controller") as journal:
            identity = dict(journal.read("process")["identity"])
            identity["cgroupIdentityDigest"] = "f" * 64
            with self.assertRaisesRegex(JournalError, "immutable"):
                journal.transition("process", "cleanup_intent", identity=identity)

    def test_production_process_hooks_publish_exact_link_only_after_join(self):
        self.claims()
        with RecoveryJournal(self.root, role="controller") as journal:
            # Use the same original controller identity for the new hook fixture.
            group = journal.read("group")
            journal.controller_instance = group["controllerInstance"]
            backend = object.__new__(ControlBackend)
            backend._journal = journal
            joined = []
            state = SimpleNamespace(owner=SimpleNamespace(session_id="session-a"),
                cgroup_session=SimpleNamespace(join=joined.append),
                journal_cgroup_resources=["group"], journal_process_resources=[])
            hooks = backend._process_hooks(state, "worker_launch")
            hooks[0]()
            hooks[1](SimpleNamespace(pid=os.getpid()))
            self.assertEqual(joined, [os.getpid()])
            record = journal.read(state.journal_process_resources[0])
            self.assertEqual(record["schema"], GROUP_SCHEMA)
            self.assertEqual(record["phase"], "active")
            self.assertEqual(record["identity"]["cgroupResourceId"], "group")
            self.assertEqual(record["identity"]["cgroupIdentityDigest"],
                             cgroup_identity_digest(group["identity"]))
            hooks = backend._process_hooks(state, "worker_launch")
            hooks[0]()
            state.cgroup_session = None
            with self.assertRaisesRegex(JournalError, "closed before"):
                hooks[1](SimpleNamespace(pid=os.getpid()))


if __name__ == "__main__":
    unittest.main()
