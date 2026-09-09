"""Controller hosting lifecycle races, plus real frozen-source/bwrap handoff.

FakeHost makes race ordering deterministic; actual runtime dispatch auditing is
covered separately by agent_audit. No fake-host test claims runtime isolation.
"""
import copy
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from mirrorgate import control_protocol_v2 as wire
from mirrorgate.agent_runtime import HostResult
from mirrorgate.orchestration import OrchestrationController
from mirrorgate.policy import AdmissionError
import test_orchestration as base


CAPS = ({"id": "hosting.fresh-agent-v1", "available": True, "enforcedScope": "session", "limits": {}},
        {"id": "hosting.codex-v1", "available": True, "enforcedScope": "session", "limits": {}})


class Profile:
    limits = dict(wire.HOST_LIMITS)
    def __init__(self): self.denied = False
    def admit(self, task, limits=None):
        if self.denied: raise AdmissionError('/private/credential.json SECRET')
        return SimpleNamespace(profile=self, task=task, identity={}, limits=dict(self.limits, **(limits or {})))


class Backend(base.FakeBackend):
    def __init__(self):
        super().__init__()
        self.profile = Profile()
        self.catalog = SimpleNamespace(agent_profile=self.agent_profile)
        self.freeze_entered = threading.Event()
        self.freeze_release = threading.Event(); self.freeze_release.set()
        self.tool_entered = threading.Event()
        self.block_tool = False
        self.submit_count = 0
    def agent_profile(self, policy, profile):
        if profile != 'author': raise AdmissionError('denied /private/path')
        return self.profile
    def admit_agent(self, state, profile_id, task, limits=None):
        return self.agent_profile('default',profile_id).admit(task,limits)
    def hosting_capability_reports(self): return CAPS
    def open_session(self, **kw):
        self.on_deadline = kw['on_deadline']
        return SimpleNamespace(lock=threading.RLock(), deadline=time.monotonic()+60,
            policy=SimpleNamespace(tools={'python': None}), submission=None,
            host_cleanup_complete=True, cleanup_deadline=None, closing=False,
            source_lease=None, sealed=False)
    def submit_source(self, state, *, cancel_event):
        self.freeze_entered.set(); self.freeze_release.wait(2)
        with state.lock:
            if cancel_event.is_set() or state.closing: raise RuntimeError('cancel won /private/path')
            if state.submission is None:
                self.submit_count += 1
                state.submission = dict(submissionId='4'*32,sourceHash='a'*64,sourceRevision=1)
                state.source_lease = 'committed'
            return dict(state.submission)
    def _stop_authoring(self, state, **kw): state.sealed = True
    def authoring_exec(self, state, **kw):
        self.tool_entered.set()
        if self.block_tool: kw['cancel_event'].wait(2)
        kw['emit_output']('stdout',b'public')
        return SimpleNamespace(returncode=0)
    def cleanup_session(self, state, **kw):
        state.closing=True; state.source_lease=None
        return super().cleanup_session(state, **kw)
    def prepare(self, state, **kw):
        if not state.host_cleanup_complete: raise RuntimeError('host not clean')
        return SimpleNamespace(artifact_id='5'*32,artifact_hash='b'*64,source_hash=state.submission['sourceHash'],runtime_id='node-v1',policy_id='default')


class FakeHost:
    mode = 'wait'
    entered = threading.Event()
    release = threading.Event()
    output = None
    def __init__(self, admission, **kw): self.__dict__.update(kw)
    def run(self):
        FakeHost.entered.set()
        try:
            if self.mode == 'exec':
                FakeHost.output = self.execute('python', ['-c','print(1)'])
                self.cancel_event.wait(2)
            elif self.mode in ('submit','postcommit-cleanup-fails'):
                self.submit()
            elif self.mode == 'blocked-submit':
                self.submit()
            elif self.mode == 'exit':
                pass
            elif self.mode == 'start-fails':
                return HostResult(None,'start_failed',True,())
            elif self.mode == 'blocked-cleanup':
                self.cancel_event.wait(2); FakeHost.release.wait(2)
            else:
                self.cancel_event.wait(2)
        except Exception:
            pass
        if self.mode == 'postcommit-cleanup-fails': return HostResult(1,'failed',False,('agent-process',))
        return HostResult(0,'cancelled' if self.cancel_event.is_set() else 'exited',True,())


