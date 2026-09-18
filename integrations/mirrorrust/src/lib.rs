//! Optional trusted composition of MirrorRust and the MirrorGate Rust SDK.
//!
//! MirrorRust remains Gate-independent.  This module prepares an admitted Gate
//! session before registration, but authorization and worker acquisition occur
//! only inside MirrorRust's unforgeable post-match factory callback.

use mirrorgate_sdk::{
    CleanupStatus, ClientOptions, ControlClient, ControlCloseReceipt, ControlEvent,
    ControllerCommand, Error as GateError, ErrorKind as GateErrorKind, InputRef, ManagedWorker,
    OpenSession, OperationOutcome, OutcomeStatus, OutcomeSummary, Prepared, ProcessCloseState,
    PublicManifest, RequiredMatchAttestation, Session, SessionPhase, Submission,
    Value as GateValue, WorkerCallOptions, WorkerOptions,
};
use mirrorrust::{
    ApalacheConfig, BindingError, CompiledAdapterKey, CompiledAdapterRegistration,
    CompiledAdapterRegistry, CompiledAdapterSelection, GeneratedModelInterface, LocalBinding,
    MODEL_INTERFACE_DESCRIPTOR_SCHEMA, NegotiationPolicy, STATE_COMPUTER_CONTRACT_VERSION,
    SemanticDigest, State, TraceGenerationConfig, Value, as_int, get_param,
};
use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const COUNTER_SEMANTIC_DIGEST: &str =
    "193d6cc187d05c18f02ad483a44f8ad0c1634b02083df241df08b9281b045d1c";
pub const COUNTER_FIXTURE_TARGET: &str = "mirrorrust-counter-fixture-v1";
pub const COUNTER_CONTRACT: &str = r#"{"actions":[{"id":"Tick","inputs":[{"from":{"path":[{"field":"parameters"},{"field":"stride"}],"root":"stepParameters"},"id":"Stride"}],"wireAction":"tick","wireAliases":[]}],"initializers":[{"id":"Initialize","inputs":[],"wireAction":"init","wireAliases":[]}],"interfaceVersion":"1.0.0","model":{"module":"Counter","source":"specs/Counter.tla"},"observations":[{"id":"Count","provenance":"implementation","wireName":"count"}],"schema":"mirrors.model-interface/v1","wire":{"actionVariable":"action_taken","parameterVariable":"parameters"}}"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlMode {
    Owned,
    Attached,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplayMode {
    Traces,
    Generate,
}

