"""Managed author source lease, closed policy, broker and bounded host regressions."""
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest import mock

from mirrorgate.agent_policy import AgentProfile, AgentAdmission, LIMIT_CEILINGS, public_task
from mirrorgate.agent_runtime import AgentHost, HostedProcess, verify_receipt
from mirrorgate.authoring_broker import AuthoringBroker, MAX_FRAME, strict_json
from mirrorgate.control_policy import PolicyCatalog, example_policy_document
from mirrorgate.policy import AdmissionError
from mirrorgate.preparation import ControlBackend, BackendOwner, BackendError

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = (ROOT / 'conformance/manifests/counter.json').read_bytes()


def profile_document(root):
    return {'id':'author','runtime':'codex','executable':'/usr/bin/true','version':'codex-cli 0.153.4',
            'model':'gpt-5.6-sol','modelCatalog':str(root/'catalog.json'),'credentialFile':str(root/'auth.json'),
            'auditReceipt':str(root/'receipt.json'),'auditMaxAgeSeconds':86400,'credentialRevision':'test',
            'limits':dict(LIMIT_CEILINGS)}


class PolicyTests(unittest.TestCase):
    def test_closed_v2_preserves_base_v1(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            doc = example_policy_document(submission_root=root,node_shim_root=ROOT,
                node_runtime_root=os.environ.get('MIRRORGATE_NODE_RUNTIME_ROOT','/usr/local'))
            old = PolicyCatalog.from_document(doc)
            self.assertEqual(old.agent_profiles,{})
            doc['schema']='mirrorgate.control-policy/v2'
            doc['agentProfiles']=[profile_document(root)]
            doc['policies'][0]['agentProfileIds']=['author']
            catalog = PolicyCatalog.from_document(doc)
            self.assertEqual(catalog.agent_profile('test.node','author').id,'author')
            self.assertEqual(catalog.select('test.node').limits,old.select('test.node').limits)
            with self.assertRaises(AdmissionError):
                catalog.agent_profile('test.node','foreign')
            for field in ('env','arguments','tools','provider'):
                doc['agentProfiles'][0][field]={}
                with self.assertRaises(AdmissionError):
                    PolicyCatalog.from_document(doc)
                del doc['agentProfiles'][0][field]
            doc['policies'][0]['agentProfileIds'].append('foreign')
            with self.assertRaises(AdmissionError):
                PolicyCatalog.from_document(doc)

    def test_public_context_cannot_alias_reserved_paths_or_exceed_bytes(self):
        for files in ([{'path':'.mirrorgate/a','text':''}], [{'path':'../a','text':''}],
                      [{'path':'a','text':''},{'path':'a/b','text':''}], [{'path':'a','text':'x'*262145}]):
            with self.assertRaises(AdmissionError):
                public_task({'instructions':'task','files':files})
        with self.assertRaises(AdmissionError):
            public_task({'instructions':'é'*32769,'files':[]})

    def test_receipt_expiration_identity_and_private_permissions(self):
        from mirrorgate.agent_runtime import PROBE_REVISION
        with tempfile.TemporaryDirectory() as tmp:
            profile=AgentProfile.parse(profile_document(Path(tmp)))
            receipt={'schema':'mirrorgate.agent-audit/v1','probeRevision':PROBE_REVISION,
                     'identity':{'sha':'fixed'},'passed':True,'auditedAt':time.time()}
            profile.audit_receipt.write_text(json.dumps(receipt)); profile.audit_receipt.chmod(0o600)
            verify_receipt(profile,{'sha':'fixed'})
            with self.assertRaises(AdmissionError): verify_receipt(profile,{'sha':'changed'})
            receipt['auditedAt']-=86401
            profile.audit_receipt.write_text(json.dumps(receipt))
            with self.assertRaises(AdmissionError): verify_receipt(profile,{'sha':'fixed'})
            receipt['auditedAt']=time.time()+60
            profile.audit_receipt.write_text(json.dumps(receipt))
            with self.assertRaises(AdmissionError): verify_receipt(profile,{'sha':'fixed'})
            profile.audit_receipt.chmod(0o644)
            with self.assertRaises(AdmissionError): verify_receipt(profile,{'sha':'fixed'})


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='mg-test-')
        self.calls=[]
        self.count=0
        try:
            self.broker=AuthoringBroker(Path(self.tmp.name),contract={'instructions':'public','files':[]},
                execute=lambda tool,args: self.calls.append((tool,args)) or {'stdout':'public'},
                submit=self.submit,tool_ids=('python',))
        except OSError as exc:
            self.tmp.cleanup()
            if os.environ.get('MIRRORGATE_REQUIRE_SANDBOX')=='1': raise
            self.skipTest(str(exc))
    def submit(self):
        self.count+=1
        return {'submissionId':'private-handle'}
    def tearDown(self):
        if hasattr(self,'broker'): self.assertTrue(self.broker.close())
        self.tmp.cleanup()
    def request(self,op,**kw):
        return {'id':1,'op':op,'token':self.broker.token,**kw}
    def test_owner_fixed_tools_and_submit_revoke(self):
        req=self.request('exec',toolId='python',args=['-c','print(1)'])
        for key,value in [('token','foreign'),('sessionId','other')]:
            bad={**req,key:value}
            with self.assertRaises(ValueError): self.broker.dispatch(bad)
        self.assertEqual(self.calls,[])
        self.broker.dispatch(req)
        self.assertEqual(len(self.calls),1)
        self.assertEqual(self.broker.dispatch(self.request('submit')),{'submitted':True})
        self.broker.dispatch(self.request('submit')); self.assertEqual(self.count,1)
        with self.assertRaises(ValueError): self.broker.dispatch(req)
    def test_submit_joins_and_excludes_tools(self):
        entered=threading.Event(); resume=threading.Event(); results=[]
        def submit():
            entered.set(); resume.wait(2)
            return self.submit()
        self.broker.submit=submit
        first=threading.Thread(target=lambda:results.append(self.broker.dispatch(self.request('submit'))))
        second=threading.Thread(target=lambda:results.append(self.broker.dispatch(self.request('submit'))))
        first.start(); self.assertTrue(entered.wait(1)); second.start()
        with self.assertRaises(ValueError): self.broker.dispatch(self.request('exec',toolId='python',args=[]))
        resume.set(); first.join(2); second.join(2)
        self.assertEqual(self.count,1); self.assertEqual(len(results),2)
    def test_actual_socket_malformed_and_disclosure(self):
        for payload in (b'{"id":1,"id":2}\n', b'x'*(MAX_FRAME+1),
                        json.dumps(self.request('exec',toolId='foreign',args=[])).encode()+b'\n'):
            with socket.socket(socket.AF_UNIX) as connection:
                connection.connect(str(self.broker.path))
                try: connection.sendall(payload)
                except BrokenPipeError: pass
                with connection.makefile('rb') as stream:
                    result=stream.readline(MAX_FRAME+1)
                self.assertNotIn(self.tmp.name.encode(),result)
                self.assertNotIn(self.broker.token.encode(),result)
                if result: self.assertFalse(json.loads(result)['ok'])
        self.assertEqual(self.calls,[])
    def test_active_command_is_not_silently_queued(self):
        entered=threading.Event(); resume=threading.Event()
        def execute(*_): entered.set(); resume.wait(2); return {}
        self.broker.execute=execute
        thread=threading.Thread(target=lambda:self.broker.dispatch(self.request('exec',toolId='python',args=[])))
        thread.start(); self.assertTrue(entered.wait(1))
        with self.assertRaises(ValueError): self.broker.dispatch(self.request('exec',toolId='python',args=[]))
        resume.set(); thread.join(2)

    def test_close_cannot_miss_an_accepted_unregistered_connection(self):
        accepted = threading.Event(); release = threading.Event(); joining_acceptor = threading.Event()
        slots = self.broker.slots
        class PausedSlots:
            def acquire(inner, **kwargs):
                result = slots.acquire(**kwargs)
                accepted.set(); release.wait(3)
                return result
            def release(inner): slots.release()
        self.broker.slots = PausedSlots()
        original_join = self.broker.thread.join
        def join(timeout=None):
            joining_acceptor.set()
            return original_join(timeout)
        self.broker.thread.join = join
        connection = socket.socket(socket.AF_UNIX)
        outcomes = []
        closer = threading.Thread(target=lambda: outcomes.append(self.broker.close(1)))
        try:
            connection.connect(str(self.broker.path)); self.assertTrue(accepted.wait(1))
            closer.start(); self.assertTrue(joining_acceptor.wait(1))
            release.set(); closer.join(2)
            self.assertEqual(outcomes, [True])
            with self.broker.lock:
                self.assertFalse(self.broker.connections, 'cleanup missed an accepted socket')
                self.assertFalse(any(worker.is_alive() for worker in self.broker.threads),
                                 'cleanup missed an accepted connection worker')
        finally:
            release.set()
            try: connection.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            connection.close()
            if closer.is_alive(): closer.join(3)


class SourceSubmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name)
        self.source=self.root/'source'; self.source.mkdir(); (self.source/'adapter.mjs').write_text('original')
        doc=example_policy_document(submission_root=self.root,node_shim_root=ROOT,
            node_runtime_root=os.environ.get('MIRRORGATE_NODE_RUNTIME_ROOT','/usr/local'))
        self.backend=ControlBackend(PolicyCatalog.from_document(doc),teardown_timeout_ms=1000)
        self.owner=BackendOwner('owner',os.getuid(),'a'*32)
        self.state=self.backend.open_session(owner=self.owner,policy_id='test.node',submission={
            'kind':'source','input':{'rootId':'submission','relativePath':'source'},'buildPlanId':'copy','authoring':True},
            runtime='node-v1',manifest_bytes=MANIFEST)
    def tearDown(self):
        self.assertTrue(self.backend.close().complete); self.tmp.cleanup()
    def test_commit_freezes_once_and_host_cleanup_gates_prepare(self):
        self.state.host_cleanup_complete=False
        result=self.backend.submit_source(self.state,cancel_event=threading.Event())
        (self.source/'adapter.mjs').write_text('changed')
        self.assertEqual(self.backend.submit_source(self.state,cancel_event=threading.Event()),result)
        self.assertEqual((self.state.source_lease._mount_path(self.owner)/'adapter.mjs').read_text(),'original')
        with self.assertRaises(BackendError):
            self.backend.prepare(self.state,cancel_event=threading.Event(),emit_output=lambda *_:None)
        self.state.host_cleanup_complete=True
        with mock.patch('mirrorgate.preparation.GateSession.from_frozen',side_effect=AdmissionError('failed build')):
            with self.assertRaises(BackendError):
                self.backend.prepare(self.state,cancel_event=threading.Event(),emit_output=lambda *_:None)
        with self.assertRaises(BackendError):
            self.backend.prepare(self.state,cancel_event=threading.Event(),emit_output=lambda *_:None)
        self.assertEqual(self.state.submission,result)
    def test_cancel_during_provisional_freeze_releases_without_commit(self):
        cancel=threading.Event(); freeze=self.backend._store.freeze
        def freezing(*a,**kw):
            lease=freeze(*a,**kw); cancel.set(); return lease
        with mock.patch.object(self.backend._store,'freeze',side_effect=freezing):
            with self.assertRaises(BackendError): self.backend.submit_source(self.state,cancel_event=cancel)
        self.assertIsNone(self.state.submission); self.assertIsNone(self.state.source_lease)
        self.assertEqual(self.backend.resource_counts(self.state)['snapshots'],2)
    def test_actual_author_build_and_committed_source_handoff(self):
        if not self.backend._probe_backend()[0]:
            if os.environ.get('MIRRORGATE_REQUIRE_SANDBOX') == '1':
                self.fail('required Bubblewrap backend unavailable')
            self.skipTest('Bubblewrap backend unavailable')
        private = self.root / 'private-canary'
        private.write_text('PRIVATE_CANARY_VALUE')
        chunks = []
        command = 'import os; assert not os.path.exists(' + repr(str(private)) + '); assert "PRIVATE_GATE_ENV" not in os.environ; print("ISOLATED")'
        with mock.patch.dict(os.environ, {'PRIVATE_GATE_ENV': 'private'}):
            result = self.backend.authoring_exec(self.state, tool_id='python', arguments=['-c',command],
                cwd='.', cancel_event=threading.Event(), emit_output=lambda _, chunk: chunks.append(chunk))
        self.assertEqual(result.returncode,0); self.assertIn(b'ISOLATED',b''.join(chunks))
        submission = self.backend.submit_source(self.state,cancel_event=threading.Event())
        (self.source/'adapter.mjs').write_text('modified after commit')
        prepared = self.backend.prepare(self.state,cancel_event=threading.Event(),emit_output=lambda *_:None)
        self.assertEqual(prepared.source_hash,submission['sourceHash'])
        self.assertEqual((self.state.artifact_lease._mount_path(self.owner)/'adapter.mjs').read_text(),'original')
        with self.assertRaises(BackendError):
            self.backend.authoring_exec(self.state,tool_id='python',arguments=['-c','print(1)'],cwd='.',
                cancel_event=threading.Event(),emit_output=lambda *_:None)

    def test_host_admission_rejects_private_mount_overlap_before_runtime_allocation(self):
        from dataclasses import replace
        profile=AgentProfile.parse(profile_document(self.source))
        self.backend.catalog.agent_profiles['author']=profile
        policy=replace(self.state.policy,agent_profile_ids=('author',))
        self.state.policy=policy; self.backend.catalog._policies[policy.id]=policy
        with mock.patch.object(self.backend,'_probe_backend',return_value=(True,None)), mock.patch.object(AgentProfile,'admit') as admit:
            with self.assertRaises(BackendError) as caught:
                self.backend.admit_agent(self.state,'author',{'instructions':'','files':[]})
            self.assertEqual(caught.exception.code,'POLICY_DENIED'); admit.assert_not_called()
            self.state.input_path=Path('/tmp')
            with self.assertRaises(BackendError) as caught:
                self.backend.admit_agent(self.state,'author',{'instructions':'','files':[]})
            self.assertEqual(caught.exception.code,'POLICY_DENIED'); admit.assert_not_called()

    def test_writer_admission_must_quiesce_before_freeze(self):
        self.state.authoring_done.clear()
        with mock.patch.object(self.backend._store,'freeze') as freeze:
            with self.assertRaisesRegex(BackendError,'quiesce'):
                self.backend.submit_source(self.state,cancel_event=threading.Event())
            freeze.assert_not_called()
        self.state.authoring_done.set()


