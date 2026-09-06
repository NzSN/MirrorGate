use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

const DIGEST: &str = "193d6cc187d05c18f02ad483a44f8ad0c1634b02083df241df08b9281b045d1c";
fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance/manifests/counter.json")
}
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    responses: mpsc::Receiver<String>,
    next: u64,
    audit: Option<PathBuf>,
}
impl Session {
    fn new(fixture: Option<&str>, faulty: bool) -> Self {
        let audit = fixture.map(|_| {
            std::env::temp_dir().join(format!(
                "mirrorgate-rust-audit-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ))
        });
        let mut command = Command::new(if fixture.is_some() {
            env!("CARGO_BIN_EXE_mirrorgate-sdk-fixture")
        } else {
            env!("CARGO_BIN_EXE_mirrorgate-counter-worker")
        });
        if let Some(mode) = fixture {
            command
                .arg(manifest())
                .arg(mode)
                .arg(audit.as_ref().unwrap());
        } else {
            command.arg("--manifest").arg(manifest());
            if faulty {
                command.arg("--faulty");
            }
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (sender, responses) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            child,
            stdin,
            responses,
            next: 1,
            audit,
        }
    }
    fn send(&mut self, mut request: Value) -> u64 {
        let id = self.next;
        self.next += 1;
        request["v"] = json!(1);
        request["id"] = json!(id);
        self.raw(&format!("{}\n", request));
        id
    }
    fn raw(&mut self, bytes: &str) {
        self.stdin
            .as_mut()
            .unwrap()
            .write_all(bytes.as_bytes())
            .unwrap();
        self.stdin.as_mut().unwrap().flush().unwrap();
    }
    fn receive(&self) -> Value {
        serde_json::from_str(
            &self
                .responses
                .recv_timeout(Duration::from_secs(5))
                .expect("worker response deadline"),
        )
        .unwrap()
    }
    fn call(&mut self, request: Value) -> Value {
        let id = self.send(request);
        let result = self.receive();
        assert_eq!(result["id"], id);
        result
    }
    fn ok(&mut self, request: Value) -> Value {
        let result = self.call(request);
        assert_eq!(result["ok"], true, "{result}");
        result["result"].clone()
    }
    fn hello(&mut self) {
        self.ok(json!({"op":"hello","interfaceDigest":DIGEST,"runtime":"rust-v1"}));
    }
    fn create(&mut self) {
        self.hello();
        self.ok(json!({"op":"create"}));
    }
    fn initialize(&mut self) {
        self.ok(json!({"op":"invoke","action":"Initialize","inputs":{}}));
    }
    fn ready(&mut self) {
        self.create();
        self.initialize();
        self.ok(json!({"op":"observe"}));
    }
    fn audit(&self) -> String {
        fs::read_to_string(self.audit.as_ref().unwrap()).unwrap_or_default()
    }
    fn wait_audit(&self, event: &str) {
        let start = Instant::now();
        while !self.audit().lines().any(|line| line == event) {
            assert!(
                start.elapsed() < Duration::from_secs(3),
                "missing audit event {event}"
            );
            thread::sleep(Duration::from_millis(2));
        }
    }
    fn wait_exit(&mut self) -> bool {
        let start = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.success();
            }
            assert!(
                start.elapsed() < Duration::from_secs(3),
                "worker termination deadline"
            );
            thread::sleep(Duration::from_millis(2));
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(audit) = &self.audit {
            let _ = fs::remove_file(audit);
        }
    }
}

#[test]
fn real_counter_preserves_large_integers_and_reset() {
    let mut session = Session::new(None, false);
    session.ready();
    let huge = "9007199254740993123456789012345678901234567890";
    session.ok(json!({"op":"invoke","action":"Tick","inputs":{"Stride":{"#bigint":huge}}}));
    assert_eq!(
        session.ok(json!({"op":"observe"}))["Count"]["#bigint"],
        huge
    );
    session.initialize();
    assert_eq!(session.ok(json!({"op":"observe"}))["Count"]["#bigint"], "0");
    session.ok(json!({"op":"dispose"}));
    assert!(session.wait_exit());
}

#[test]
fn faulty_counter_reports_actual_wrong_state() {
    let mut session = Session::new(None, true);
    session.ready();
    session.ok(json!({"op":"invoke","action":"Tick","inputs":{"Stride":{"#bigint":"2"}}}));
    assert_eq!(session.ok(json!({"op":"observe"}))["Count"]["#bigint"], "1");
    session.ok(json!({"op":"dispose"}));
}

#[test]
fn admission_precedes_creation_and_failed_hello_does_not_construct() {
    let mut session = Session::new(Some("normal"), false);
    session.hello();
    assert_eq!(session.audit(), "");
    session.ok(json!({"op":"dispose"}));
    assert_eq!(session.audit(), "");
    let mut session = Session::new(Some("normal"), false);
    assert_eq!(
        session.call(json!({"op":"hello","interfaceDigest":"0".repeat(64),"runtime":"rust-v1"}))["error"]
            ["code"],
        "HANDSHAKE"
    );
    assert_eq!(
        session.call(json!({"op":"create"}))["error"]["code"],
        "LIFECYCLE"
    );
    session.ok(json!({"op":"dispose"}));
    assert_eq!(session.audit(), "");
}

#[test]
fn invalid_input_never_reaches_adapter_and_poison_requires_dispose() {
    let mut session = Session::new(Some("normal"), false);
    session.ready();
    assert_eq!(
        session.call(json!({"op":"invoke","action":"Tick","inputs":{"Stride":2}}))["error"]["code"],
        "VALUE"
    );
    assert!(!session.audit().contains("Tick"));
    assert_eq!(
        session.call(json!({"op":"observe"}))["error"]["code"],
        "LIFECYCLE"
    );
    session.ok(json!({"op":"dispose"}));
    assert_eq!(
        session.audit().lines().filter(|s| *s == "dispose").count(),
        1
    );
}

#[test]
fn every_invocation_requires_one_observation() {
    let mut session = Session::new(Some("normal"), false);
    session.create();
    session.initialize();
    assert_eq!(
        session.call(json!({"op":"invoke","action":"Tick","inputs":{"Stride":{"#bigint":"2"}}}))["error"]
            ["code"],
        "LIFECYCLE"
    );
    assert!(!session.audit().contains("Tick"));
    session.ok(json!({"op":"dispose"}));
}

#[test]
fn callback_failure_and_panic_poison_the_binding() {
    for mode in ["failure", "panic"] {
        let mut session = Session::new(Some(mode), false);
        session.ready();
        assert_eq!(
            session
                .call(json!({"op":"invoke","action":"Tick","inputs":{"Stride":{"#bigint":"2"}}}))["error"]
                ["code"],
            "APPLICATION"
        );
        assert_eq!(
            session.call(json!({"op":"observe"}))["error"]["code"],
            "LIFECYCLE"
        );
        session.ok(json!({"op":"dispose"}));
    }
}

#[test]
fn observation_type_and_resource_limits_are_enforced() {
    for mode in ["invalid", "huge"] {
        let mut session = Session::new(Some(mode), false);
        session.create();
        session.initialize();
        assert_eq!(
            session.call(json!({"op":"observe"}))["error"]["code"],
            "VALUE"
        );
        session.ok(json!({"op":"dispose"}));
    }
}

#[test]
fn cancellation_is_responsive_correlated_and_cleanup_waits_for_quiescence() {
    let mut session = Session::new(Some("slow"), false);
    session.ready();
    let pending =
        session.send(json!({"op":"invoke","action":"Tick","inputs":{"Stride":{"#bigint":"2"}}}));
    session.wait_audit("Tick");
    let started = Instant::now();
    let cancel = session.send(json!({"op":"cancel","requestId":pending}));
    let first = session.receive();
    assert_eq!(first["id"], pending);
    assert_eq!(first["error"]["code"], "CANCELLED");
    let second = session.receive();
    assert_eq!(second["id"], cancel);
    assert_eq!(second["ok"], true);
    assert!(started.elapsed() < Duration::from_secs(1));
    session.ok(json!({"op":"dispose"}));
    assert!(session.audit().ends_with("quiescent\ndispose\n"));
    assert!(session.wait_exit());
    assert!(
        session.responses.try_recv().is_err(),
        "cancelled operation emitted duplicate response"
    );
}

#[test]
fn failed_dispose_is_terminal_and_not_retried() {
    let mut session = Session::new(Some("dispose-failure"), false);
    session.ready();
    assert_eq!(
        session.call(json!({"op":"dispose"}))["error"]["code"],
        "APPLICATION"
    );
    assert!(session.wait_exit());
    assert_eq!(
        session
            .audit()
            .lines()
            .filter(|line| *line == "dispose")
            .count(),
        1
    );
}

#[test]
fn duplicate_json_keys_and_reused_ids_close_the_channel() {
    let mut session = Session::new(None, false);
    session.raw("{\"v\":1,\"id\":1,\"id\":2,\"op\":\"create\"}\n");
    assert!(!session.wait_exit());
    assert!(session.responses.try_recv().is_err());
    let mut session = Session::new(None, false);
    session.hello();
    session.raw("{\"v\":1,\"id\":1,\"op\":\"create\"}\n");
    assert!(!session.wait_exit());
}