#[derive(Clone, Debug)]
pub struct SandboxPlan {
    pub control_mode: ControlMode,
    pub gate_or_socket: PathBuf,
    pub policy_file: PathBuf,
    pub policy_id: String,
    pub manifest_json: String,
    pub submission_path: String,
    pub runtime: String,
    pub adapter_id: String,
    pub target_profile: String,
    pub replay_mode: ReplayMode,
    /// Required only for `ReplayMode::Generate`; supplied by the model-specific caller.
    pub trace_generation: Option<TraceGenerationConfig>,
    pub private_model_revision: Option<String>,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxEvidence {
    pub binding_factory_calls: usize,
    pub worker_acquisitions: usize,
    pub worker_started_events: usize,
    pub adapter_dispatches: usize,
    pub cleanup_confirmed: bool,
    pub cleanup_error: String,
    pub control_shutdown_confirmed: bool,
    pub control_process_state: String,
}

pub struct SandboxOutcome {
    pub result: Result<(), mirrorrust::Error>,
    pub evidence: SandboxEvidence,
}

pub type WorkerBindingFactory =
    Box<dyn FnMut(ManagedWorker, &ApalacheConfig) -> Result<LocalBinding, BindingError>>;

fn local_error(code: impl Into<String>, message: impl Into<String>) -> mirrorrust::Error {
    mirrorrust::Error::ModelInterface {
        code: code.into(),
        message: message.into(),
    }
}

fn gate_code(error: &GateError) -> String {
    match &error.kind {
        GateErrorKind::Server(server) => format!("mirrorgate.{}", server.code.to_ascii_lowercase()),
        GateErrorKind::Argument => "mirrorgate.argument".into(),
        GateErrorKind::Limit => "mirrorgate.limit".into(),
        GateErrorKind::Protocol => "mirrorgate.protocol".into(),
        GateErrorKind::Transport => "mirrorgate.transport".into(),
        GateErrorKind::Disconnected => "mirrorgate.disconnected".into(),
        GateErrorKind::Deadline => "mirrorgate.deadline".into(),
        GateErrorKind::Handle => "mirrorgate.handle".into(),
        GateErrorKind::Cancelled => "mirrorgate.cancelled".into(),
        GateErrorKind::Worker => "mirrorgate.worker".into(),
    }
}

fn gate_binding_error(error: GateError) -> BindingError {
    BindingError::new(gate_code(&error), error.to_string())
}

fn gate_model_error(error: GateError) -> mirrorrust::Error {
    local_error(gate_code(&error), error.to_string())
}

fn wait_prepared(operation: &mirrorgate_sdk::Operation<Prepared>) -> Result<Prepared, GateError> {
    match operation.wait(Duration::from_secs(30))? {
        OperationOutcome::Succeeded(prepared) => Ok(prepared),
        OperationOutcome::Failed(error) => Err(GateError {
            kind: GateErrorKind::Server(error.clone()),
            message: error.message,
        }),
        OperationOutcome::Pending => unreachable!("wait never returns pending"),
    }
}

fn required_capabilities(plan: &SandboxPlan) -> Vec<String> {
    vec![
        match plan.control_mode {
            ControlMode::Owned => "control.local-stdio-v1",
            ControlMode::Attached => "control.local-unix-v1",
        }
        .into(),
        "submission.prebuilt-v1".into(),
        "execution.compiled-verify-v1".into(),
        "worker.managed-unix-v1".into(),
        format!("worker.{}", plan.runtime),
        "backend.linux-bubblewrap-v1".into(),
        "cleanup.bounded-attempt-v1".into(),
    ]
}

fn open_control(plan: &SandboxPlan) -> Result<ControlClient, GateError> {
    let options = ClientOptions {
        required_capabilities: required_capabilities(plan),
        ..ClientOptions::default()
    };
    match plan.control_mode {
        ControlMode::Owned => ControlClient::launch(
            ControllerCommand {
                program: plan.gate_or_socket.clone(),
                args: vec![
                    "control".into(),
                    "--stdio".into(),
                    "--policy-file".into(),
                    plan.policy_file.to_string_lossy().into_owned(),
                ],
                cwd: None,
                env: None,
            },
            options,
        ),
        ControlMode::Attached => ControlClient::connect_unix(&plan.gate_or_socket, options),
    }
}

fn process_state(receipt: &ControlCloseReceipt) -> &'static str {
    match receipt.process_state {
        ProcessCloseState::NotOwned => "not-owned",
        ProcessCloseState::Exited(_) => "exited",
        ProcessCloseState::Signaled(_) => "signaled",
        ProcessCloseState::ReapedUnknown => "reaped-unknown",
        ProcessCloseState::Unconfirmed => "unconfirmed",
    }
}

fn note_cleanup_error(evidence: &Arc<Mutex<SandboxEvidence>>, detail: impl Into<String>) {
    let detail = detail.into();
    let mut observed = evidence.lock().expect("evidence mutex poisoned");
    if !observed.cleanup_error.is_empty() {
        observed.cleanup_error.push_str("; ");
    }
    observed.cleanup_error.push_str(&detail);
}

fn cleanup_failure(
    evidence: &Arc<Mutex<SandboxEvidence>>,
    error: mirrorrust::Error,
) -> mirrorrust::Error {
    note_cleanup_error(evidence, error.to_string());
    error
}

