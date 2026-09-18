use mirrorgate_sdk::{
    CancellationToken, ClientOptions, ControlClient, ControllerCommand, ErrorKind, InputRef,
    OpenSession, OperationOutcome, PublicManifest, RequiredMatchAttestation, Submission,
    WorkerCallOptions, WorkerOptions,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::Duration,
};

const MANIFEST: &str = r#"{"schema":"mirrorgate.port/v1","interfaceDigest":"0000000000000000000000000000000000000000000000000000000000000000","initializers":[{"id":"Initialize","inputs":[]}],"actions":[],"observations":[{"id":"Count","type":{"kind":"int"}}]}"#;
const CONTROL: &str = r#"
import json,sys
endpoint=sys.argv[1]; cleanup_fail=sys.argv[2]=='fail'; session='2'*32; worker='6'*32
hello={'controlVersion':1,'instanceId':'1'*32,'capabilities':[],'limits':{'maxFrameBytes':1048576,'maxJsonDepth':128,'maxJsonNodes':16384,'maxPendingOutputBytes':4194304,'maxSessionsPerConnection':4,'maxInflightRequestsPerConnection':16,'maxCompletedOperationsPerSession':128,'helloTimeoutMs':5000,'requestAckTimeoutMs':5000,'workerAttachmentTimeoutMs':5000,'sessionWallMs':600000,'gracefulStopMs':1000,'teardownMs':5000}}
def send(req,result): print(json.dumps({'v':1,'kind':'response','id':req['id'],'ok':True,'result':result},separators=(',',':')),flush=True)
for line in sys.stdin:
 req=json.loads(line); op=req['op']
 if op=='hello': send(req,hello)
 elif op=='session.open': send(req,{'sessionId':session})
 elif op=='session.authorize': send(req,{'authorizationId':'5'*32})
 elif op=='worker.acquire': send(req,{'workerId':worker,'endpoint':{'kind':'unix','path':endpoint},'attachmentToken':'7'*64,'attachmentTimeoutMs':1000,'releaseMode':'control-v1'})
 elif op=='worker.release': send(req,{'operationId':2,'cleanupMode':'terminate-only'})
 elif op=='session.cancel': send(req,{'operationId':2})
 elif op=='session.close': send(req,{'operationId':2})
 elif op=='operation.status':
  if cleanup_fail: send(req,{'operationId':2,'status':'failed','error':{'code':'CLEANUP_FAILED','stage':'cleanup','message':'fixture cleanup failed','operationId':2}})
  else: send(req,{'operationId':2,'status':'succeeded','result':{'phase':'closed','cleanupStatus':'succeeded','remainingResources':[]}})
"#;