class HostingControllerTests(unittest.TestCase):
    def setUp(self):
        self.patch = mock.patch('mirrorgate.orchestration.AgentHost',FakeHost);self.patch.start()
        FakeHost.mode='wait';FakeHost.entered=threading.Event();FakeHost.release=threading.Event();FakeHost.output=None
        self.backend=Backend();self.events=[]
        self.c=OrchestrationController(self.backend,connection_id='host-owner',principal_uid=123,connection_mode='stdio',emit=self.events.append)
        self.ids=0
        hello=self.request('hello',{'controlVersions':[2],'requiredCapabilities':['hosting.fresh-agent-v1']})
        self.assertEqual(hello['controlVersion'],2)
        self.assertEqual(hello['limits']['requestAckTimeoutMs'],10000)
        self.session=self.request('session.open',{'policyId':'default','runtime':'node-v1','manifestJson':base.MANIFEST,
            'submission':{'kind':'source','input':{'rootId':'root','relativePath':'.'},'buildPlanId':'copy','authoring':True}})['sessionId']
    def tearDown(self):
        FakeHost.release.set();self.backend.freeze_release.set();self.c.close(join_timeout=2);self.patch.stop()
        for event in self.events: wire.validate_event(event)
    def request(self,op,args,*,failure=None,after=True):
        self.ids+=1
        req={'v':1 if op=='hello' else 2,'kind':'request','id':self.ids,'op':op,'args':args}
        response=self.c.dispatch(req)
        wire.validate_result(req,response)
        if after:self.c.after_response()
        if failure:
            self.assertFalse(response['ok'],response);self.assertEqual(response['error']['code'],failure)
            return response['error']
        self.assertTrue(response['ok'],response)
        return response['result']
    def start(self,**kw):
        return self.request('agent.start',dict(sessionId=self.session,profileId='author',publicTask={'instructions':'public task','files':[]}),**kw)['runId']
    def status(self):return self.request('agent.status',{'sessionId':self.session})['run']
    def until(self,predicate):
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            if predicate():return
            time.sleep(.005)
        self.fail('hosting transition did not complete')
    def cancel(self,run):return self.request('agent.cancel',{'sessionId':self.session,'runId':run,'reason':'user-cancel'})['run']
    def test_pending_updated_snapshot_cannot_follow_terminal_event(self):
        from mirrorgate.orchestration import HostedRun
        admission = self.backend.profile.admit({'instructions': 'public', 'files': []})
        run = HostedRun('8' * 32, admission, phase='running')
        state = SimpleNamespace(lock=threading.RLock(), hosted_run=run,
            session_id=self.session, backend_state=SimpleNamespace(submission=None,
                host_cleanup_complete=False), phase='authoring', resources={'snapshots': 0})
        captured = threading.Event(); release = threading.Event(); terminal_done = threading.Event()
        original = self.c._event
        def delayed(session_id, name, data):
            if name == 'agent.updated':
                captured.set()
                release.wait(3)
            original(session_id, name, data)
        def finish():
            self.c._terminal_host(state, HostResult(0, 'exited', True, ()))
            terminal_done.set()
        with mock.patch.object(self.c, '_event', delayed):
            update = threading.Thread(target=self.c._host_event, args=(state,))
            terminal = threading.Thread(target=finish)
            update.start()
            try:
                self.assertTrue(captured.wait(1))
                terminal.start()
                # A second producer can finish while the first update is delayed.
                # A correctly serialized implementation blocks it until release.
                terminal_done.wait(.2)
            finally:
                release.set(); update.join(2)
                if terminal.ident is not None: terminal.join(2)
            self.assertFalse(update.is_alive()); self.assertFalse(terminal.is_alive())
        self.assertEqual([event['event'] for event in self.events],
                         ['agent.updated', 'agent.finished'])
    def test_start_ack_precedes_host_and_lost_reply_status_preserves_run(self):
        run=self.start(after=False)
        self.assertFalse(FakeHost.entered.is_set());self.assertEqual(self.events,[])
        self.c.after_response();self.assertTrue(FakeHost.entered.wait(1))
        self.assertEqual(self.status()['runId'],run)
        self.request('agent.start',dict(sessionId=self.session,profileId='author',publicTask={'instructions':'task','files':[]}),failure='STATE_INVALID')
        self.assertEqual(self.cancel(run)['outcome'],'cancelled')
        self.assertEqual(len([e for e in self.events if e['event']=='agent.finished']),1)
    def test_independent_broker_slot_external_authoring_denied_and_cancel_priority(self):
        FakeHost.mode='exec';self.backend.block_tool=True
        run=self.start();self.assertTrue(self.backend.tool_entered.wait(1))
        self.request('authoring.exec',dict(sessionId=self.session,toolId='python',arguments=[],cwd='.'),failure='STATE_INVALID')
        started=time.monotonic();result=self.cancel(run)
        self.assertLess(time.monotonic()-started,1)
        self.assertEqual(result['cleanup']['status'],'succeeded')
        self.assertEqual(FakeHost.output['stdout'],'public')
    def test_no_submit_exit_is_failed_and_sanitized(self):
        FakeHost.mode='exit';self.start();self.until(lambda:self.status()['phase']=='finished')
        result=self.status();self.assertEqual(result['outcome'],'failed');self.assertEqual(result['error']['code'],'AGENT_EXITED')
        self.until(lambda:self.c._sessions[self.session].phase=='closed')
        self.assertNotIn('/private',json.dumps(result))
    def test_admission_failure_does_not_consume_slot(self):
        self.backend.profile.denied=True
        error=self.request('agent.start',dict(sessionId=self.session,profileId='author',publicTask={'instructions':'task','files':[]}),failure='AUDIT_UNAVAILABLE')
        self.assertNotIn('SECRET',json.dumps(error));self.assertIsNone(self.status())
        self.backend.profile.denied=False;run=self.start();self.cancel(run)
    def test_partial_start_failure_consumes_slot_and_cleans(self):
        FakeHost.mode='start-fails';self.start();self.until(lambda:self.status()['phase']=='finished')
        self.assertEqual(self.status()['error']['code'],'AGENT_START_FAILED')
        self.request('agent.start',dict(sessionId=self.session,profileId='author',publicTask={'instructions':'task','files':[]}),failure='STATE_INVALID')
        self.until(lambda:bool(self.backend.cleaned))
    def test_cancel_during_freeze_prevents_commit(self):
        FakeHost.mode='blocked-submit';self.backend.freeze_release.clear()
        run=self.start();self.assertTrue(self.backend.freeze_entered.wait(1))
        threading.Timer(.05,self.backend.freeze_release.set).start()
        result=self.cancel(run)
        self.assertEqual(result['outcome'],'cancelled');self.assertNotIn('submission',result)
        self.assertEqual(self.backend.submit_count,0)
    def test_postcommit_cancel_preserves_lease_and_prepares_once(self):
        FakeHost.mode='submit';run=self.start();self.until(lambda:self.status()['phase']=='finished')
        result=self.cancel(run)
        self.assertEqual(result['outcome'],'submitted')
        state=self.c._sessions[self.session]
        self.assertEqual(state.phase,'submitted');self.assertEqual(state.backend_state.source_lease,'committed')
        operation=self.request('session.prepare',{'sessionId':self.session})['operationId']
        self.until(lambda:state.operations[operation].status!='pending')
        self.assertEqual(state.operations[operation].result['sourceHash'],result['submission']['sourceHash'])
        self.request('session.prepare',{'sessionId':self.session},failure='STATE_INVALID')
        self.assertEqual(self.backend.submit_count,1)
    def test_postcommit_cleanup_failure_preserves_identity_blocks_prepare(self):
        FakeHost.mode='postcommit-cleanup-fails';self.start();self.until(lambda:self.status()['phase']=='finished')
        result=self.status();self.assertEqual(result['outcome'],'submitted');self.assertEqual(result['cleanup']['status'],'failed')
        self.request('session.prepare',{'sessionId':self.session},failure='STATE_INVALID')
        self.until(lambda:self.c._sessions[self.session].phase=='cleanupFailed')
        self.assertIn('submission',self.status())
    def test_owner_eof_preserves_identity_and_releases_physical_source(self):
        FakeHost.mode='submit';self.start();self.until(lambda:self.status()['phase']=='finished')
        self.c.close(join_timeout=2)
        state=self.c._sessions[self.session]
        self.assertEqual(state.hosted_run.outcome,'submitted');self.assertIsNone(state.backend_state.source_lease)
    def test_foreign_connection_handles_rejected_without_owner_changes(self):
        run=self.start();other=OrchestrationController(self.backend,connection_id='foreign',principal_uid=123,connection_mode='stdio',emit=lambda _:None)
        self.addCleanup(other.close)
        other.dispatch({'v':1,'kind':'request','id':1,'op':'hello','args':{'controlVersions':[2],'requiredCapabilities':[]}});other.after_response()
        for i,(op,args) in enumerate([('agent.status',{'runId':run}),('agent.cancel',{'runId':run,'reason':'user-cancel'}),('session.prepare',{}),('worker.acquire',{'authorizationId':'a'*32})],2):
            result=other.dispatch({'v':2,'kind':'request','id':i,'op':op,'args':dict(sessionId=self.session,**args)});other.after_response()
            self.assertEqual(result['error']['code'],'HANDLE_INVALID')
        self.assertEqual(self.status()['runId'],run);self.assertFalse(self.backend.cleaned)
        self.cancel(run)
    def test_host_cleanup_pending_blocks_prepare(self):
        FakeHost.mode='blocked-cleanup';run=self.start();self.assertTrue(FakeHost.entered.wait(1))
        self.request('session.prepare',{'sessionId':self.session},failure='STATE_INVALID')
        FakeHost.release.set();self.cancel(run)
    def test_start_while_external_tool_active_rejects_without_run(self):
        self.backend.block_tool=True
        self.request('authoring.exec',dict(sessionId=self.session,toolId='python',arguments=[],cwd='.'))
        self.assertTrue(self.backend.tool_entered.wait(1))
        self.request('agent.start',dict(sessionId=self.session,profileId='author',publicTask={'instructions':'task','files':[]}),failure='STATE_INVALID')
        self.assertIsNone(self.status())
        self.request('session.close',dict(sessionId=self.session))
    def test_owner_eof_before_deferred_host_start_allocates_no_agent(self):
        self.start(after=False)
        self.c.close(join_timeout=2)
        self.assertFalse(FakeHost.entered.is_set())
        self.assertEqual(self.c._sessions[self.session].hosted_run.outcome,'cancelled')
        self.assertTrue(self.backend.cleaned)
    def test_unconfirmed_teardown_is_sticky_after_late_runtime_return(self):
        FakeHost.mode='blocked-cleanup';self.start();self.assertTrue(FakeHost.entered.wait(1))
        state=self.c._sessions[self.session]
        with state.lock:self.c._cancel_host_locked(state,'user-cancel')
        self.c._join_host(state,.01)
        self.assertEqual(self.status()['cleanup']['status'],'failed')
        self.assertFalse(state.backend_state.host_cleanup_complete)
        FakeHost.release.set();self.assertTrue(state.hosted_run.done.wait(1))
        self.assertEqual(self.status()['cleanup']['status'],'failed')
        self.assertEqual(len([e for e in self.events if e['event']=='agent.finished']),1)
    def test_tightened_progress_window_reports_explicit_truncation(self):
        FakeHost.mode='submit'
        self.request('agent.start',dict(sessionId=self.session,profileId='author',publicTask={'instructions':'task','files':[]},limits={'progressBytes':1,'progressRecordBytes':1}))
        self.until(lambda:self.status()['phase']=='finished')
        progress=self.status()['progress']
        self.assertTrue(progress['truncated']);self.assertEqual(progress['records'],[])
        self.assertEqual(progress['firstSeq'],progress['nextSeq'])
    def test_v1_selection_hides_hosting(self):
        other=OrchestrationController(self.backend,connection_id='v1',principal_uid=123,connection_mode='stdio',emit=lambda _:None)
        self.addCleanup(other.close)
        result=other.dispatch({'v':1,'kind':'request','id':1,'op':'hello','args':{'controlVersions':[1],'requiredCapabilities':[]}});other.after_response()
        self.assertEqual(result['result']['controlVersion'],1)
        self.assertEqual(result['result']['limits']['requestAckTimeoutMs'],5000)
        self.assertFalse(any(c['id'].startswith('hosting.') for c in result['result']['capabilities']))


