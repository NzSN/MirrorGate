import os
import json
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

    def test_controller_death_reclaims_group_linked_descendants_and_preserves_sentinel(self):
        """Real kernel gate: no fake delegation or mocked cleanup is permitted."""
        from mirrorgate.recovery import reclaim
        self.assertNotIn("microsoft", os.uname().release.lower(),
                         "native Linux acceptance requires an admitted native runner")
        delegation = self.delegation()
        delegation.close()
        sentinel = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        with tempfile.TemporaryDirectory() as tmp:
            state_root = Path(tmp) / "state"
            state_root.mkdir(mode=0o700)
            script = r'''
import json,os,stat,subprocess,sys,time
from pathlib import Path
from mirrorgate.cgroup import CgroupDelegation,AggregateLimits
from mirrorgate.recovery_journal import RecoveryJournal,GROUP_SCHEMA,cgroup_identity_digest,filesystem_identity
root=Path(sys.argv[1]); parent=Path(sys.argv[2])
journal=RecoveryJournal(root,role="controller")
journal.claim_intent(session_id="crash-session",resource_id="files",kind="filesystem",stage="preparation")
owned=journal.resources_dir/"worker-files";owned.mkdir(mode=0o700)
journal.transition("files","durable_owned",identity=filesystem_identity(root,owned))
delegation=CgroupDelegation(parent)
journal.claim_intent(session_id="crash-session",resource_id="group",kind="cgroup",stage="authorization",schema=GROUP_SCHEMA)
group=delegation.create("crash-session",AggregateLimits(12,128*1024*1024,20000,100000))
info=group.path.stat(); pinfo=os.fstat(delegation.fd)
identity={"relativePath":group.name,"device":info.st_dev,"inode":info.st_ino,"mode":stat.S_IFMT(info.st_mode),
          "delegation":{"device":pinfo.st_dev,"inode":pinfo.st_ino,"uid":pinfo.st_uid}}
journal.transition("group","durable_owned",identity=identity)
link={"cgroupResourceId":"group","cgroupIdentityDigest":cgroup_identity_digest(identity)}
journal.claim_intent(session_id="crash-session",resource_id="process",kind="process",stage="worker_launch",schema=GROUP_SCHEMA,identity=link)
worker_code="import subprocess,sys,time; sys.stdin.buffer.read(1); child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True); print(child.pid,flush=True); time.sleep(60)"
worker=subprocess.Popen([sys.executable,"-c",worker_code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=False)
group.join(worker.pid)
start=Path(f"/proc/{worker.pid}/stat").read_text();fields=start[start.rfind(")")+2:].split()
journal.transition("process","durable_owned",identity={**link,"pid":worker.pid,"startTime":fields[19],"bootId":journal.boot_id,"cgroup":Path(f"/proc/{worker.pid}/cgroup").read_text().strip()})
journal.transition("process","active")
worker.stdin.write(b"1");worker.stdin.close()
child=int(worker.stdout.readline())
print(json.dumps({"group":str(group.path),"leader":worker.pid,"descendant":child}),flush=True)
time.sleep(60)
'''
            controller = subprocess.Popen([sys.executable, "-c", script, str(state_root),
                os.environ["MIRRORGATE_CGROUP_PARENT"]], stdout=subprocess.PIPE, text=True)
            try:
                # Reader wait is bounded independently of the controller workload.
                import selectors
                with selectors.DefaultSelector() as selector:
                    selector.register(controller.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(10), "controller did not publish durable membership")
                ready = json.loads(controller.stdout.readline())
                controller.kill(); controller.wait(timeout=5)
                result = reclaim(state_root, cgroup_parent=os.environ["MIRRORGATE_CGROUP_PARENT"])
                self.assertEqual(result["counts"]["reclaimed"], 3, result)
                self.assertEqual(result["receipt"]["cleanup"]["status"], "confirmed")
                self.assertFalse(Path(ready["group"]).exists())
                self.assertFalse((state_root / "resources" / "worker-files").exists())
                self.assertIsNone(sentinel.poll())
                again = reclaim(state_root, cgroup_parent=os.environ["MIRRORGATE_CGROUP_PARENT"])
                self.assertEqual(again["receipt"]["cleanup"]["status"], "confirmed")
            finally:
                if controller.poll() is None:
                    controller.kill(); controller.wait(timeout=5)
                sentinel.terminate(); sentinel.wait(timeout=5)

    def delegation(self):
        parent = os.environ.get("MIRRORGATE_CGROUP_PARENT")
        if not parent: self.fail("MIRRORGATE_CGROUP_PARENT is required")
        return CgroupDelegation(Path(parent))

    @unittest.skipUnless(os.environ.get("MIRRORGATE_REQUIRE_SANDBOX") == "1",
                         "real Bubblewrap workload not required")
    def test_actual_backend_controller_death_reclaims_active_authoring_tree(self):
        from mirrorgate.recovery import reclaim
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp); state_root = base / "state"
            state_root.mkdir(mode=0o700)
            source = base / "submissions" / "source"
            source.mkdir(parents=True)
            (source / "adapter.mjs").write_text("export function createAdapter(){}")
            document = example_policy_document(submission_root=source.parent,
                node_shim_root=ROOT, node_runtime_root=Path("/usr/local"))
            document["schema"] = "mirrorgate.control-policy/v3"
            document["agentProfiles"] = []
            document["policies"][0]["agentProfileIds"] = []
            document["policies"][0]["aggregateLimits"] = {
                "pidsMax":32, "memoryMax":128*1024*1024,
                "cpuQuotaMicros":20000, "cpuPeriodMicros":100000}
            policy = base / "policy.json"; policy.write_text(json.dumps(document))
            script = r'''
import json,os,sys,threading,time
from pathlib import Path
from mirrorgate.preparation import BackendOwner,ControlBackend
from mirrorgate.recovery_journal import inspect_records,GROUP_SCHEMA
backend=ControlBackend(sys.argv[1],state_root=sys.argv[2],cgroup_parent=sys.argv[3],teardown_timeout_ms=5000)
state=backend.open_session(owner=BackendOwner("connection",os.geteuid(),"d"*32),policy_id="test.node",
    submission={"kind":"source","input":{"rootId":"submission","relativePath":"source"},"buildPlanId":"copy","authoring":True},
    runtime="node-v1",manifest_bytes=Path(sys.argv[4]).read_bytes())
ready=threading.Event(); captured=bytearray()
def output(channel,data):
    captured.extend(data)
    if b"DESCENDANT_READY" in captured: ready.set()
program="import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True); print('DESCENDANT_READY',flush=True); time.sleep(60)"
threading.Thread(target=lambda:backend.authoring_exec(state,tool_id="python",arguments=["-c",program],cwd=".",cancel_event=threading.Event(),emit_output=output),daemon=True).start()
if not ready.wait(10): raise RuntimeError("real authoring descendant did not start")
records=inspect_records(Path(sys.argv[2])).records
processes=[r for r in records if r["kind"]=="process" and r["phase"]=="active"]
if not processes or any(r["schema"]!=GROUP_SCHEMA for r in processes): raise RuntimeError("production membership linkage not published")
print(json.dumps({"group":str(state.cgroup_session.path),"pids":state.cgroup_session.observe()["pids.current"]}),flush=True)
time.sleep(60)
'''
            sentinel = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
            controller = subprocess.Popen([sys.executable, "-c", script, str(policy), str(state_root),
                os.environ["MIRRORGATE_CGROUP_PARENT"], str(ROOT / "conformance/manifests/counter.json")],
                stdout=subprocess.PIPE, text=True)
            try:
                import selectors
                with selectors.DefaultSelector() as selector:
                    selector.register(controller.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(15), "production controller did not publish ready")
                ready = json.loads(controller.stdout.readline())
                self.assertGreaterEqual(int(ready["pids"]), 2)
                controller.kill(); controller.wait(timeout=5)
                recovered = reclaim(state_root, cgroup_parent=os.environ["MIRRORGATE_CGROUP_PARENT"])
                self.assertEqual(recovered["receipt"]["cleanup"]["status"], "confirmed", recovered)
                self.assertTrue(any(item["kind"] == "process" and item["disposition"] == "reclaimed"
                                    for item in recovered["results"]))
                self.assertFalse(Path(ready["group"]).exists())
                self.assertIsNone(sentinel.poll())
                self.assertEqual(tuple((state_root / "resources").iterdir()), ())
            finally:
                if controller.poll() is None:
                    controller.kill(); controller.wait(timeout=5)
                sentinel.terminate(); sentinel.wait(timeout=5)

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
