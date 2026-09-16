import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from mirrorgate.control_policy import PolicyCatalog, example_policy_document
from mirrorgate.preparation import BackendError, BackendOwner, ControlBackend
from mirrorgate.node_profile import public_environment
from mirrorgate.authoring_broker import AuthoringBroker
from mirrorgate.policy import AdmissionError, ToolRequest
from mirrorgate.artifacts import FrozenStore

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = (ROOT / 'conformance/manifests/counter.json').read_bytes()

class NodeProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'adapter.mjs').write_text('throw new Error("must not import during preparation");')
        (self.source / 'private.txt').write_text('not selected')
        runtime_root = Path(os.environ.get('MIRRORGATE_NODE_RUNTIME_ROOT', '/usr/local'))
        self.document = example_policy_document(submission_root=self.source, node_shim_root=ROOT, node_runtime_root=runtime_root)
        self.document.update(schema='mirrorgate.control-policy/v2', agentProfiles=[])
        policy = self.document['policies'][0]
        policy['agentProfileIds'] = []
        command = policy['runtimes'][0]['command'][0]
        mount = max((mount for mount in policy['runtimes'][0]['runtimeMounts'] if command.startswith(mount['destination']+'/')),key=lambda m:len(m['destination']))
        self.binary = Path(mount['source']) / command[len(mount['destination'])+1:]
        self.plan = {'id':'node.copy','profile':'node-esm/v1','entryPoint':'adapter.mjs','sourceFiles':['adapter.mjs'],
            'runtimeSha256':hashlib.sha256(self.binary.read_bytes()).hexdigest(),'dependencies':[]}
        policy['buildPlans']=[self.plan]

    def backend(self, *, authoring=False):
        backend=ControlBackend(PolicyCatalog.from_document(self.document))
        self.addCleanup(backend.close)
        state=backend.open_session(owner=BackendOwner('conn',os.getuid(),'1'*32),policy_id=self.document['policies'][0]['id'],
            submission={'kind':'source','input':{'rootId':'submission','relativePath':'.'},'buildPlanId':'node.copy','authoring':authoring},
            runtime='node-v1',manifest_bytes=MANIFEST)
        return backend,state

    def test_freezes_selected_source_without_hooks_or_import(self):
        backend,state=self.backend()
        with mock.patch('mirrorgate.preparation.GateSession.from_frozen',side_effect=AssertionError('must not execute build')):
            result=backend.prepare(state,cancel_event=threading.Event(),emit_output=lambda *_:None)
        artifact=state.artifact_lease._mount_path(state.owner)
        self.assertEqual([item.name for item in artifact.iterdir()],['adapter.mjs'])
        (self.source/'adapter.mjs').write_text('changed')
        self.assertIn('must not import', (artifact/'adapter.mjs').read_text())
        self.assertEqual(state.preparation_identity['artifactHash'],result.artifact_hash)
        self.assertEqual(state.preparation_identity['sourceHash'],result.source_hash)
        self.assertEqual(state.preparation_identity['runtimeSha256'],self.plan['runtimeSha256'])

    def test_rejects_hash_mismatch_escape_symlinks_and_v1_profile(self):
        original=copy.deepcopy(self.document)
        self.plan['runtimeSha256']='0'*64
        with self.assertRaisesRegex(BackendError,'identity mismatch'): self.backend()
        for field,value in [('entryPoint','../adapter.mjs'),('sourceFiles',['../adapter.mjs']),('dependencies',[{'rootId':'submission','relativePath':'../escape','sha256':'a'*64}])]:
            self.document=copy.deepcopy(original);self.document['policies'][0]['buildPlans'][0][field]=value
            with self.assertRaises(AdmissionError):PolicyCatalog.from_document(self.document)
        self.document=copy.deepcopy(original)
        (self.source/'adapter.mjs').unlink();(self.source/'adapter.mjs').symlink_to(self.root/'oracle')
        (self.root/'oracle').write_text('private')
        backend,state=self.backend()
        with self.assertRaises(BackendError):backend.prepare(state,cancel_event=threading.Event(),emit_output=lambda *_:None)
        self.document=copy.deepcopy(original);self.document['schema']='mirrorgate.control-policy/v1';self.document.pop('agentProfiles');self.document['policies'][0].pop('agentProfileIds')
        with self.assertRaisesRegex(AdmissionError,'policy v2'):PolicyCatalog.from_document(self.document)

    def test_dependency_content_is_frozen(self):
        deps=self.root/'deps';deps.mkdir();(deps/'dep.mjs').write_text('export const n=1;')
        store=FrozenStore();lease=store.freeze('pin',deps); digest=lease.digest; lease.close('pin');store.close()
        self.document['policies'][0]['roots'].append({'id':'dependencies','path':str(deps),'kinds':['prebuilt'],'allowedUids':[os.getuid()]})
        self.plan['dependencies']=[{'rootId':'dependencies','relativePath':'.','sha256':digest}]
        backend,state=self.backend();(deps/'dep.mjs').write_text('changed')
        backend.prepare(state,cancel_event=threading.Event(),emit_output=lambda *_:None)
        self.assertEqual((state.artifact_lease._mount_path(state.owner)/'node_modules/dep.mjs').read_text(),'export const n=1;')

    def test_public_environment_discloses_only_logical_policy_and_broker_negotiation(self):
        _,state=self.backend();environment=public_environment(state)
        self.assertNotIn(str(self.root),json.dumps(environment))
        self.assertEqual(environment['profileId'],'node-esm/v1')
        task={'instructions':'public','files':[]}; tools=tuple(state.policy.tools)
        for supplied in (None,environment):
            broker=AuthoringBroker(self.root,contract=task,execute=lambda *_:None,submit=lambda:None,tool_ids=tools,environment=supplied)
            try:
                contract=broker.dispatch({'id':1,'op':'contract','token':broker.token})['contract']
                if supplied is None:self.assertEqual(contract,{**task,'tools':list(tools)})
                else:
                    self.assertEqual(contract['schema'],'mirrorgate.public-contract/v2');self.assertEqual(contract['task'],task)
                    self.assertEqual(contract['environment'],environment)
            finally:self.assertTrue(broker.close())

    def test_real_profile_denies_private_import_and_readonly_write(self):
        backend,state=self.backend()
        available,reason=backend._probe_backend()
        if not available:
            if os.environ.get('MIRRORGATE_REQUIRE_SANDBOX')=='1':self.fail('required backend unavailable: '+str(reason))
            self.skipTest('real Bubblewrap backend unavailable: '+str(reason))
        backend.prepare(state,cancel_event=threading.Event(),emit_output=lambda *_:None)
        oracle=self.root/'oracle.mjs';oracle.write_text('export default "private";')
        script='''const fs=require('node:fs');
for (const path of ['/artifact/forbidden', '/usr/forbidden']) {try { fs.writeFileSync(path,'bad'); process.exit(9); } catch(e) {}}
(async()=>{try {await import(process.argv[1]);process.exit(8);}catch(e){} fs.writeFileSync('/scratch/allowed','yes');console.log('denied');})();'''
        with backend._execution_gate(state) as gate:
            result=gate.run(ToolRequest((state.runtime.command[0],'-e',script,str(oracle))))
        self.assertEqual(result.returncode,0)
        self.assertIn(b'denied',result.stdout)

    def test_environment_capability_must_be_explicitly_negotiated(self):
        from mirrorgate.orchestration import OrchestrationController
        from mirrorgate.control_protocol_v2 import validate_result
        from test_hosting_controller import Backend
        for offer, required, version, expected in [(False,True,2,False),(True,True,2,True),(True,False,2,True),(True,True,1,False)]:
            backend=Backend()
            base=backend.hosting_capability_reports()
            if offer:
                backend.hosting_capability_reports=lambda: (*base,{'id':'hosting.public-environment-v1','available':True,'enforcedScope':'session','limits':{}})
            controller=OrchestrationController(backend,connection_id='environment',principal_uid=0,connection_mode='stdio',emit=lambda _:None)
            try:
                req={'v':1,'kind':'request','id':1,'op':'hello','args':{'controlVersions':[version],
                    'requiredCapabilities':['hosting.public-environment-v1'] if required else []}}
                response=controller.dispatch(req);validate_result(req,response)
                self.assertEqual(response['ok'],expected)
                self.assertEqual(getattr(controller,'_public_environment',False),expected and required)
            finally:controller.close()

    def test_structural_checker_executes_only_inside_real_profile(self):
        import subprocess
        generator="""import {generateAdapterKit} from './sdk/node/adapter-kit.mjs';
import {readFile} from 'node:fs/promises';
await generateAdapterKit(JSON.parse(await readFile('conformance/manifests/counter.json','utf8')), {directory:process.argv[1]});"""
        # Trusted generation reads only a public manifest and writes a stub; no adapter import.
        (self.source/'adapter.mjs').unlink()
        subprocess.run(['node','--input-type=module','-e',generator,str(self.source)],cwd=ROOT,check=True,capture_output=True)
        (self.source/'adapter.mjs').write_bytes((ROOT/'runtimes/node/examples/counter.mjs').read_bytes())
        (self.source/'samples.json').write_text(json.dumps([{'action':'Initialize','inputs':{}},{'action':'Tick','inputs':{'Stride':{'#bigint':'7'}}}]))
        self.plan['sourceFiles']=['adapter.mjs','adapter-codec.mjs','check-adapter.mjs','port.json','samples.json']
        backend,state=self.backend()
        if not backend._probe_backend()[0]:
            if os.environ.get('MIRRORGATE_REQUIRE_SANDBOX')=='1':self.fail('required Bubblewrap backend unavailable')
            self.skipTest('Bubblewrap unavailable')
        backend.prepare(state,cancel_event=threading.Event(),emit_output=lambda *_:None)
        with backend._execution_gate(state) as gate:
            result=gate.run(ToolRequest((state.runtime.command[0],'/artifact/check-adapter.mjs','--trusted-local','--samples=/artifact/samples.json')))
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue(json.loads(result.stdout)['structural'])


    def test_fresh_restricted_author_uses_descriptor_without_mount_prose(self):
        backend,state=self.backend(authoring=True)
        if not backend._probe_backend()[0]:
            if os.environ.get('MIRRORGATE_REQUIRE_SANDBOX')=='1':self.fail('required Bubblewrap backend unavailable')
            self.skipTest('Bubblewrap unavailable')
        contract={'instructions':'Implement the public Counter port.','files':[]}
        output=[]
        def execute(tool,args):
            result=backend.authoring_exec(state,tool_id=tool,arguments=args,cwd='.',cancel_event=threading.Event(),emit_output=lambda stream,data:output.append(data))
            return {'returncode':result.returncode}
        broker=AuthoringBroker(self.root,contract=contract,execute=execute,
            submit=lambda:backend.submit_source(state,cancel_event=threading.Event()),
            tool_ids=tuple(state.policy.tools),environment=public_environment(state))
        try:
            public=broker.dispatch({'id':1,'token':broker.token,'op':'contract'})['contract']
            env=public['environment']
            self.assertEqual(public['task'],contract)
            # Deterministic author reads all filesystem locations from public environment.
            program="import pathlib,sys; pathlib.Path(sys.argv[1],sys.argv[2]).write_text(sys.argv[3])"
            adapter=(ROOT/'runtimes/node/examples/counter.mjs').read_text()
            result=broker.dispatch({'id':2,'token':broker.token,'op':'exec','toolId':env['tools'][0],
                'args':['-c',program,env['stages']['authoring']['root'],env['entryPoint'],adapter]})
            self.assertEqual(result['returncode'],0)
            self.assertTrue(broker.dispatch({'id':3,'token':broker.token,'op':'submit'})['submitted'])
            with self.assertRaises(ValueError):broker.dispatch({'id':4,'token':broker.token,'op':'contract'})
        finally:self.assertTrue(broker.close())
        backend.prepare(state,cancel_event=threading.Event(),emit_output=lambda *_:None)
        self.assertIn('createAdapter',(state.artifact_lease._mount_path(state.owner)/'adapter.mjs').read_text())
