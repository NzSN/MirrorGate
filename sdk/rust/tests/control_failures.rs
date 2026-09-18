use mirrorgate_sdk::{
    ClientOptions, ControlClient, ControllerCommand, InputRef, OpenSession, OperationOutcome,
    PublicManifest, Submission, WorkerOptions,
};
use std::{collections::BTreeMap, time::Duration};

const MANIFEST: &str = r#"{"schema":"mirrorgate.port/v1","interfaceDigest":"0000000000000000000000000000000000000000000000000000000000000000","initializers":[{"id":"Initialize","inputs":[]}],"actions":[],"observations":[{"id":"Count","type":{"kind":"int"}}]}"#;
const CONTROLLER: &str = r#"
import json,sys,time
mode=sys.argv[1]; released=False
session='2'*32; worker='6'*32
hello={'controlVersion':1,'instanceId':'1'*32,'capabilities':[],'limits':{'maxFrameBytes':1048576,'maxJsonDepth':128,'maxJsonNodes':16384,'maxPendingOutputBytes':4194304,'maxSessionsPerConnection':4,'maxInflightRequestsPerConnection':16,'maxCompletedOperationsPerSession':128,'helloTimeoutMs':5000,'requestAckTimeoutMs':5000,'workerAttachmentTimeoutMs':5000,'sessionWallMs':600000,'gracefulStopMs':1000,'teardownMs':5000}}
def send(req,result): print(json.dumps({'v':1,'kind':'response','id':req['id'],'ok':True,'result':result},separators=(',',':')),flush=True)
for line in sys.stdin:
 req=json.loads(line); op=req['op']
 if op=='hello': send(req,hello); continue
 if mode=='timeout': time.sleep(2); continue
 if mode=='eof': break
 if mode=='wrong-id': print(json.dumps({'v':1,'kind':'response','id':req['id']+1,'ok':True,'result':{'sessionId':session}},separators=(',',':')),flush=True); continue
 if mode=='malformed': print('{"v":1,"kind":"response","id":2,"ok":true,"result":{},"result":{}}',flush=True); continue
 if op=='session.open': send(req,{'sessionId':session})
 elif op=='session.authorize': send(req,{'authorizationId':'5'*32})
 elif op=='worker.acquire': send(req,{'workerId':worker,'endpoint':{'kind':'unix','path':'/tmp/mirrorgate-sdk-missing/worker.sock'},'attachmentToken':'7'*64,'attachmentTimeoutMs':100,'releaseMode':'control-v1'})
 elif op=='worker.release': released=True; send(req,{'operationId':2,'cleanupMode':'terminate-only'})
 elif op=='operation.status': send(req,{'operationId':req['args']['operationId'],'status':'succeeded','result':{'phase':'closed','cleanupStatus':'succeeded','remainingResources':[]}})
 elif op=='session.status': send(req,{'phase':'closed' if released else 'reserved','resources':{'authoringProcesses':0,'buildProcesses':0,'workers':0 if released else 1,'snapshots':0},'cleanup':{'status':'succeeded' if released else 'notStarted','remainingResources':[]}})
 elif op=='session.close': released=True; send(req,{'operationId':2})
"#;

fn command(mode: &str) -> ControllerCommand {
    ControllerCommand {
        program: "/usr/bin/python3".into(),
        args: vec!["-u".into(), "-c".into(), CONTROLLER.into(), mode.into()],
        cwd: None,
        env: Some(BTreeMap::new()),
    }
}
fn options() -> ClientOptions {
    ClientOptions {
        request_timeout: Duration::from_millis(100),
        hello_timeout: Duration::from_secs(1),
        close_timeout: Duration::from_secs(1),
        ..ClientOptions::default()
    }
}
fn open(client: &ControlClient) -> mirrorgate_sdk::Session {
    client
        .open_session(OpenSession {
            policy_id: "default".into(),
            submission: Submission::Prebuilt {
                input: InputRef {
                    root_id: "submissions".into(),
                    relative_path: "counter".into(),
                },
            },
            runtime: "node-v1".into(),
            manifest_json: MANIFEST.into(),
            limits: None,
            model_revision_id: None,
        })
        .unwrap()
}

#[test]
fn invalid_worker_options_release_consumed_reservation() {
    let client = ControlClient::launch(command("normal"), options()).unwrap();
    let session = open(&client);
    let attestation = mirrorgate_sdk::RequiredMatchAttestation::matched(
        "registration",
        "0".repeat(64),
        "adapter",
        "fixture",
        "mirrors.state-computer/v1",
    );
    let authorization = session.authorize(1, "4".repeat(32), attestation).unwrap();
    let reservation = session.acquire_worker(authorization).unwrap();
    let manifest = PublicManifest::from_exact_json(MANIFEST).unwrap();
    assert!(
        reservation
            .connect(manifest, "wrong-runtime", WorkerOptions::default())
            .is_err()
    );
    assert_eq!(
        session.status().unwrap().phase,
        mirrorgate_sdk::SessionPhase::Closed
    );
    assert!(client.close().process_shutdown_confirmed());
}

#[test]
fn failed_attachment_releases_reservation_once() {
    let client = ControlClient::launch(command("normal"), options()).unwrap();
    let session = open(&client);
    let authorization = session
        .authorize(
            1,
            "4".repeat(32),
            mirrorgate_sdk::RequiredMatchAttestation::matched(
                "registration",
                "0".repeat(64),
                "adapter",
                "fixture",
                "mirrors.state-computer/v1",
            ),
        )
        .unwrap();
    let reservation = session.acquire_worker(authorization).unwrap();
    assert!(
        reservation
            .connect(
                PublicManifest::from_exact_json(MANIFEST).unwrap(),
                "node-v1",
                WorkerOptions::default()
            )
            .is_err()
    );
    assert_eq!(
        session.status().unwrap().phase,
        mirrorgate_sdk::SessionPhase::Closed
    );
    let joined = session
        .close(None)
        .unwrap()
        .wait(Duration::from_secs(1))
        .unwrap();
    assert!(matches!(joined, OperationOutcome::Succeeded(_)));
    assert!(client.close().process_shutdown_confirmed());
}

#[test]
fn timeout_eof_and_malformed_responses_poison_control_connection() {
    for mode in ["timeout", "eof", "wrong-id", "malformed"] {
        let client = ControlClient::launch(command(mode), options()).unwrap();
        assert!(
            client
                .open_session(OpenSession {
                    policy_id: "default".into(),
                    submission: Submission::Prebuilt {
                        input: InputRef {
                            root_id: "submissions".into(),
                            relative_path: "counter".into()
                        }
                    },
                    runtime: "node-v1".into(),
                    manifest_json: MANIFEST.into(),
                    limits: None,
                    model_revision_id: None
                })
                .is_err()
        );
        assert!(
            client
                .open_session(OpenSession {
                    policy_id: "default".into(),
                    submission: Submission::Prebuilt {
                        input: InputRef {
                            root_id: "submissions".into(),
                            relative_path: "counter".into()
                        }
                    },
                    runtime: "node-v1".into(),
                    manifest_json: MANIFEST.into(),
                    limits: None,
                    model_revision_id: None
                })
                .is_err()
        );
        assert!(client.close().transport_closed);
    }
}