fn observe_binding_disposal(
    mut binding: LocalBinding,
    evidence: Arc<Mutex<SandboxEvidence>>,
) -> LocalBinding {
    let mut dispose = std::mem::replace(&mut binding.dispose, Box::new(|| Ok(())));
    binding.dispose = Box::new(move || {
        let result = catch_unwind(AssertUnwindSafe(&mut dispose))
            .map_err(|_| BindingError::new("adapter_dispose_failed", "binding disposal panicked"))
            .and_then(|result| result);
        if let Err(error) = &result {
            note_cleanup_error(&evidence, format!("binding disposal: {error}"));
        }
        result
    });
    binding
}

fn record_cleanup(
    session: &Session,
    primary: &Result<(), mirrorrust::Error>,
    evidence: &Arc<Mutex<SandboxEvidence>>,
) -> Result<(), mirrorrust::Error> {
    let summary = OutcomeSummary {
        status: match primary {
            Ok(()) => OutcomeStatus::Passed,
            Err(mirrorrust::Error::StepMismatch { .. }) => OutcomeStatus::Mismatch,
            Err(_) => OutcomeStatus::Failed,
        },
        failure_family: primary.as_ref().err().map(|error| match error {
            mirrorrust::Error::StepMismatch { .. } => "step_mismatch".into(),
            mirrorrust::Error::Registration { .. } | mirrorrust::Error::RegisterFailed(_) => {
                "registration".into()
            }
            mirrorrust::Error::ProtocolError(_) | mirrorrust::Error::UnexpectedMessage(_) => {
                "protocol".into()
            }
            _ => "model_interface".into(),
        }),
    };
    let operation = session
        .close(Some(summary))
        .map_err(gate_model_error)
        .map_err(|error| cleanup_failure(evidence, error))?;
    let result = operation
        .wait(Duration::from_secs(10))
        .map_err(gate_model_error)
        .map_err(|error| cleanup_failure(evidence, error))?;
    let cleanup = match result {
        OperationOutcome::Succeeded(cleanup) => cleanup,
        OperationOutcome::Failed(error) => {
            return Err(cleanup_failure(
                evidence,
                local_error(
                    format!("mirrorgate.{}", error.code.to_ascii_lowercase()),
                    error.message,
                ),
            ));
        }
        OperationOutcome::Pending => unreachable!("wait never returns pending"),
    };
    let confirmed = cleanup.phase == SessionPhase::Closed
        && cleanup.cleanup_status == CleanupStatus::Succeeded
        && cleanup.remaining_resources.is_empty();
    let mut observed = evidence.lock().expect("evidence mutex poisoned");
    observed.cleanup_confirmed = confirmed;
    if !confirmed {
        observed.cleanup_error = format!("Gate cleanup was not confirmed: {cleanup:?}");
    }
    if confirmed {
        Ok(())
    } else {
        Err(local_error(
            "mirrorgate.cleanup_failed",
            observed.cleanup_error.clone(),
        ))
    }
}

