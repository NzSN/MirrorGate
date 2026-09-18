use mirrorgate_mirrorrust_integration::{
    COUNTER_CONTRACT, COUNTER_FIXTURE_TARGET, COUNTER_SEMANTIC_DIGEST, ControlMode, ReplayMode,
    SandboxPlan, run_counter_sandboxed,
};
use mirrorrust::{ApalacheConfig, Error, GeneratedModelInterface, as_int};
use serde_json::json;
use std::env;
use std::fs;
use std::path::PathBuf;

fn require(condition: bool, message: impl Into<String>) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    require(
        args.len() == 12,
        "usage: mirrorgate-mirrorrust-counter owned|attached GATE_OR_SOCKET POLICY POLICY_ID MANIFEST SUBMISSION RUNTIME MIRROR SPEC TRACE correct|faulty|wrong-digest|generate-correct|generate-faulty",
    )?;
    let mode = match args[1].as_str() {
        "owned" => ControlMode::Owned,
        "attached" => ControlMode::Attached,
        _ => return Err("invalid control mode".into()),
    };
    let expected = args[11].as_str();
    require(
        matches!(
            expected,
            "correct" | "faulty" | "wrong-digest" | "generate-correct" | "generate-faulty"
        ),
        "invalid expected outcome",
    )?;
    let generated = expected.starts_with("generate-");
    let sut = expected.strip_prefix("generate-").unwrap_or(expected);
    let mut manifest_json = fs::read_to_string(&args[5]).map_err(|error| error.to_string())?;
    let semantic_digest = if sut == "wrong-digest" {
        let mut manifest: serde_json::Value =
            serde_json::from_str(&manifest_json).map_err(|error| error.to_string())?;
        manifest["interfaceDigest"] = json!("b".repeat(64));
        manifest_json = serde_json::to_string(&manifest).map_err(|error| error.to_string())?;
        "b".repeat(64)
    } else {
        COUNTER_SEMANTIC_DIGEST.into()
    };
    let config = ApalacheConfig {
        spec_path: args[9].clone(),
        init_predicate: None,
        next_predicate: None,
        const_init: Some("CInit".into()),
        invariant: "TraceComplete".into(),
        length_bound: 6,
        param_vars: Some("parameters".into()),
    };
    let private_model_revision = env::var("MIRRORGATE_PRIVATE_CANARY").ok();
    let plan = SandboxPlan {
        control_mode: mode,
        gate_or_socket: PathBuf::from(&args[2]),
        policy_file: PathBuf::from(&args[3]),
        policy_id: args[4].clone(),
        manifest_json,
        submission_path: args[6].clone(),
        runtime: args[7].clone(),
        adapter_id: format!("mirrorgate/{}", args[7]),
        target_profile: COUNTER_FIXTURE_TARGET.into(),
        replay_mode: if generated {
            ReplayMode::Generate
        } else {
            ReplayMode::Traces
        },
        trace_generation: generated.then(|| mirrorrust::TraceGenerationConfig {
            num_traces: 1,
            view: Some("View".into()),
        }),
        private_model_revision,
    };
    let outcome = run_counter_sandboxed(
        &args[8],
        config,
        args[10].clone(),
        GeneratedModelInterface {
            semantic_digest,
            contract_json: COUNTER_CONTRACT.into(),
        },
        plan,
    );
    let result_status = if outcome.result.is_ok() {
        "passed"
    } else if sut == "wrong-digest" {
        "negotiation-rejected"
    } else {
        "mismatch"
    };
    if sut == "wrong-digest" {
        require(
            matches!(&outcome.result, Err(Error::Registration { code, .. }) if code == "interface_digest_mismatch"),
            format!(
                "wrong digest was not rejected by Mirrors: {:?}",
                outcome.result
            ),
        )?;
        require(
            outcome.evidence.binding_factory_calls == 0
                && outcome.evidence.worker_acquisitions == 0
                && outcome.evidence.worker_started_events == 0
                && outcome.evidence.adapter_dispatches == 0,
            "failed negotiation reached binding or worker",
        )?;
    } else {
        require(
            outcome.evidence.binding_factory_calls == 1,
            "binding factory was not called exactly once",
        )?;
        require(
            outcome.evidence.worker_acquisitions == 1,
            "worker was not acquired exactly once",
        )?;
        require(
            outcome.evidence.worker_started_events == 1,
            "Gate did not report exactly one worker start",
        )?;
    }
    if sut == "correct" {
        require(
            outcome.result.is_ok(),
            format!("correct SUT failed: {:?}", outcome.result),
        )?;
    }
    if sut == "faulty" {
        match &outcome.result {
            Err(Error::StepMismatch {
                expected, actual, ..
            }) => {
                let expected = expected
                    .get("count")
                    .and_then(as_int)
                    .ok_or("faulty mismatch lacks expected count")?;
                let actual = actual
                    .get("count")
                    .and_then(as_int)
                    .ok_or("faulty mismatch lacks actual count")?;
                require(
                    expected - actual == 1.into(),
                    "faulty Counter mismatch did not lag expected count by one",
                )?;
            }
            result => {
                return Err(format!(
                    "faulty SUT did not produce a real step mismatch: {result:?}"
                ));
            }
        }
    }
    require(
        outcome.evidence.cleanup_confirmed,
        format!("cleanup unconfirmed: {}", outcome.evidence.cleanup_error),
    )?;
    require(
        outcome.evidence.control_shutdown_confirmed,
        "control shutdown unconfirmed",
    )?;
    println!(
        "{}",
        json!({
            "schema":"mirrors.shared-orchestration-evidence/v1", "facade":"mirrorrust", "evaluatorLanguage":"rust",
            "controlMode":args[1], "controlVersion":1, "workerRuntime":args[7], "workerVersion":1,
            "backend":"linux-bubblewrap-v1", "sut":expected, "resultStatus":result_status,
            "replay":if generated {"generate"} else {"traces"}, "cleanup":"succeeded", "controlShutdown":"confirmed",
            "controlProcessState":outcome.evidence.control_process_state, "bindingFactoryCalls":outcome.evidence.binding_factory_calls,
            "workerAcquisitions":outcome.evidence.worker_acquisitions, "workerStartedEvents":outcome.evidence.worker_started_events,
            "adapterDispatches":outcome.evidence.adapter_dispatches, "nodeEvaluator":false, "mirrorEcmaDependency":false
        })
    );
    Ok(())
}