#[derive(Clone, Copy)]
enum Scenario {
    Cancel,
    Success,
    WrongHello,
    BadCreate,
    PartialAttachment,
    EofAfterAttach,
    EofDuringInvoke,
    BadObserve,
}
fn controller(endpoint: &str, cleanup_fail: bool) -> ControllerCommand {
    ControllerCommand {
        program: "/usr/bin/python3".into(),
        args: vec![
            "-u".into(),
            "-c".into(),
            CONTROL.into(),
            endpoint.into(),
            if cleanup_fail {
                "fail".into()
            } else {
                "ok".into()
            },
        ],
        cwd: None,
        env: Some(BTreeMap::new()),
    }
}
fn options() -> ClientOptions {
    ClientOptions {
        hello_timeout: Duration::from_secs(1),
        request_timeout: Duration::from_secs(1),
        close_timeout: Duration::from_secs(1),
        ..ClientOptions::default()
    }
}
fn setup(
    scenario: Scenario,
    cleanup_fail: bool,
) -> (
    ControlClient,
    mirrorgate_sdk::Session,
    mirrorgate_sdk::WorkerReservation,
    thread::JoinHandle<usize>,
    PathBuf,
) {
    let directory = unique_temp();
    std::fs::create_dir(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let endpoint = directory.join("worker.sock");
    let listener = UnixListener::bind(&endpoint).unwrap();
    std::fs::set_permissions(&endpoint, std::fs::Permissions::from_mode(0o600)).unwrap();
    let server = thread::spawn(move || serve(listener, scenario));
    let client = ControlClient::launch(
        controller(endpoint.to_str().unwrap(), cleanup_fail),
        options(),
    )
    .unwrap();
    let session = client
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
        .unwrap();
    let authorization = session
        .authorize(
            1,
            "4".repeat(32),
            RequiredMatchAttestation::matched(
                "registration",
                "0".repeat(64),
                "adapter",
                "fixture",
                "mirrors.state-computer/v1",
            ),
        )
        .unwrap();
    let reservation = session.acquire_worker(authorization).unwrap();
    (client, session, reservation, server, directory)
}
fn read(reader: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(!line.is_empty());
    serde_json::from_str(&line).unwrap()
}
fn send(stream: &mut UnixStream, value: Value) {
    serde_json::to_writer(&mut *stream, &value).unwrap();
    stream.write_all(b"\n").unwrap();
    stream.flush().unwrap();
}
fn serve(listener: UnixListener, scenario: Scenario) -> usize {
    let (stream, _) = listener.accept().unwrap();
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);
    let attach = read(&mut reader);
    if matches!(scenario, Scenario::PartialAttachment) {
        writer.write_all(b"{\"v\":1").unwrap();
        writer.flush().unwrap();
        return 1;
    }
    send(
        &mut writer,
        json!({"v":1,"kind":"attached","sessionId":attach["sessionId"],"workerId":attach["workerId"]}),
    );
    if matches!(scenario, Scenario::EofAfterAttach) {
        return 1;
    }
    let hello = read(&mut reader);
    send(
        &mut writer,
        json!({"v":1,"id":hello["id"],"ok":true,"result":{"interfaceDigest":hello["interfaceDigest"],"runtime":if matches!(scenario,Scenario::WrongHello){"rust-v1"}else{"node-v1"}}}),
    );
    if matches!(scenario, Scenario::WrongHello) {
        return 2;
    }
    let create = read(&mut reader);
    send(
        &mut writer,
        json!({"v":1,"id":create["id"],"ok":true,"result":if matches!(scenario,Scenario::BadCreate){json!({})}else{Value::Null}}),
    );
    if matches!(scenario, Scenario::BadCreate) {
        return 3;
    }
    let invoke = read(&mut reader);
    if matches!(scenario, Scenario::EofDuringInvoke) {
        return 4;
    }
    if matches!(scenario, Scenario::Cancel) {
        let cancel = read(&mut reader);
        send(
            &mut writer,
            json!({"v":1,"id":invoke["id"],"ok":false,"error":{"code":"CANCELLED","message":"cancelled"}}),
        );
        send(
            &mut writer,
            json!({"v":1,"id":cancel["id"],"ok":true,"result":null}),
        );
        return 5;
    }
    send(
        &mut writer,
        json!({"v":1,"id":invoke["id"],"ok":true,"result":null}),
    );
    let observe = read(&mut reader);
    if matches!(scenario, Scenario::Success) {
        send(
            &mut writer,
            json!({"v":1,"id":observe["id"],"ok":true,"result":{"Count":{"#bigint":"0"}}}),
        );
        return 5;
    }
    send(
        &mut writer,
        json!({"v":1,"id":observe["id"],"ok":true,"result":{"Wrong":{"#bigint":"0"}}}),
    );
    5
}

#[test]
fn cancellation_before_dispatch_sends_no_frame_and_leaves_worker_usable() {
    let (client, _session, reservation, server, directory) = setup(Scenario::Success, false);
    let mut worker = reservation
        .connect(
            PublicManifest::from_exact_json(MANIFEST).unwrap(),
            "node-v1",
            WorkerOptions::default(),
        )
        .unwrap();
    let token = CancellationToken::default();
    token.cancel();
    let error = worker
        .invoke(
            "Initialize",
            &BTreeMap::new(),
            WorkerCallOptions {
                timeout: Duration::from_secs(1),
                cancellation: Some(token),
            },
        )
        .unwrap_err();
    assert!(matches!(error.kind, ErrorKind::Cancelled));
    worker
        .invoke("Initialize", &BTreeMap::new(), WorkerCallOptions::default())
        .unwrap();
    let observation = worker.observe(WorkerCallOptions::default()).unwrap();
    assert!(observation.contains_key("Count"));
    let report = worker.finish("normal");
    assert!(report.primary.is_none() && report.cleanup_confirmed());
    assert_eq!(server.join().unwrap(), 5);
    assert!(client.close().process_shutdown_confirmed());
    cleanup_path(&directory);
}
fn cleanup_path(directory: &PathBuf) {
    let _ = std::fs::remove_file(directory.join("worker.sock"));
    let _ = std::fs::remove_dir(directory);
}