fn counter_binding(
    worker: ManagedWorker,
    canonical_digest: SemanticDigest,
    dispatches: Arc<std::sync::atomic::AtomicUsize>,
) -> LocalBinding {
    let worker = Arc::new(Mutex::new(Some(worker)));
    let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let computer_worker = worker.clone();
    let computer_failed = failed.clone();
    let computer_dispatches = dispatches;
    let dispose_worker = worker.clone();
    LocalBinding {
        semantic_digest: canonical_digest,
        assert_compatible_config: Box::new(|config| {
            if config.param_vars.as_deref() == Some("parameters") {
                Ok(())
            } else {
                Err(BindingError::new(
                    "configuration_mismatch",
                    "Counter requires paramVars=parameters",
                ))
            }
        }),
        computer: Box::new(move |action: &str, params: &State, _previous: &State| {
            computer_dispatches.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let result = (|| {
                let mut guard = computer_worker
                    .lock()
                    .map_err(|_| BindingError::new("worker_lock", "worker lock poisoned"))?;
                let worker = guard.as_mut().ok_or_else(|| {
                    BindingError::new("worker_closed", "worker is already closed")
                })?;
                let mut inputs = BTreeMap::new();
                let operation = match action {
                    "init" => "Initialize",
                    "tick" => {
                        let parameters = get_param(params, "parameters").ok_or_else(|| {
                            BindingError::new("input_shape_mismatch", "missing parameters record")
                        })?;
                        let stride =
                            parameters.get("stride").and_then(as_int).ok_or_else(|| {
                                BindingError::new(
                                    "input_shape_mismatch",
                                    "missing integer parameters.stride",
                                )
                            })?;
                        inputs.insert("Stride".into(), GateValue::Int(stride.clone()));
                        "Tick"
                    }
                    _ => {
                        return Err(BindingError::new(
                            "unknown_action",
                            format!("unknown Counter action {action}"),
                        ));
                    }
                };
                worker
                    .invoke(operation, &inputs, WorkerCallOptions::default())
                    .map_err(gate_binding_error)?;
                let observed = worker
                    .observe(WorkerCallOptions::default())
                    .map_err(gate_binding_error)?;
                let count = match observed.get("Count") {
                    Some(GateValue::Int(value)) => value.clone(),
                    _ => {
                        return Err(BindingError::new(
                            "observation_shape_mismatch",
                            "missing integer Count observation",
                        ));
                    }
                };
                let mut state = State::new();
                state.insert("count".into(), Value::Int(count));
                Ok(state)
            })();
            if result.is_err() {
                computer_failed.store(true, std::sync::atomic::Ordering::Release);
            }
            result
        }),
        dispose: Box::new(move || {
            let worker = dispose_worker
                .lock()
                .map_err(|_| BindingError::new("worker_lock", "worker lock poisoned"))?
                .take();
            let Some(worker) = worker else {
                return Ok(());
            };
            let reason = if failed.load(std::sync::atomic::Ordering::Acquire) {
                "client-failure"
            } else {
                "normal"
            };
            let report = worker.finish(reason);
            if let Some(primary) = report.primary {
                return Err(gate_binding_error(primary));
            }
            if !report.cleanup_confirmed() {
                let detail = report.cleanup_error.map_or_else(
                    || format!("unconfirmed worker cleanup: {:?}", report.cleanup),
                    |error| error.to_string(),
                );
                return Err(BindingError::new(
                    "mirrorgate.worker_cleanup_failed",
                    detail,
                ));
            }
            Ok(())
        }),
    }
}

