use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

#[derive(Clone, Debug)]
pub struct ControllerCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug)]
pub struct ClientOptions {
    pub required_capabilities: Vec<String>,
    pub hello_timeout: Duration,
    pub request_timeout: Duration,
    pub connect_timeout: Duration,
    pub close_timeout: Duration,
    pub stderr_limit: usize,
}
impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            required_capabilities: Vec::new(),
            hello_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(5),
            connect_timeout: Duration::from_secs(5),
            close_timeout: Duration::from_secs(5),
            stderr_limit: 65_536,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputRef {
    pub root_id: String,
    pub relative_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Submission {
    Prebuilt {
        input: InputRef,
    },
    Source {
        input: InputRef,
        #[serde(rename = "buildPlanId")]
        build_plan_id: String,
        authoring: bool,
    },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TightenedLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_wall_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_wall_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_cpu_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address_space_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid_processes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_files: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_files: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmp_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scratch_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenSession {
    pub policy_id: String,
    pub submission: Submission,
    pub runtime: String,
    pub manifest_json: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<TightenedLimits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_revision_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequiredMatchAttestation {
    pub registration_id: String,
    pub request: String,
    pub policy: String,
    pub status: String,
    pub descriptor_schema: String,
    pub semantic_digest: String,
    pub adapter_id: String,
    pub target_profile: String,
    pub state_computer_contract_version: String,
}
impl RequiredMatchAttestation {
    #[must_use]
    pub fn matched(
        registration_id: impl Into<String>,
        semantic_digest: impl Into<String>,
        adapter_id: impl Into<String>,
        target_profile: impl Into<String>,
        state_computer_contract_version: impl Into<String>,
    ) -> Self {
        Self {
            registration_id: registration_id.into(),
            request: "verify".into(),
            policy: "require".into(),
            status: "matched".into(),
            descriptor_schema: "mirrors.model-interface-descriptor/v1".into(),
            semantic_digest: semantic_digest.into(),
            adapter_id: adapter_id.into(),
            target_profile: target_profile.into(),
            state_computer_contract_version: state_computer_contract_version.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OutcomeStatus {
    Passed,
    Mismatch,
    Failed,
    Cancelled,
    TimedOut,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutcomeSummary {
    pub status: OutcomeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_family: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    pub id: String,
    pub available: bool,
    pub enforced_scope: String,
    pub limits: BTreeMap<String, u64>,
    pub reason: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelloLimits {
    pub max_frame_bytes: u64,
    pub max_json_depth: u64,
    pub max_json_nodes: u64,
    pub max_pending_output_bytes: u64,
    pub max_sessions_per_connection: u64,
    pub max_inflight_requests_per_connection: u64,
    pub max_completed_operations_per_session: u64,
    pub hello_timeout_ms: u64,
    pub request_ack_timeout_ms: u64,
    pub worker_attachment_timeout_ms: u64,
    pub session_wall_ms: u64,
    pub graceful_stop_ms: u64,
    pub teardown_ms: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    pub control_version: u64,
    pub instance_id: String,
    pub capabilities: Vec<Capability>,
    pub limits: HelloLimits,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandResult {
    pub exit_code: i64,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prepared {
    pub prepared_revision: u64,
    pub artifact_id: String,
    pub artifact_hash: String,
    pub source_hash: Option<String>,
    pub manifest_hash: String,
    pub runtime: String,
    pub policy_id: String,
    pub challenge: String,
}
impl std::fmt::Debug for Prepared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Prepared")
            .field("prepared_revision", &self.prepared_revision)
            .field("artifact_id", &self.artifact_id)
            .field("artifact_hash", &self.artifact_hash)
            .field("source_hash", &self.source_hash)
            .field("manifest_hash", &self.manifest_hash)
            .field("runtime", &self.runtime)
            .field("policy_id", &self.policy_id)
            .field("challenge", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum SessionPhase {
    #[serde(rename = "open")]
    Open,
    #[serde(rename = "authoring")]
    Authoring,
    #[serde(rename = "preparing")]
    Preparing,
    #[serde(rename = "prepared")]
    Prepared,
    #[serde(rename = "authorized")]
    Authorized,
    #[serde(rename = "reserved")]
    Reserved,
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "closing")]
    Closing,
    #[serde(rename = "closed")]
    Closed,
    #[serde(rename = "cleanupFailed")]
    CleanupFailed,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum CleanupStatus {
    #[serde(rename = "notStarted")]
    NotStarted,
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "succeeded")]
    Succeeded,
    #[serde(rename = "failed")]
    Failed,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupResult {
    pub phase: SessionPhase,
    pub cleanup_status: CleanupStatus,
    pub remaining_resources: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceCounts {
    pub authoring_processes: u64,
    pub build_processes: u64,
    pub workers: u64,
    pub snapshots: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupStatusRecord {
    pub status: CleanupStatus,
    pub remaining_resources: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionStatus {
    pub phase: SessionPhase,
    pub resources: ResourceCounts,
    pub cleanup: CleanupStatusRecord,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ControlEvent {
    OperationFinished {
        session_id: String,
        operation_id: u64,
        succeeded: bool,
    },
    Output {
        session_id: String,
        operation_id: u64,
        build: bool,
        stderr: bool,
        chunk: u64,
        bytes: Vec<u8>,
    },
    WorkerStarted {
        session_id: String,
        worker_id: String,
    },
    WorkerReady {
        session_id: String,
        worker_id: String,
    },
    WorkerClosing {
        session_id: String,
        worker_id: String,
        reason: String,
    },
    WorkerExited {
        session_id: String,
        worker_id: String,
        reason: String,
        exit_code: Option<i64>,
    },
    SessionClosed {
        session_id: String,
        result: CleanupResult,
    },
}

#[derive(Clone, Debug)]
pub enum OperationOutcome<T> {
    Pending,
    Succeeded(T),
    Failed(crate::ServerError),
}
