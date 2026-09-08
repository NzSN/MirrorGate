import json
from pathlib import Path
import sys
import threading
import time
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"supervisor"))
from mirrorgate.control_protocol import validate_request
from mirrorgate.orchestration import OrchestrationController

MANIFEST=json.dumps({"schema":"mirrorgate.port/v1","interfaceDigest":"0"*64,"initializers":[{"id":"Initialize","inputs":[]}],"actions":[],"observations":[{"id":"Count","type":{"kind":"int"}}]},separators=(",",":"))

class Outcome:
    returncode=7
class Prepared:
    artifact_id="a"*32; artifact_hash="b"*64; source_hash=None; runtime_id="node-v1"; policy_id="default"
class Cleanup:
    complete=True; remaining_resources=(); failures=()
class Reservation:
    endpoint_path="/tmp/fake.sock"; attachment_token="9"*64; attachment_timeout_ms=4999

class FakeBackend:
    instance_id="f"*32
    def __init__(self): self.cleaned=[]; self.prepared=threading.Event(); self.guard=None; self.cleanup_error=False; self.block_prepare=False
    def capability_reports(self,mode): return ({"id":"control.local-stdio-v1","available":True,"enforcedScope":"connection","limits":{}},)
    def open_session(self,**kwargs): self.on_deadline=kwargs["on_deadline"]; return {"owner":kwargs["owner"]}
    def authoring_exec(self,state,**kwargs): kwargs["emit_output"]("stdout",b"ok"); return Outcome()
    def prepare(self,state,**kwargs):
        self.prepared.set()
        if self.block_prepare:
            kwargs["cancel_event"].wait(1)
            raise RuntimeError("cancelled preparation")
        return Prepared()
    def authorize_admission(self,state,**kwargs): return object()
    def reserve_worker(self,state,**kwargs): self.guard=kwargs["launch_guard"]; return Reservation()
    def arm_worker_release(self,state,**kwargs): kwargs.get("reason"); return "dispose-then-terminate"
    def finish_worker_release(self,state,**kwargs): return Cleanup()
    def cleanup_session(self,state,**kwargs):
        self.cleaned.append(state)
        if self.cleanup_error: raise RuntimeError("cleanup exploded")
        return Cleanup()

def req(i,op,args): return validate_request({"v":1,"kind":"request","id":i,"op":op,"args":args})