pub fn run_sandboxed(
    mirrors_path: &str,
    config: ApalacheConfig,
    trace_path: String,
    metadata: GeneratedModelInterface,
    plan: SandboxPlan,
    mut bind_worker: WorkerBindingFactory,
) -> SandboxOutcome {
    let evidence = Arc::new(Mutex::new(SandboxEvidence::default()));
    let parsed_manifest = match PublicManifest::from_exact_json(&plan.manifest_json) {
        Ok(value) => value,
        Err(error) => {
            return SandboxOutcome {
                result: Err(gate_model_error(error)),
                evidence: evidence.lock().unwrap().clone(),
            };
        }
    };
    if parsed_manifest.interface_digest() != metadata.semantic_digest {
        return SandboxOutcome {
            result: Err(local_error(
                "mirrorgate.manifest_digest_mismatch",
                "public manifest and model semantic digests differ",
            )),
            evidence: evidence.lock().unwrap().clone(),
        };
    }
    let selected_digest = match SemanticDigest::from_hex(&metadata.semantic_digest) {
        Ok(value) => value,
        Err(error) => {
            return SandboxOutcome {
                result: Err(error),
                evidence: evidence.lock().unwrap().clone(),
            };
        }
    };
    let control = match open_control(&plan) {
        Ok(value) => value,
        Err(error) => {
            return SandboxOutcome {
                result: Err(gate_model_error(error)),
                evidence: evidence.lock().unwrap().clone(),
            };
        }
    };
    let session = match control.open_session(OpenSession {
        policy_id: plan.policy_id.clone(),
        submission: Submission::Prebuilt {
            input: InputRef {
                root_id: "submission".into(),
                relative_path: plan.submission_path.clone(),
            },
        },
        runtime: plan.runtime.clone(),
        manifest_json: plan.manifest_json.clone(),
        limits: None,
        model_revision_id: plan.private_model_revision.clone(),
    }) {
        Ok(value) => value,
        Err(error) => {
            let primary = Err(gate_model_error(error));
            let receipt = control.close();
            let mut observed = evidence.lock().unwrap().clone();
            observed.control_process_state = process_state(&receipt).into();
            observed.control_shutdown_confirmed = receipt.process_shutdown_confirmed();
            return SandboxOutcome {
                result: primary,
                evidence: observed,
            };
        }
    };
    let prepared = match session
        .prepare()
        .and_then(|operation| wait_prepared(&operation))
    {
        Ok(value) => value,
        Err(error) => {
            let mut primary = Err(gate_model_error(error));
            let cleanup = record_cleanup(&session, &primary, &evidence);
            if primary.is_ok() {
                primary = cleanup;
            }
            let receipt = control.close();
            let mut observed = evidence.lock().unwrap().clone();
            observed.control_process_state = process_state(&receipt).into();
            observed.control_shutdown_confirmed = receipt.process_shutdown_confirmed();
            return SandboxOutcome {
                result: primary,
                evidence: observed,
            };
        }
    };

    let factory_session = session.clone();
    let factory_prepared = prepared.clone();
    let factory_manifest = parsed_manifest.clone();
    let factory_runtime = plan.runtime.clone();
    let factory_adapter = plan.adapter_id.clone();
    let factory_target = plan.target_profile.clone();
    let factory_evidence = evidence.clone();
    let mut registry = CompiledAdapterRegistry::new(vec![CompiledAdapterRegistration {
        key: CompiledAdapterKey {
            semantic_digest: selected_digest,
            adapter_id: plan.adapter_id.clone(),
            target_profile: plan.target_profile.clone(),
            state_computer_contract_version: STATE_COMPUTER_CONTRACT_VERSION.into(),
        },
        factory: Box::new(move |matched| {
            factory_evidence
                .lock()
                .expect("evidence mutex poisoned")
                .binding_factory_calls += 1;
            if matched.descriptor_schema() != MODEL_INTERFACE_DESCRIPTOR_SCHEMA {
                return Err(BindingError::new(
                    "negotiation_status_unexpected",
                    "unexpected descriptor schema",
                ));
            }
            let attestation = RequiredMatchAttestation::matched(
                format!("mirrorrust-{}", factory_session.id()),
                matched.semantic_digest().to_hex(),
                factory_adapter.clone(),
                factory_target.clone(),
                STATE_COMPUTER_CONTRACT_VERSION,
            );
            let authorization = factory_session
                .authorize(
                    factory_prepared.prepared_revision,
                    factory_prepared.challenge.clone(),
                    attestation,
                )
                .map_err(gate_binding_error)?;
            let reservation = factory_session
                .acquire_worker(authorization)
                .map_err(gate_binding_error)?;
            let worker = reservation
                .connect(
                    factory_manifest.clone(),
                    factory_runtime.clone(),
                    WorkerOptions::default(),
                )
                .map_err(gate_binding_error)?;
            factory_evidence
                .lock()
                .expect("evidence mutex poisoned")
                .worker_acquisitions += 1;
            bind_worker(worker, matched.effective_config())
                .map(|binding| observe_binding_disposal(binding, factory_evidence.clone()))
        }),
    }]);
    let mut selection = CompiledAdapterSelection {
        metadata,
        adapter_id: plan.adapter_id.clone(),
        target_profile: plan.target_profile.clone(),
        state_computer_contract_version: STATE_COMPUTER_CONTRACT_VERSION.into(),
        registry: &mut registry,
        policy: NegotiationPolicy::Require,
        fallback_factory: None,
    };
    let mut primary = match plan.replay_mode {
        ReplayMode::Traces => mirrorrust::run_client_with_traces_negotiated(
            mirrors_path,
            config,
            vec![trace_path],
            &mut selection,
        ),
        ReplayMode::Generate => match plan.trace_generation.clone() {
            Some(trace_generation) => mirrorrust::run_client_negotiated(
                mirrors_path,
                config,
                trace_generation,
                &mut selection,
                None,
            ),
            None => Err(local_error(
                "mirrorgate.trace_generation_missing",
                "generate replay requires an explicit TraceGenerationConfig",
            )),
        },
    };
    let cleanup = record_cleanup(&session, &primary, &evidence);
    if primary.is_ok() {
        primary = cleanup;
    }
    if let Ok(events) = control.drain_events() {
        evidence.lock().unwrap().worker_started_events = events
            .iter()
            .filter(|event| matches!(event, ControlEvent::WorkerStarted { .. }))
            .count();
    }
    let receipt = control.close();
    {
        let mut observed = evidence.lock().unwrap();
        observed.control_process_state = process_state(&receipt).into();
        observed.control_shutdown_confirmed = receipt.process_shutdown_confirmed();
        if !observed.control_shutdown_confirmed && primary.is_ok() {
            primary = Err(local_error(
                "mirrorgate.control_shutdown_unconfirmed",
                "control shutdown was not confirmed",
            ));
        }
    }
    SandboxOutcome {
        result: primary,
        evidence: evidence.lock().unwrap().clone(),
    }
}

