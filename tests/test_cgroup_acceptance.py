import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from mirrorgate.cgroup import AggregateLimits, CgroupDelegation
from mirrorgate.control_policy import PolicyCatalog, example_policy_document
from mirrorgate.preparation import BackendOwner, ControlBackend
from mirrorgate.recovery_journal import inspect_records


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_BYTES = (ROOT / "conformance/manifests/counter.json").read_bytes()


@unittest.skipUnless(
    os.environ.get("MIRRORGATE_REQUIRE_CGROUP") == "1",
    "operator delegated cgroup parent not required")
class CgroupAcceptanceTests(unittest.TestCase):

    def delegation(self):
        parent = os.environ.get("MIRRORGATE_CGROUP_PARENT")
        if not parent: self.fail("MIRRORGATE_CGROUP_PARENT is required")
        return CgroupDelegation(Path(parent))

    def test_operator_parent_is_real_delegated_cgroup_v2(self):
        delegation = self.delegation()
        delegation.close()

    def test_nested_pid_memory_cpu_counters_and_abrupt_idempotent_cleanup(
            self):
        delegation = self.delegation()
        session = delegation.create(
            "aggregate-workload",
            AggregateLimits(8, 96 * 1024 * 1024, 10000, 100000))
        script = """import subprocess,sys,time
sys.stdin.buffer.read(1)
memory=bytearray(24*1024*1024)
child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])
end=time.monotonic()+3
while time.monotonic()<end: pass
child.wait()
"""
        process = subprocess.Popen([sys.executable, "-c", script],
                                   stdin=subprocess.PIPE)
        try:
            session.join(process.pid)
            process.stdin.write(b"1")
            process.stdin.close()
            time.sleep(.3)
            first = session.observe()
            self.assertGreaterEqual(int(first["pids.current"]), 2)
            self.assertGreater(int(first["memory.current"]), 0)
            self.assertIn("usage_usec", first["cpu.stat"])
            result = session.cleanup(timeout=5)
            self.assertIn("populated 0", result["cgroup.events"])
            self.assertEqual(session.cleanup(timeout=0), result)
            process.wait(timeout=5)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            delegation.close()

    @unittest.skipUnless(os.environ.get("MIRRORGATE_REQUIRE_SANDBOX") == "1",
                         "real Bubblewrap workload not required")
    def test_actual_gate_session_workload_runs_inside_its_aggregate_cgroup(self):
        parent = Path(os.environ["MIRRORGATE_CGROUP_PARENT"])
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            state_root = base / "state"
            state_root.mkdir(mode=0o700)
            submissions = base / "submissions"
            source = submissions / "source"
            source.mkdir(parents=True)
            (source / "adapter.mjs").write_text(
                "export function createAdapter(){}", encoding="utf-8")
            document = example_policy_document(
                submission_root=submissions, node_shim_root=ROOT,
                node_runtime_root=Path("/usr/local"))
            document["schema"] = "mirrorgate.control-policy/v3"
            document["agentProfiles"] = []
            document["policies"][0]["agentProfileIds"] = []
            document["policies"][0]["aggregateLimits"] = {
                "pidsMax": 8,
                "memoryMax": 96 * 1024 * 1024,
                "cpuQuotaMicros": 20_000,
                "cpuPeriodMicros": 100_000,
            }
            backend = ControlBackend(
                PolicyCatalog.from_document(document), state_root=state_root,
                cgroup_parent=parent, teardown_timeout_ms=5000)
            state = None
            try:
                owner = BackendOwner("connection", os.geteuid(), "c" * 32)
                state = backend.open_session(
                    owner=owner, policy_id="test.node",
                    submission={"kind": "source", "input": {
                        "rootId": "submission", "relativePath": "source"},
                        "buildPlanId": "copy", "authoring": True},
                    runtime="node-v1", manifest_bytes=MANIFEST_BYTES)
                program = (
                    "import time; data=bytearray(8*1024*1024); "
                    "end=time.monotonic()+0.25; "
                    "exec('while time.monotonic() < end: pass')")
                outcome = backend.authoring_exec(
                    state, tool_id="python", arguments=["-c", program], cwd=".",
                    cancel_event=threading.Event(), emit_output=lambda *_: None)
                self.assertEqual(outcome.returncode, 0)
                counters = state.cgroup_session.observe()
                self.assertGreater(int(counters["cpu.stat"].split()[1]), 0)
                cleanup = backend.cleanup_session(
                    state, reason="normal", cancel_event=threading.Event())
                self.assertTrue(cleanup.complete, cleanup)
                self.assertIn("populated 0",
                              state.cgroup_observations["cgroup.events"])
                cgroups = [record for record in inspect_records(state_root).records
                           if record["kind"] == "cgroup"]
                self.assertEqual([record["phase"] for record in cgroups],
                                 ["reclaimed"])
            finally:
                if state is not None and not state.closed:
                    backend.cleanup_session(
                        state, reason="test_cleanup",
                        cancel_event=threading.Event())
                backend.close()


if __name__ == "__main__":
    unittest.main()
