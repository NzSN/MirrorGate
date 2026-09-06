//! Controlled SDK behavior fixture, not an application submission example.
use mirrorgate_worker::{Adapter, CancellationToken, Manifest, WorkerError, run_worker};
use serde_json::{Value, json};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    thread,
    time::Duration,
};

struct Fixture {
    mode: String,
    audit: PathBuf,
}
fn record(path: &PathBuf, message: &str) {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    writeln!(file, "{message}").unwrap();
}
impl Adapter for Fixture {
    fn invoke(
        &mut self,
        action: &str,
        _: &Value,
        cancellation: &CancellationToken,
    ) -> Result<(), WorkerError> {
        record(&self.audit, action);
        if action == "Tick" {
            match self.mode.as_str() {
                "failure" => return Err("intentional callback failure".into()),
                "panic" => panic!("intentional callback panic"),
                "slow" => {
                    while !cancellation.is_cancelled() {
                        thread::sleep(Duration::from_millis(2));
                    }
                    record(&self.audit, "quiescent");
                    return Err("cancelled callback".into());
                }
                _ => {}
            }
        }
        Ok(())
    }
    fn observe(&mut self, _: &CancellationToken) -> Result<Value, WorkerError> {
        record(&self.audit, "observe");
        Ok(match self.mode.as_str() {
            "invalid" => json!({"Count":1}),
            "huge" => json!({"Count":{"#bigint":"1".repeat(70_000)}}),
            _ => json!({"Count":{"#bigint":"0"}}),
        })
    }
    fn dispose(&mut self, _: &CancellationToken) -> Result<(), WorkerError> {
        record(&self.audit, "dispose");
        if self.mode == "dispose-failure" {
            Err("intentional dispose failure".into())
        } else {
            Ok(())
        }
    }
}
fn main() {
    let args: Vec<_> = env::args().collect();
    let manifest = Manifest::from_bytes(&fs::read(&args[1]).unwrap()).unwrap();
    let mode = args[2].clone();
    let audit = PathBuf::from(&args[3]);
    let result = run_worker(manifest, "rust-v1", move |_, _| {
        record(&audit, "create");
        if mode == "create-failure" {
            return Err("intentional create failure".into());
        }
        Ok(Box::new(Fixture { mode, audit }))
    });
    if let Err(error) = result {
        eprintln!("fixture: {error}");
        std::process::exit(1);
    }
}