pub fn run_counter_sandboxed(
    mirrors_path: &str,
    config: ApalacheConfig,
    trace_path: String,
    metadata: GeneratedModelInterface,
    plan: SandboxPlan,
) -> SandboxOutcome {
    let canonical_digest =
        SemanticDigest::from_hex(COUNTER_SEMANTIC_DIGEST).expect("reviewed Counter digest");
    let dispatches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let binding_dispatches = dispatches.clone();
    let mut outcome = run_sandboxed(
        mirrors_path,
        config,
        trace_path,
        metadata,
        plan,
        Box::new(move |worker, _config| {
            Ok(counter_binding(
                worker,
                canonical_digest,
                binding_dispatches.clone(),
            ))
        }),
    );
    outcome.evidence.adapter_dispatches = dispatches.load(std::sync::atomic::Ordering::Relaxed);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inert_binding(dispose: impl FnMut() -> Result<(), BindingError> + 'static) -> LocalBinding {
        LocalBinding {
            semantic_digest: SemanticDigest::from_hex(COUNTER_SEMANTIC_DIGEST).unwrap(),
            computer: Box::new(|_: &str, _: &State, _: &State| Ok(State::new())),
            assert_compatible_config: Box::new(|_| Ok(())),
            dispose: Box::new(dispose),
        }
    }

    #[test]
    fn cleanup_failure_records_each_secondary_error_and_preserves_the_error() {
        let evidence = Arc::new(Mutex::new(SandboxEvidence::default()));
        let first = cleanup_failure(&evidence, local_error("cleanup.one", "first"));
        let second = cleanup_failure(&evidence, local_error("cleanup.two", "second"));
        assert!(
            matches!(first, mirrorrust::Error::ModelInterface { ref code, .. } if code == "cleanup.one")
        );
        assert!(
            matches!(second, mirrorrust::Error::ModelInterface { ref code, .. } if code == "cleanup.two")
        );
        let observed = evidence.lock().unwrap();
        assert!(observed.cleanup_error.contains("first"));
        assert!(observed.cleanup_error.contains("second"));
    }

    #[test]
    fn binding_disposal_error_is_retained_for_primary_error_precedence() {
        let evidence = Arc::new(Mutex::new(SandboxEvidence::default()));
        let mut binding = observe_binding_disposal(
            inert_binding(|| Err(BindingError::new("worker_cleanup", "worker remained"))),
            evidence.clone(),
        );
        let error = (binding.dispose)().unwrap_err();
        assert_eq!(error.code, "worker_cleanup");
        assert!(
            evidence
                .lock()
                .unwrap()
                .cleanup_error
                .contains("worker remained")
        );
    }
}
