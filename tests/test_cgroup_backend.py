import copy
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from mirrorgate.cgroup import AggregateLimits, CgroupDelegation, REQUIRED_CHILD_FILES

REQUIRED_FAKE_FILES = REQUIRED_CHILD_FILES
from mirrorgate.control_policy import PolicyCatalog, example_policy_document
from mirrorgate.preparation import ControlBackend
from mirrorgate.policy import AdmissionError

ROOT = Path(__file__).resolve().parents[1]


class CgroupBackendTests(unittest.TestCase):

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name) / "delegated"
        self.parent.mkdir(mode=0o700)
        (self.parent / "cgroup.controllers").write_text("cpu memory pids\n")
        (self.parent /
         "cgroup.subtree_control").write_text("cpu memory pids\n")

    def test_delegation_requires_enabled_controllers_and_exact_owner(self):
        delegation = CgroupDelegation(self.parent, require_cgroupfs=False)
        delegation.close()
        (self.parent / "cgroup.subtree_control").write_text("cpu memory\n")
        with self.assertRaisesRegex(AdmissionError, "controllers"):
            CgroupDelegation(self.parent, require_cgroupfs=False)
        with mock.patch("os.geteuid", return_value=os.geteuid() + 1):
            with self.assertRaisesRegex(AdmissionError, "serving-UID"):
                CgroupDelegation(self.parent, require_cgroupfs=False)

    def test_child_limits_membership_and_observations(self):
        delegation = CgroupDelegation(self.parent, require_cgroupfs=False)
        real_mkdir = os.mkdir

        def make(name, mode=0o777, *, dir_fd=None):
            real_mkdir(name, mode=mode, dir_fd=dir_fd)
            child = self.parent / name
            for item, value in {
                    "pids.max": "max\n",
                    "memory.max": "max\n",
                    "cpu.max": "max 100000\n",
                    "cgroup.procs": "",
                    "pids.current": "0\n",
                    "pids.events": "max 0\n",
                    "memory.current": "0\n",
                    "memory.events": "oom 0\n",
                    "cpu.stat": "usage_usec 0\n",
                    "cgroup.events": "populated 0\n",
                    "cgroup.kill": ""
            }.items():
                (child / item).write_text(value)

        limits = AggregateLimits(12, 1024 * 1024, 50_000, 100_000)
        with mock.patch("mirrorgate.cgroup.os.mkdir", side_effect=make), \
             mock.patch("mirrorgate.cgroup.secrets.token_hex", return_value="a" * 32):
            session = delegation.create("session-a", limits)
        self.assertEqual((session.path / "pids.max").read_text().strip(), "12")
        self.assertEqual((session.path / "memory.max").read_text().strip(),
                         str(1024 * 1024))
        self.assertEqual((session.path / "cpu.max").read_text().strip(),
                         "50000 100000")
        session.join(123)
        self.assertEqual((session.path / "cgroup.procs").read_text().strip(),
                         "123")
        observed = session.observe()
        self.assertEqual(observed["pids.current"], "0")
        self.assertIsNone(observed["memory.peak"])
        with mock.patch("mirrorgate.cgroup.os.rmdir",
                        side_effect=OSError("busy")):
            with self.assertRaises(OSError):
                session.cleanup(timeout=.1)
        self.assertGreaterEqual(session.fd, 0)
        with mock.patch("mirrorgate.cgroup.os.rmdir") as removed:
            terminal = session.cleanup(timeout=.1)
        removed.assert_called_once()
        self.assertEqual(terminal["cgroup.events"], "populated 0")
        self.assertEqual(session.cleanup(timeout=0), terminal)
        delegation.close()

    def test_kernel_limit_readback_mismatch_refuses_admission(self):
        delegation = CgroupDelegation(self.parent, require_cgroupfs=False)
        real_mkdir = os.mkdir

        def make(name, mode=0o777, *, dir_fd=None):
            real_mkdir(name, mode=mode, dir_fd=dir_fd)
            child = self.parent / name
            for item in REQUIRED_FAKE_FILES:
                (child / item).write_text("0\n")
            (child / "cgroup.events").write_text("populated 0\n")

        from mirrorgate import cgroup as module
        original = module._read_at

        def mismatched(fd, name, maximum=65536):
            value = original(fd, name, maximum)
            return "999" if name == "pids.max" else value
        with mock.patch("mirrorgate.cgroup.os.mkdir", side_effect=make), \
             mock.patch("mirrorgate.cgroup._read_at", side_effect=mismatched):
            with self.assertRaisesRegex(AdmissionError, "did not apply"):
                delegation.create("session",
                                  AggregateLimits(12, 1024, 1, 1000))
        delegation.close()

    def test_legacy_policy_with_delegation_does_not_advertise_aggregate(self):
        source = Path(self.temp.name) / "legacy-source"
        source.mkdir()
        catalog = PolicyCatalog.from_document(
            example_policy_document(submission_root=source,
                                    node_shim_root=ROOT,
                                    node_runtime_root=Path("/usr/local")))

        class FakeDelegation:

            def __init__(self, _path):
                pass

            def probe(self):
                pass

            def close(self):
                pass

        with mock.patch("mirrorgate.preparation.CgroupDelegation",
                        FakeDelegation):
            backend = ControlBackend(catalog, cgroup_parent=self.parent)
            try:
                report = next(item
                              for item in backend.capability_reports("stdio")
                              if item["id"] == "quota.aggregate-v1")
                self.assertFalse(report["available"])
                self.assertEqual(report["enforcedScope"], "none")
            finally:
                backend.close()

    def test_v3_policy_is_closed_and_v1_cannot_gain_aggregate_fields(self):
        source = Path(self.temp.name) / "source"
        source.mkdir()
        document = example_policy_document(
            submission_root=source,
            node_shim_root=ROOT,
            node_runtime_root=Path("/usr/local"))
        document["schema"] = "mirrorgate.control-policy/v3"
        document["agentProfiles"] = []
        policy = document["policies"][0]
        policy["agentProfileIds"] = []
        policy["aggregateLimits"] = {
            "pidsMax": 32,
            "memoryMax": 268435456,
            "cpuQuotaMicros": 50000,
            "cpuPeriodMicros": 100000
        }
        parsed = PolicyCatalog.from_document(document).select(policy["id"])
        self.assertEqual(parsed.aggregate_limits.pids_max, 32)
        invalid = copy.deepcopy(document)
        invalid["policies"][0]["aggregateLimits"]["extra"] = 1
        with self.assertRaises(AdmissionError):
            PolicyCatalog.from_document(invalid)
        v1 = example_policy_document(submission_root=source,
                                     node_shim_root=ROOT,
                                     node_runtime_root=Path("/usr/local"))
        v1["policies"][0]["aggregateLimits"] = policy["aggregateLimits"]
        with self.assertRaises(AdmissionError):
            PolicyCatalog.from_document(v1)


if __name__ == "__main__":
    unittest.main()