class HostingWireTests(unittest.TestCase):
    def test_stdio_bootstrap_switch_argument_rejection_and_owner_eof(self):
        from mirrorgate.control_server import serve_stream
        input_read,input_write=os.pipe();output_read,output_write=os.pipe()
        reader=os.fdopen(input_read,'rb',buffering=0);writer=os.fdopen(output_write,'wb',buffering=0)
        client=os.fdopen(output_read,'rb',buffering=0)
        backend=Backend();FakeHost.mode='wait';FakeHost.entered=threading.Event()
        def serve():
            try:serve_stream(reader,writer,backend,principal_uid=os.getuid(),connection_mode='stdio')
            finally:reader.close();writer.close()
        with mock.patch('mirrorgate.orchestration.AgentHost',FakeHost):
            thread=threading.Thread(target=serve);thread.start()
            try:
                def request(i,op,args):
                    req=dict(v=1 if op=='hello' else 2,kind='request',id=i,op=op,args=args)
                    os.write(input_write,wire.encode_control_frame(req))
                    while True:
                        response=wire.parse_control_frame(client.readline())
                        if response['kind']=='event':wire.validate_event(response);continue
                        wire.validate_result(req,response);return response
                response=request(1,'hello',dict(controlVersions=[2],requiredCapabilities=['hosting.fresh-agent-v1']))
                self.assertEqual(response['v'],1);self.assertEqual(response['result']['controlVersion'],2)
                response=request(2,'session.open',dict(policyId='default',runtime='node-v1',manifestJson=base.MANIFEST,
                    submission=dict(kind='source',input=dict(rootId='root',relativePath='.'),buildPlanId='copy',authoring=True)))
                self.assertEqual(response['v'],2);session=response['result']['sessionId']
                # Parseable bad arguments get a correlated v2 rejection and no run.
                malformed=dict(v=2,kind='request',id=3,op='agent.start',args=dict(sessionId=session,profileId='author',publicTask=dict(instructions='public',files=[]),executable='/private/secret'))
                os.write(input_write,wire.encode_control_frame(malformed));rejected=wire.parse_control_frame(client.readline())
                self.assertEqual(rejected['id'],3);self.assertEqual(rejected['v'],2);self.assertFalse(rejected['ok'])
                self.assertNotIn('/private',json.dumps(rejected))
                response=request(4,'agent.start',dict(sessionId=session,profileId='author',publicTask=dict(instructions='public',files=[])))
                self.assertTrue(response['ok']);self.assertTrue(FakeHost.entered.wait(1))
            finally:
                os.close(input_write);thread.join(3);client.close()
            self.assertFalse(thread.is_alive());self.assertEqual(len(backend.cleaned),1)