class HostBoundsTests(unittest.TestCase):
    def test_reaped_host_never_signals_its_reusable_pid(self):
        from types import SimpleNamespace
        process = HostedProcess.__new__(HostedProcess)
        process._lock = threading.Lock(); process.reason = 'exited'; process.cleanup_deadline = None
        process.process = SimpleNamespace(pid=424242, returncode=0)
        process.returncode = 0; process._pidfd = None; process._cancel_event = threading.Event()
        with mock.patch('mirrorgate.agent_runtime.os.kill') as raw_signal, \
             mock.patch('mirrorgate.agent_runtime.signal.pidfd_send_signal') as pinned_signal:
            process.terminate()
            raw_signal.assert_not_called(); pinned_signal.assert_not_called()

    def test_live_host_signals_only_its_pinned_identity(self):
        from types import SimpleNamespace
        process = HostedProcess.__new__(HostedProcess)
        process._lock = threading.Lock(); process.reason = 'exited'; process.cleanup_deadline = None
        process.process = SimpleNamespace(pid=424242, returncode=None)
        process.returncode = None; process._pidfd = 99; process._cancel_event = threading.Event()
        with mock.patch('mirrorgate.agent_runtime.os.kill') as raw_signal, \
             mock.patch('mirrorgate.agent_runtime.signal.pidfd_send_signal') as pinned_signal:
            process.terminate()
            raw_signal.assert_not_called()
            pinned_signal.assert_called_once_with(99, 15)
            self.assertTrue(process._cancel_event.is_set())

    def run_host(self,code,limits=None,cancel=False,remove_receipt=False,timeout_after_ready=False):
        import sys
        temp=tempfile.TemporaryDirectory(prefix='mg-host-test-')
        root=Path(temp.name)
        profile=AgentProfile.parse(profile_document(root))
        admission=AgentAdmission(profile,{},dict(LIMIT_CEILINGS)| (limits or {}),{'instructions':'','files':[]})
        event=threading.Event()
        host=AgentHost(admission,execute=lambda *_:{},submit=lambda:{},tool_ids=(),
            deadline=time.monotonic()+10,cancel_event=event)
        host.root=root; (root/'support').mkdir(); (root/'support'/'agent_trampoline.py').write_bytes((ROOT/'supervisor/mirrorgate/agent_trampoline.py').read_bytes()); (root/'cwd').mkdir(); (root/'home').mkdir(); (root/'home'/'auth.json').write_text('synthetic')
        cancellation_thread = None
        if cancel or timeout_after_ready:
            ready = threading.Event()
            marker = root / 'cwd' / 'cancel-ready'
            code = "from pathlib import Path; Path('cancel-ready').touch()\n" + code
            def cancel_started_runtime():
                deadline = time.monotonic() + 5
                while (not marker.exists() or host.process is None) and time.monotonic() < deadline:
                    time.sleep(.005)
                if marker.exists() and host.process is not None:
                    ready.set()
                    if timeout_after_ready:
                        # Exercise the real watchdog after startup, independently
                        # of interpreter scheduling on a loaded test runner.
                        from dataclasses import replace
                        host.process.limits = replace(host.process.limits,
                            wall_seconds=time.monotonic()-host.process.started+.1)
                    else: event.set()
                else: event.set()
            cancellation_thread = threading.Thread(target=cancel_started_runtime)
            cancellation_thread.start()
        result=host._execute([sys.executable,'-c',code],{'PATH':'/usr/bin:/bin'},b'',capture=True)
        if cancellation_thread is not None:
            cancellation_thread.join(6)
            self.assertTrue(ready.is_set(), 'cancellation test runtime did not reach leader readiness')
        if remove_receipt:
            (root/'cleanup.json').unlink(missing_ok=True)
        clean=host.cleanup()
        self.assertIsNone(host.process._pidfd, 'owned process identity descriptor leaked')
        if remove_receipt:
            self.assertFalse(clean[0]); self.assertIn('agent-descendants',clean[1])
        else:
            self.assertTrue(clean[0], (result[:2], clean))
        self.assertFalse(root.exists()); temp.cleanup()
        return result
    def test_output_cap_and_deadline_and_cancellation(self):
        code,reason,out,_=self.run_host("import sys; sys.stdout.write('x'*50000)",{'stdoutBytes':32})
        self.assertEqual(reason,'stdout_limit'); self.assertEqual(len(out['stdout']),32)
        code,reason,_,_=self.run_host('import time; time.sleep(20)',cancel=True)
        self.assertEqual(reason,'cancelled')
        code,reason,_,_=self.run_host('import time; time.sleep(20)',timeout_after_ready=True)
        self.assertEqual(reason,'wall_timeout')
    def test_parent_environment_and_descendants_do_not_survive(self):
        child = "import os,time,signal; os.setsid(); os.fork(); signal.signal(signal.SIGTERM,signal.SIG_IGN); open('pid-'+str(os.getpid()),'w').close(); time.sleep(30)"
        program = "import os,subprocess,sys,time,json; assert 'MIRRORGATE_PRIVATE_TEST' not in os.environ; subprocess.Popen([sys.executable,'-c'," + repr(child) + "],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\nwhile len(os.listdir('.')) < 2: time.sleep(.01)\nprint(json.dumps([int(x[4:]) for x in os.listdir('.')]))"
        with mock.patch.dict(os.environ, {'MIRRORGATE_PRIVATE_TEST': 'private'}):
            code,reason,out,_=self.run_host(program)
        self.assertEqual(code,0)
        pids = json.loads(out['stdout'])
        self.assertEqual(len(pids),2)
        for pid in pids:
            with self.assertRaises(ProcessLookupError): os.kill(pid,0)

    def test_unconfirmed_descendant_cleanup_never_reports_success(self):
        self.run_host('print("finished")',remove_receipt=True)

    def test_initial_context_contamination_refuses_before_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); (root/'home').mkdir(); (root/'cwd').mkdir()
            profile=AgentProfile.parse(profile_document(root))
            admission=AgentAdmission(profile,{},dict(LIMIT_CEILINGS),{'instructions':'','files':[]})
            host=AgentHost(admission,execute=lambda *_:{},submit=lambda:{},tool_ids=(),
                deadline=time.monotonic()+2,cancel_event=threading.Event())
            host.root=root
            (root/'home'/'AGENTS.md').write_text('private global instructions')
            with self.assertRaisesRegex(AdmissionError,'pristine'):
                host._execute(['/usr/bin/true'],{},b'')
            self.assertIsNone(host.process)

    def test_partial_start_deletes_private_staging(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile=AgentProfile.parse(profile_document(Path(tmp)))
            admission=AgentAdmission(profile,{},dict(LIMIT_CEILINGS),{'instructions':'','files':[]})
            host=AgentHost(admission,execute=lambda *_:{},submit=lambda:{},tool_ids=(),
                deadline=time.monotonic()+2,cancel_event=threading.Event())
            def fail():
                host.root=Path(tempfile.mkdtemp()); (host.root/'home').mkdir()
                (host.root/'home'/'auth.json').write_text('synthetic'); raise RuntimeError('private')
            with mock.patch('mirrorgate.agent_runtime.verify_receipt'), mock.patch.object(host,'_stage',side_effect=fail):
                result=host.run()
            self.assertEqual(result.reason,'start_failed'); self.assertTrue(result.cleanup_complete)
            self.assertFalse(host.root.exists())

    def test_pending_submit_is_revoked_before_runtime_failure_cleanup(self):
        import sys
        for failure in ('wall_timeout', 'stdout_limit', 'stderr_limit', 'exited'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix='mg-late-submit-') as tmp:
                root = Path(tmp)
                for directory in ('support', 'cwd', 'home'): (root / directory).mkdir()
                (root / 'support/agent_trampoline.py').write_bytes((ROOT / 'supervisor/mirrorgate/agent_trampoline.py').read_bytes())
                limits = dict(LIMIT_CEILINGS, wallMs=10000)
                if failure.endswith('_limit'): limits[failure.removesuffix('_limit') + 'Bytes'] = 64
                admission = AgentAdmission(AgentProfile.parse(profile_document(root)), {}, limits,
                    {'instructions': 'public', 'files': []})
                cancel = threading.Event(); release = threading.Event(); entered = threading.Event(); committed = []
                def submit():
                    entered.set(); (root / 'submit-entered').touch()
                    if failure == 'wall_timeout':
                        from dataclasses import replace
                        while host.process is None: time.sleep(.001)
                        host.process.limits = replace(host.process.limits,
                            wall_seconds=time.monotonic()-host.process.started+.05)
                    release.wait(4)
                    if cancel.is_set(): raise ValueError('submission cancelled')
                    committed.append(True)
                    return {'submissionId': '1'*32, 'sourceHash': 'a'*64, 'sourceRevision': 1}
                host = AgentHost(admission, execute=lambda *_: {}, submit=submit, tool_ids=(),
                    deadline=time.monotonic()+30, cancel_event=cancel)
                host.root = root
                host.broker = AuthoringBroker(root, contract=admission.task, execute=lambda *_: {}, submit=submit, tool_ids=())
                request = json.dumps({'id': 1, 'token': host.broker.token, 'op': 'submit'}).encode()+b'\n'
                script = ('import socket,time,os,sys\ns=socket.socket(socket.AF_UNIX); s.connect('+repr(str(host.broker.path))+')\n'
                    +'s.sendall('+repr(request)+')\nwhile not os.path.exists('+repr(str(root/'submit-entered'))+'): time.sleep(.01)\n')
                if failure in ('stdout_limit', 'stderr_limit'):
                    stream = 'sys.stdout' if failure == 'stdout_limit' else 'sys.stderr'
                    script += "print('x'*4096,file="+stream+",flush=True)\ns.recv(1024)\n"
                elif failure == 'wall_timeout': script += 's.recv(1024)\n'
                try:
                    _, reason, _, _ = host._execute([sys.executable, '-c', script], {'PATH': '/usr/bin:/bin'}, b'')
                    self.assertTrue(entered.is_set()); self.assertEqual(reason, failure)
                    self.assertTrue(cancel.is_set(), 'pending source commitment remained admitted after runtime failure/exit')
                    release.set()
                    complete, remaining = host.cleanup()
                    self.assertTrue(complete, remaining)
                    self.assertFalse(committed, 'source committed after runtime termination')
                finally:
                    release.set()
                    if root.exists(): host.cleanup()

    def test_failed_pidfd_admission_retains_child_for_cleanup(self):
        import sys
        with tempfile.TemporaryDirectory(prefix='mg-pin-failure-') as tmp:
            root = Path(tmp)
            for directory in ('support', 'cwd', 'home'): (root / directory).mkdir()
            (root / 'support/agent_trampoline.py').write_bytes((ROOT / 'supervisor/mirrorgate/agent_trampoline.py').read_bytes())
            admission = AgentAdmission(AgentProfile.parse(profile_document(root)), {}, dict(LIMIT_CEILINGS),
                {'instructions': 'public', 'files': []})
            cancel = threading.Event()
            host = AgentHost(admission, execute=lambda *_: {}, submit=lambda: {}, tool_ids=(),
                deadline=time.monotonic()+30, cancel_event=cancel)
            host.root = root
            try:
                with mock.patch('mirrorgate.agent_runtime.os.pidfd_open', side_effect=OSError('simulated pidfd denial')):
                    with self.assertRaises(OSError):
                        host._execute([sys.executable, '-c', 'import time; time.sleep(30)'], {'PATH': '/usr/bin:/bin'}, b'')
                child = host._unmonitored_process
                self.assertIsNotNone(child); self.assertTrue(cancel.is_set())
                # Never infer descendant cleanup merely because the leader was
                # reaped. This also covers failure before the trampoline starts.
                with mock.patch('mirrorgate.agent_runtime.read_regular', side_effect=AdmissionError('missing receipt')):
                    complete, remaining = host.cleanup()
                self.assertFalse(complete); self.assertIn('agent-descendants', remaining)
                self.assertIsNotNone(child.poll())
                self.assertTrue(all(stream.closed for stream in (child.stdin, child.stdout, child.stderr)))
                self.assertFalse(root.exists())
            finally:
                if root.exists(): host.cleanup()