#[test]
fn cancellation_and_deadline_preserve_order_and_confirm_cleanup() {
    for deadline in [false, true] {
        let (client, _session, reservation, server, directory) = setup(Scenario::Cancel, false);
        let mut worker = reservation
            .connect(
                PublicManifest::from_exact_json(MANIFEST).unwrap(),
                "node-v1",
                WorkerOptions::default(),
            )
            .unwrap();
        let token = CancellationToken::default();
        if !deadline {
            let cancel = token.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(30));
                cancel.cancel();
            });
        }
        let call = WorkerCallOptions {
            timeout: if deadline {
                Duration::from_millis(30)
            } else {
                Duration::from_secs(1)
            },
            cancellation: if deadline { None } else { Some(token) },
        };
        let error = worker
            .invoke("Initialize", &BTreeMap::new(), call)
            .unwrap_err();
        assert!(matches!(
            error.kind,
            ErrorKind::Cancelled | ErrorKind::Deadline
        ));
        let report = worker.finish(if deadline { "deadline" } else { "user-cancel" });
        assert!(report.primary.is_some() && report.cleanup_confirmed());
        assert_eq!(server.join().unwrap(), 5);
        assert!(client.close().process_shutdown_confirmed());
        cleanup_path(&directory);
    }
}

#[test]
fn worker_eof_wrong_hello_and_bad_create_release_partial_worker() {
    for scenario in [
        Scenario::PartialAttachment,
        Scenario::EofAfterAttach,
        Scenario::WrongHello,
        Scenario::BadCreate,
    ] {
        let (client, session, reservation, server, directory) = setup(scenario, false);
        assert!(
            reservation
                .connect(
                    PublicManifest::from_exact_json(MANIFEST).unwrap(),
                    "node-v1",
                    WorkerOptions::default()
                )
                .is_err()
        );
        let joined = session
            .close(None)
            .unwrap()
            .wait(Duration::from_secs(1))
            .unwrap();
        assert!(matches!(joined, OperationOutcome::Succeeded(_)));
        server.join().unwrap();
        assert!(client.close().process_shutdown_confirmed());
        cleanup_path(&directory);
    }
}

#[test]
fn eof_during_invoke_poisons_worker_and_confirms_cleanup() {
    let (client, _session, reservation, server, directory) =
        setup(Scenario::EofDuringInvoke, false);
    let mut worker = reservation
        .connect(
            PublicManifest::from_exact_json(MANIFEST).unwrap(),
            "node-v1",
            WorkerOptions::default(),
        )
        .unwrap();
    assert!(
        worker
            .invoke("Initialize", &BTreeMap::new(), WorkerCallOptions::default())
            .is_err()
    );
    assert!(
        worker
            .invoke("Initialize", &BTreeMap::new(), WorkerCallOptions::default())
            .is_err()
    );
    let report = worker.finish("worker-failure");
    assert!(report.primary.is_some() && report.cleanup_confirmed());
    assert_eq!(server.join().unwrap(), 4);
    assert!(client.close().process_shutdown_confirmed());
    cleanup_path(&directory);
}

#[test]
fn malformed_observe_poisons_worker_and_retains_primary_over_cleanup_failure() {
    let (client, _session, reservation, server, directory) = setup(Scenario::BadObserve, true);
    let mut worker = reservation
        .connect(
            PublicManifest::from_exact_json(MANIFEST).unwrap(),
            "node-v1",
            WorkerOptions::default(),
        )
        .unwrap();
    worker
        .invoke("Initialize", &BTreeMap::new(), WorkerCallOptions::default())
        .unwrap();
    assert!(worker.observe(WorkerCallOptions::default()).is_err());
    assert!(
        worker
            .invoke("Initialize", &BTreeMap::new(), WorkerCallOptions::default())
            .is_err()
    );
    let report = worker.finish("worker-failure");
    assert!(report.primary.is_some());
    assert!(matches!(report.cleanup, Some(OperationOutcome::Failed(_))));
    assert!(!report.cleanup_confirmed());
    assert_eq!(server.join().unwrap(), 5);
    assert!(client.close().process_shutdown_confirmed());
    cleanup_path(&directory);
}

fn unique_temp() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    std::env::temp_dir().join(format!(
        "mirrorgate-managed-worker-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}