class RealSourceHostingTests(unittest.TestCase):
    def test_controller_handoff_builds_committed_source_in_actual_backend(self):
        from mirrorgate.control_policy import example_policy_document,PolicyCatalog
        from mirrorgate.preparation import ControlBackend
        root_repo=Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';source.mkdir();(source/'adapter.mjs').write_text('original')
            document=example_policy_document(submission_root=root,node_shim_root=root_repo,
                node_runtime_root=os.environ.get('MIRRORGATE_NODE_RUNTIME_ROOT','/usr/local'))
            backend=ControlBackend(PolicyCatalog.from_document(document))
            self.addCleanup(backend.close)
            if not backend._probe_backend()[0]:
                if os.environ.get('MIRRORGATE_REQUIRE_SANDBOX')=='1':self.fail('required Bubblewrap unavailable')
                self.skipTest('Bubblewrap unavailable')
            backend.hosting_capability_reports=lambda:CAPS
            backend.admit_agent=lambda state,profile,task,limits=None:Profile().admit(task,limits)
            events=[];controller=OrchestrationController(backend,connection_id='real-host',principal_uid=os.getuid(),connection_mode='stdio',emit=events.append)
            self.addCleanup(controller.close)
            i=0
            def request(op,args):
                nonlocal i;i+=1
                req=dict(v=1 if op=='hello' else 2,kind='request',id=i,op=op,args=args)
                response=controller.dispatch(req);controller.after_response();wire.validate_result(req,response)
                self.assertTrue(response['ok'],response);return response['result']
            request('hello',{'controlVersions':[2],'requiredCapabilities':[]})
            session=request('session.open',dict(policyId='test.node',runtime='node-v1',manifestJson=(root_repo/'conformance/manifests/counter.json').read_text(),
                submission=dict(kind='source',input=dict(rootId='submission',relativePath='source'),buildPlanId='copy',authoring=True)))['sessionId']
            FakeHost.mode='submit'
            with mock.patch('mirrorgate.orchestration.AgentHost',FakeHost):
                request('agent.start',dict(sessionId=session,profileId='author',publicTask=dict(instructions='public',files=[])))
                state=controller._sessions[session];self.assertTrue(state.hosted_run.done.wait(3))
            self.assertEqual(state.hosted_run.outcome,'submitted')
            (source/'adapter.mjs').write_text('changed after commit')
            op=request('session.prepare',dict(sessionId=session))['operationId']
            deadline=time.monotonic()+10
            while state.operations[op].status=='pending' and time.monotonic()<deadline:time.sleep(.01)
            self.assertEqual(state.operations[op].status,'succeeded',state.operations[op].error)
            self.assertEqual(state.operations[op].result['sourceHash'],state.hosted_run.submission['sourceHash'])
            self.assertEqual((state.backend_state.artifact_lease._mount_path(state.owner)/'adapter.mjs').read_text(),'original')
            for event in events:wire.validate_event(event)
            controller.close();self.assertTrue(backend.close().complete)


if __name__=='__main__':unittest.main()
