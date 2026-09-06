use mirrorgate_worker::{Adapter, CancellationToken, Manifest, WorkerError, run_worker};
use num_bigint::BigInt;
use serde_json::{Value, json};
use std::{env, process};

/// Actual SUT: adapter observations below read this field directly.
struct Counter {
    count: BigInt,
    faulty: bool,
}
impl Counter {
    fn reset(&mut self) {
        self.count = BigInt::from(0);
    }
    fn increment(&mut self, stride: BigInt) {
        self.count += if self.faulty { stride - 1 } else { stride };
    }
}
struct CounterAdapter {
    counter: Counter,
}
impl Adapter for CounterAdapter {
    fn invoke(
        &mut self,
        action: &str,
        inputs: &Value,
        cancellation: &CancellationToken,
    ) -> Result<(), WorkerError> {
        cancellation.check()?;
        match action {
            "Initialize" => self.counter.reset(),
            "Tick" => {
                let decimal = inputs["Stride"]["#bigint"]
                    .as_str()
                    .ok_or("Stride requires bigint")?;
                let stride = decimal
                    .parse::<BigInt>()
                    .map_err(|_| WorkerError::new("invalid Stride integer"))?;
                self.counter.increment(stride);
            }
            _ => return Err("unsupported Counter action".into()),
        }
        Ok(())
    }
    fn observe(&mut self, cancellation: &CancellationToken) -> Result<Value, WorkerError> {
        cancellation.check()?;
        Ok(json!({"Count":{"#bigint":self.counter.count.to_string()}}))
    }
}

fn main() {
    if let Err(error) = start() {
        eprintln!("MirrorGate Rust worker: {error}");
        process::exit(1);
    }
}

fn start() -> Result<(), String> {
    let mut manifest_path = None;
    let mut faulty = false;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--manifest" if manifest_path.is_none() => {
                manifest_path = Some(args.next().ok_or("--manifest requires path")?)
            }
            "--faulty" if !faulty => faulty = true,
            _ => return Err("usage: mirrorgate-counter-worker --manifest PATH [--faulty]".into()),
        }
    }
    let manifest = Manifest::load(manifest_path.ok_or("--manifest is required")?)?;
    // This executable links one concrete adapter. The reusable SDK accepts any
    // admitted manifest and trait implementation; this adapter requires Counter.
    if manifest
        .initializers
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>()
        != ["Initialize"]
        || manifest
            .actions
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>()
            != ["Tick"]
        || manifest
            .observations
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>()
            != ["Count"]
    {
        return Err("Counter requires Initialize, Tick, and Count IDs".into());
    }
    if !manifest.initializers["Initialize"].inputs.is_empty()
        || manifest.actions["Tick"].inputs.len() != 1
        || manifest.actions["Tick"].inputs.get("Stride")
            != Some(&mirrorgate_worker::value::Type::Int)
        || manifest.observations["Count"] != mirrorgate_worker::value::Type::Int
    {
        return Err("Counter requires empty Initialize inputs, int Stride, and int Count".into());
    }
    run_worker(manifest, "rust-v1", move |_, cancellation| {
        cancellation.check()?;
        Ok(Box::new(CounterAdapter {
            counter: Counter {
                count: BigInt::from(0),
                faulty,
            },
        }))
    })
}