class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.events=[]; self.backend=FakeBackend(); self.c=OrchestrationController(self.backend,connection_id="c1",principal_uid=123,connection_mode="stdio",emit=self.events.append)
        self.c.dispatch(req(1,"hello",{"controlVersions":[1],"requiredCapabilities":[]})); self.c.after_response()
    def open(self, i=2, authoring=False):
        submission={"kind":"source","input":{"rootId":"root","relativePath":"."},"buildPlanId":"copy","authoring":True} if authoring else {"kind":"prebuilt","input":{"rootId":"root","relativePath":"."}}
        response=self.c.dispatch(req(i,"session.open",{"policyId":"default","submission":submission,"runtime":"node-v1","manifestJson":MANIFEST}))
        self.c.after_response()
        return response["result"]["sessionId"]
    def wait_finished(self,operation_id):
        for _ in range(100):
            matches=[e for e in self.events if e["event"]=="operation.finished" and e["data"]["operationId"]==operation_id]
            if matches:return matches[-1]
            time.sleep(.01)
        self.fail("operation did not finish")

    def test_preparation_ack_precedes_work_and_status_observes_result(self):
        session=self.open(); response=self.c.dispatch(req(3,"session.prepare",{"sessionId":session}))
        self.assertFalse(self.backend.prepared.is_set()); self.assertEqual(self.events,[])
        operation=response["result"]["operationId"]; self.c.after_response(); event=self.wait_finished(operation)
        self.assertEqual(event["data"]["status"],"succeeded")
        status=self.c.dispatch(req(4,"operation.status",{"sessionId":session,"operationId":operation}))
        self.assertEqual(status["result"],event["data"])

    def test_authoring_nonzero_is_success_and_session_remains_usable(self):
        session=self.open(authoring=True); response=self.c.dispatch(req(3,"authoring.exec",{"sessionId":session,"toolId":"test","arguments":[],"cwd":"."})); self.c.after_response()
        event=self.wait_finished(response["result"]["operationId"])
        self.assertEqual(event["data"]["result"]["exitCode"],7)
        self.assertEqual(self.c.dispatch(req(4,"session.status",{"sessionId":session}))["result"]["phase"],"authoring")

    def test_connection_and_handle_owner_binding(self):
        session=self.open(); other=OrchestrationController(self.backend,connection_id="c2",principal_uid=123,connection_mode="stdio",emit=lambda _:None)
        other.dispatch(req(1,"hello",{"controlVersions":[1],"requiredCapabilities":[]})); other.after_response()
        response=other.dispatch(req(2,"session.status",{"sessionId":session}))
        self.assertEqual(response["error"]["code"],"HANDLE_INVALID")
        self.assertEqual(self.c.dispatch(req(3,"session.status",{"sessionId":session}))["result"]["phase"],"open")

    def test_backend_deadline_callback_drives_control_terminal_event(self):
        session=self.open(); self.backend.on_deadline(self.c._sessions[session].backend_state)
        for _ in range(50):
            events=[e for e in self.events if e["event"]=="session.closed" and e["sessionId"]==session]
            if events:break
            time.sleep(.01)
        self.assertTrue(events); self.assertEqual(events[-1]["data"]["phase"],"closed")

    def test_prepare_authorize_acquire_requires_exact_nonce_and_one_use(self):
        session=self.open(); accepted=self.c.dispatch(req(3,"session.prepare",{"sessionId":session})); self.c.after_response(); prepared=self.wait_finished(accepted["result"]["operationId"])["data"]["result"]
        bad={"registrationId":"r","request":"verify","policy":"require","status":"matched","descriptorSchema":"mirrors.model-interface-descriptor/v1","semanticDigest":"1"*64,"adapterId":"mirrorgate/node-v1","targetProfile":"node-v1","stateComputerContractVersion":"mirrors.state-computer/v1"}
        failed=self.c.dispatch(req(4,"session.authorize",{"sessionId":session,"preparedRevision":1,"challenge":prepared["challenge"],"attestation":bad}))
        self.assertEqual(failed["error"]["code"],"NEGOTIATION_ATTESTATION_INVALID")
        good=dict(bad);good["semanticDigest"]="0"*64
        authorized=self.c.dispatch(req(5,"session.authorize",{"sessionId":session,"preparedRevision":1,"challenge":prepared["challenge"],"attestation":good}))
        auth=authorized["result"]["authorizationId"]
        acquired=self.c.dispatch(req(6,"worker.acquire",{"sessionId":session,"authorizationId":auth}))
        self.assertEqual(acquired["result"]["releaseMode"],"control-v1")
        repeated=self.c.dispatch(req(7,"worker.acquire",{"sessionId":session,"authorizationId":auth}))
        self.assertIn(repeated["error"]["code"],("HANDLE_INVALID","STATE_INVALID"))
        state=self.c._sessions[session]
        self.assertTrue(self.backend.guard(state.owner,state.worker_id,state.admission)); self.assertFalse(self.backend.guard(state.owner,state.worker_id,state.admission))

    def test_cancel_has_priority_over_blocked_prepare(self):
        self.backend.block_prepare=True; session=self.open(); preparing=self.c.dispatch(req(3,"session.prepare",{"sessionId":session})); self.c.after_response(); self.assertTrue(self.backend.prepared.wait(.2))
        cancelled=self.c.dispatch(req(4,"session.cancel",{"sessionId":session,"reason":"user-cancel"})); self.c.after_response()
        self.assertTrue(cancelled["ok"]); terminal=self.wait_finished(cancelled["result"]["operationId"])
        self.assertEqual(terminal["data"]["result"]["phase"],"closed")

    def test_cleanup_exception_is_terminal_cleanup_failed(self):
        session=self.open(); self.backend.cleanup_error=True
        closed=self.c.dispatch(req(3,"session.close",{"sessionId":session,"outcomeSummary":{"status":"failed","failureFamily":"sut-failure"}})); self.c.after_response()
        terminal=self.wait_finished(closed["result"]["operationId"])
        self.assertEqual(terminal["data"]["error"]["code"],"CLEANUP_FAILED")
        status=self.c.dispatch(req(4,"session.status",{"sessionId":session}))["result"]
        self.assertEqual((status["phase"],status["cleanup"]["status"]),("cleanupFailed","failed"))

    def tearDown(self): self.c.close(join_timeout=.2)

if __name__=="__main__":unittest.main()
