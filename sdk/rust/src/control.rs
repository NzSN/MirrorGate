pub use crate::protocol::*;
pub use crate::transport::{ControlCloseReceipt, ProcessCloseState};

use crate::{Error, ErrorKind, Result, ServerError, strict, transport::Transport};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::de::DeserializeOwned;
use serde_json::{Value as Json, json};
use std::{
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    marker::PhantomData,
    path::Path,
    sync::{Arc, Mutex, Weak},
    thread,
    time::{Duration, Instant},
};

struct Core {
    transport: Option<Transport>,
    options: ClientOptions,
    next_request: u64,
    next_event: u64,
    hello: Option<Hello>,
    sessions: HashSet<String>,
    operations: HashMap<(String, u64), String>,
    workers: HashSet<(String, String)>,
    output_chunks: HashMap<(String, u64, String), u64>,
    events: VecDeque<ControlEvent>,
    event_bytes: usize,
    closed: bool,
}

impl Core {
    fn poison(&mut self) {
        self.closed = true;
        if let Some(transport) = self.transport.as_mut() {
            let _ = transport.close();
        }
    }
    fn request<T: DeserializeOwned>(
        &mut self,
        operation: &str,
        args: Json,
        timeout: Duration,
    ) -> Result<T> {
        let value = self.request_value(operation, args, timeout)?;
        serde_json::from_value(value).map_err(|e| {
            self.poison();
            Error::protocol(format!("invalid {operation} result: {e}"))
        })
    }
    fn request_value(&mut self, operation: &str, args: Json, timeout: Duration) -> Result<Json> {
        if self.closed {
            return Err(Error::disconnected("control connection is closed"));
        }
        if self.next_request > strict::SAFE_INTEGER {
            self.poison();
            return Err(Error::limit("control request ID exhausted"));
        }
        let id = self.next_request;
        self.next_request += 1;
        let request = json!({"v":1,"kind":"request","id":id,"op":operation,"args":args});
        validate_control_request(&request)?;
        let encoded = strict::encode(&request, strict::CONTROL_LIMITS)?;
        let result = (|| {
            self.transport
                .as_mut()
                .ok_or_else(|| Error::disconnected("control transport unavailable"))?
                .write_frame(&encoded, strict::CONTROL_FRAME_BYTES)?;
            let deadline = Instant::now() + timeout;
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(Error::deadline("control response deadline exceeded"));
                }
                let frame = self
                    .transport
                    .as_mut()
                    .ok_or_else(|| Error::disconnected("control transport unavailable"))?
                    .read_frame(strict::CONTROL_FRAME_BYTES, remaining)?;
                let message = strict::parse(&frame, strict::CONTROL_LIMITS)?;
                let object = message
                    .as_object()
                    .ok_or_else(|| Error::protocol("control frame is not an object"))?;
                match object.get("kind").and_then(Json::as_str) {
                    Some("event") => self.accept_event(&message)?,
                    Some("response") => {
                        strict::exact(&message, &["v", "kind", "id", "ok"], &["result", "error"])?;
                        if object.get("v") != Some(&json!(1))
                            || strict::safe_id(&object["id"])? != id
                        {
                            return Err(Error::protocol(
                                "unsolicited or incorrectly correlated response",
                            ));
                        }
                        let terminal = if operation == "operation.status" {
                            let session = request["args"]["sessionId"]
                                .as_str()
                                .ok_or_else(|| Error::protocol("invalid status session"))?;
                            let operation_id = strict::safe_id(&request["args"]["operationId"])?;
                            self.operations
                                .get(&(session.to_owned(), operation_id))
                                .map(String::as_str)
                        } else {
                            None
                        };
                        validate_control_response(&message, &request, terminal)?;
                        let ok = object["ok"]
                            .as_bool()
                            .ok_or_else(|| Error::protocol("invalid response status"))?;
                        if ok {
                            if !object.contains_key("result") || object.contains_key("error") {
                                return Err(Error::protocol("invalid success response"));
                            }
                            return Ok(object["result"].clone());
                        }
                        if object.contains_key("result") || !object.contains_key("error") {
                            return Err(Error::protocol("invalid failure response"));
                        }
                        return Err(Error::new(
                            ErrorKind::Server(parse_server_error(&object["error"])?),
                            "MirrorGate control request failed",
                        ));
                    }
                    _ => return Err(Error::protocol("invalid control envelope kind")),
                }
            }
        })();
        if let Err(error) = &result
            && !matches!(error.kind, ErrorKind::Server(_))
        {
            self.poison();
        }
        result
    }

    fn accept_event(&mut self, value: &Json) -> Result<()> {
        let object = strict::exact(
            value,
            &["v", "kind", "seq", "sessionId", "event", "data"],
            &[],
        )?;
        if object["v"] != 1 {
            return Err(Error::protocol("wrong control event version"));
        }
        let sequence = strict::safe_id(&object["seq"])?;
        if sequence != self.next_event {
            return Err(Error::protocol("control event sequence gap"));
        }
        self.next_event += 1;
        let session = strict::string(&object["sessionId"], 32)?.to_owned();
        if !self.sessions.contains(&session) {
            return Err(Error::protocol("event belongs to unknown session"));
        }
        let name = strict::string(&object["event"], 32)?;
        let data = &object["data"];
        let terminal = if name == "operation.finished" {
            let operation_id = strict::safe_id(&data["operationId"])?;
            self.operations
                .get(&(session.clone(), operation_id))
                .map(String::as_str)
        } else {
            None
        };
        validate_control_event(value, terminal)?;
        let event = match name {
            "operation.finished" => {
                let record = strict::exact(data, &["operationId", "status"], &["result", "error"])?;
                let operation_id = strict::safe_id(&record["operationId"])?;
                let terminal = self
                    .operations
                    .get(&(session.clone(), operation_id))
                    .ok_or_else(|| Error::protocol("event names unaccepted operation"))?;
                validate_operation_record(data, operation_id, terminal, true)?;
                let status = record["status"]
                    .as_str()
                    .ok_or_else(|| Error::protocol("invalid operation status"))?;
                let succeeded = match status {
                    "succeeded"
                        if record.contains_key("result") && !record.contains_key("error") =>
                    {
                        true
                    }
                    "failed" if record.contains_key("error") && !record.contains_key("result") => {
                        false
                    }
                    _ => return Err(Error::protocol("operation.finished is not terminal")),
                };
                ControlEvent::OperationFinished {
                    session_id: session,
                    operation_id,
                    succeeded,
                }
            }
            "authoring.output" | "build.output" => {
                let record = strict::exact(
                    data,
                    &["operationId", "stream", "chunk", "bytesBase64"],
                    &[],
                )?;
                let operation_id = strict::safe_id(&record["operationId"])?;
                if !self
                    .operations
                    .contains_key(&(session.clone(), operation_id))
                {
                    return Err(Error::protocol("output names unaccepted operation"));
                }
                let stream = strict::string(&record["stream"], 6)?;
                if !matches!(stream, "stdout" | "stderr") {
                    return Err(Error::protocol("invalid output stream"));
                }
                let chunk = strict::safe_id(&record["chunk"])?;
                let key = (session.clone(), operation_id, stream.to_owned());
                let expected = self.output_chunks.entry(key).or_insert(1);
                if chunk != *expected {
                    return Err(Error::protocol("output chunk sequence gap"));
                }
                *expected += 1;
                let encoded = strict::string(&record["bytesBase64"], 24_000)?;
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|_| Error::protocol("invalid output base64"))?;
                if bytes.len() > 16_384 || STANDARD.encode(&bytes) != encoded {
                    return Err(Error::protocol("noncanonical or oversized output base64"));
                }
                ControlEvent::Output {
                    session_id: session,
                    operation_id,
                    build: name == "build.output",
                    stderr: stream == "stderr",
                    chunk,
                    bytes,
                }
            }
            "worker.started" | "worker.ready" => {
                let record = strict::exact(data, &["workerId"], &[])?;
                let worker = strict::string(&record["workerId"], 32)?.to_owned();
                if !self.workers.contains(&(session.clone(), worker.clone())) {
                    return Err(Error::protocol("worker event names unowned worker"));
                }
                if name == "worker.started" {
                    ControlEvent::WorkerStarted {
                        session_id: session,
                        worker_id: worker,
                    }
                } else {
                    ControlEvent::WorkerReady {
                        session_id: session,
                        worker_id: worker,
                    }
                }
            }
            "worker.closing" | "worker.exited" => {
                let record = strict::exact(data, &["workerId", "reason"], &["exitCode"])?;
                let worker = strict::string(&record["workerId"], 32)?.to_owned();
                if !self.workers.contains(&(session.clone(), worker.clone())) {
                    return Err(Error::protocol("worker event names unowned worker"));
                }
                let reason = cleanup_reason(&record["reason"])?;
                if name == "worker.closing" {
                    if record.contains_key("exitCode") {
                        return Err(Error::protocol("closing event contains exitCode"));
                    }
                    ControlEvent::WorkerClosing {
                        session_id: session,
                        worker_id: worker,
                        reason,
                    }
                } else {
                    let exit_code = record
                        .get("exitCode")
                        .map(|v| {
                            v.as_i64()
                                .ok_or_else(|| Error::protocol("invalid exit code"))
                        })
                        .transpose()?;
                    ControlEvent::WorkerExited {
                        session_id: session,
                        worker_id: worker,
                        reason,
                        exit_code,
                    }
                }
            }
            "session.closed" => {
                let result: CleanupResult = decode(data.clone())?;
                validate_cleanup(&result)?;
                ControlEvent::SessionClosed {
                    session_id: session,
                    result,
                }
            }
            _ => return Err(Error::protocol("unknown control event")),
        };
        let size = serde_json::to_vec(value)
            .map_err(|e| Error::protocol(e.to_string()))?
            .len();
        self.event_bytes = self.event_bytes.saturating_add(size);
        if self.event_bytes > 4_194_304 {
            return Err(Error::limit("control event queue exceeded limit"));
        }
        self.events.push_back(event);
        Ok(())
    }
}

pub struct ControlClient {
    core: Arc<Mutex<Core>>,
}
impl ControlClient {
    pub fn launch(command: ControllerCommand, options: ClientOptions) -> Result<Self> {
        validate_options(&options)?;
        let transport = Transport::launch(
            &command,
            options.request_timeout,
            options.close_timeout,
            options.stderr_limit,
        )?;
        Self::new(transport, options)
    }
    pub fn connect_unix(path: impl AsRef<Path>, options: ClientOptions) -> Result<Self> {
        validate_options(&options)?;
        let transport = Transport::connect_unix(
            path.as_ref(),
            options.connect_timeout,
            options.request_timeout,
        )?;
        Self::new(transport, options)
    }
    fn new(transport: Transport, options: ClientOptions) -> Result<Self> {
        let core = Arc::new(Mutex::new(Core {
            transport: Some(transport),
            options: options.clone(),
            next_request: 1,
            next_event: 1,
            hello: None,
            sessions: HashSet::new(),
            operations: HashMap::new(),
            workers: HashSet::new(),
            output_chunks: HashMap::new(),
            events: VecDeque::new(),
            event_bytes: 0,
            closed: false,
        }));
        let client = Self { core };
        let hello: Hello = client.lock()?.request(
            "hello",
            json!({"controlVersions":[1],"requiredCapabilities":options.required_capabilities}),
            options.hello_timeout,
        )?;
        validate_hello(&hello, &options.required_capabilities).inspect_err(|_| {
            client.lock().map(|mut c| c.poison()).ok();
        })?;
        client.lock()?.hello = Some(hello);
        Ok(client)
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Core>> {
        self.core
            .lock()
            .map_err(|_| Error::disconnected("control connection lock poisoned"))
    }
    pub fn hello(&self) -> Result<Hello> {
        self.lock()?
            .hello
            .clone()
            .ok_or_else(|| Error::disconnected("control handshake unavailable"))
    }
    pub fn open_session(&self, request: OpenSession) -> Result<Session> {
        validate_open(&request)?;
        let runtime = request.runtime.clone();
        let manifest_json = request.manifest_json.clone();
        let timeout = self.lock()?.options.request_timeout;
        let result: SessionOpened = self.lock()?.request(
            "session.open",
            serde_json::to_value(request).map_err(|e| Error::argument(e.to_string()))?,
            timeout,
        )?;
        validate_handle(&result.session_id)?;
        let mut core = self.lock()?;
        if !core.sessions.insert(result.session_id.clone()) {
            core.poison();
            return Err(Error::protocol("duplicate session handle"));
        }
        Ok(Session {
            owner: Arc::downgrade(&self.core),
            id: result.session_id,
            runtime,
            manifest_json,
        })
    }
    pub fn drain_events(&self) -> Result<Vec<ControlEvent>> {
        let mut core = self.lock()?;
        core.event_bytes = 0;
        Ok(core.events.drain(..).collect())
    }
    pub fn close(self) -> ControlCloseReceipt {
        self.core
            .lock()
            .ok()
            .and_then(|mut core| {
                core.closed = true;
                core.transport.as_mut().map(Transport::close)
            })
            .unwrap_or(ControlCloseReceipt {
                transport_closed: false,
                process_owned: false,
                process_state: ProcessCloseState::Unconfirmed,
                terminate_requested: false,
                kill_requested: false,
            })
    }
}
impl Drop for ControlClient {
    fn drop(&mut self) {
        if let Ok(mut core) = self.core.lock()
            && !core.closed
        {
            core.poison();
        }
    }
}

#[derive(Clone)]
pub struct Session {
    owner: Weak<Mutex<Core>>,
    id: String,
    runtime: String,
    manifest_json: String,
}
impl Session {
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }
    #[must_use]
    pub fn runtime(&self) -> &str {
        &self.runtime
    }
    #[must_use]
    pub fn manifest_json(&self) -> &str {
        &self.manifest_json
    }
    fn owner(&self) -> Result<Arc<Mutex<Core>>> {
        self.owner
            .upgrade()
            .ok_or_else(|| Error::handle("control owner is closed"))
    }
    fn request<T: DeserializeOwned>(&self, operation: &str, args: Json) -> Result<T> {
        let owner = self.owner()?;
        let mut core = owner
            .lock()
            .map_err(|_| Error::disconnected("control lock poisoned"))?;
        if !core.sessions.contains(&self.id) {
            return Err(Error::handle("session is not owned by this connection"));
        }
        let timeout = core.options.request_timeout;
        core.request(operation, args, timeout)
    }
    pub fn authoring_exec(
        &self,
        tool_id: impl Into<String>,
        arguments: Vec<String>,
        cwd: impl Into<String>,
    ) -> Result<Operation<CommandResult>> {
        self.accepted("authoring.exec", json!({"sessionId":self.id,"toolId":tool_id.into(),"arguments":arguments,"cwd":cwd.into()}), "CommandResult")
    }
    pub fn prepare(&self) -> Result<Operation<Prepared>> {
        self.accepted("session.prepare", json!({"sessionId":self.id}), "Prepared")
    }
    pub fn authorize(
        &self,
        prepared_revision: u64,
        challenge: impl Into<String>,
        attestation: RequiredMatchAttestation,
    ) -> Result<Authorization> {
        let result: Authorized = self.request("session.authorize", json!({"sessionId":self.id,"preparedRevision":prepared_revision,"challenge":challenge.into(),"attestation":attestation}))?;
        validate_handle(&result.authorization_id)?;
        Ok(Authorization {
            owner: self.owner.clone(),
            session_id: self.id.clone(),
            id: result.authorization_id,
        })
    }
    pub fn acquire_worker(&self, authorization: Authorization) -> Result<WorkerReservation> {
        ensure_same_owner(
            &self.owner,
            &authorization.owner,
            &self.id,
            &authorization.session_id,
        )?;
        let result: WorkerDescriptorWire = self.request(
            "worker.acquire",
            json!({"sessionId":self.id,"authorizationId":authorization.id}),
        )?;
        validate_handle(&result.worker_id)?;
        validate_hex(&result.attachment_token, 64)?;
        validate_endpoint(&result.endpoint.path)?;
        if result.release_mode != "control-v1"
            || result.endpoint.kind != "unix"
            || result.attachment_timeout_ms == 0
            || result.attachment_timeout_ms > strict::SAFE_INTEGER
        {
            return Err(Error::protocol("invalid worker descriptor"));
        }
        let owner = self.owner()?;
        owner
            .lock()
            .map_err(|_| Error::disconnected("control lock poisoned"))?
            .workers
            .insert((self.id.clone(), result.worker_id.clone()));
        Ok(WorkerReservation {
            session: self.clone(),
            id: result.worker_id,
            endpoint: result.endpoint.path,
            attachment_token: result.attachment_token,
            attachment_timeout: Duration::from_millis(result.attachment_timeout_ms),
            consumed: false,
        })
    }
    pub(crate) fn release_worker(
        &self,
        worker_id: &str,
        reason: &str,
    ) -> Result<(Operation<CleanupResult>, String)> {
        let result: ReleaseAccepted = self.request(
            "worker.release",
            json!({"sessionId":self.id,"workerId":worker_id,"reason":reason}),
        )?;
        if !matches!(
            result.cleanup_mode.as_str(),
            "dispose-then-terminate" | "terminate-only"
        ) {
            return Err(Error::protocol("unknown cleanup mode"));
        }
        Ok((
            self.operation(result.operation_id, "CleanupResult")?,
            result.cleanup_mode,
        ))
    }
    pub fn status(&self) -> Result<SessionStatus> {
        let result = self.request("session.status", json!({"sessionId":self.id}))?;
        validate_session_status(&result)?;
        Ok(result)
    }
    pub fn cancel(&self, reason: &str) -> Result<Operation<CleanupResult>> {
        validate_reason(reason)?;
        self.accepted(
            "session.cancel",
            json!({"sessionId":self.id,"reason":reason}),
            "CleanupResult",
        )
    }
    pub fn close(&self, outcome: Option<OutcomeSummary>) -> Result<Operation<CleanupResult>> {
        let mut args = json!({"sessionId":self.id});
        if let Some(outcome) = outcome {
            args["outcomeSummary"] =
                serde_json::to_value(outcome).map_err(|e| Error::argument(e.to_string()))?;
        }
        self.accepted("session.close", args, "CleanupResult")
    }
    fn accepted<T>(&self, operation: &str, args: Json, terminal: &str) -> Result<Operation<T>> {
        let accepted: Accepted = self.request(operation, args)?;
        self.operation(accepted.operation_id, terminal)
    }
    fn operation<T>(&self, id: u64, terminal: &str) -> Result<Operation<T>> {
        if id == 0 || id > strict::SAFE_INTEGER {
            return Err(Error::protocol("invalid operation ID"));
        }
        let owner = self.owner()?;
        let mut core = owner
            .lock()
            .map_err(|_| Error::disconnected("control lock poisoned"))?;
        let key = (self.id.clone(), id);
        if let Some(existing) = core.operations.get(&key) {
            if existing != terminal {
                core.poison();
                return Err(Error::protocol(
                    "operation ID reused with another result contract",
                ));
            }
        } else {
            core.operations.insert(key, terminal.to_owned());
        }
        Ok(Operation {
            owner: self.owner.clone(),
            session_id: self.id.clone(),
            id,
            terminal: terminal.to_owned(),
            marker: PhantomData,
        })
    }
}

pub struct Authorization {
    owner: Weak<Mutex<Core>>,
    session_id: String,
    id: String,
}
impl std::fmt::Debug for Authorization {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Authorization")
            .field("session_id", &self.session_id)
            .field("id", &"<redacted>")
            .finish()
    }
}

pub struct WorkerReservation {
    pub(crate) session: Session,
    pub(crate) id: String,
    pub(crate) endpoint: String,
    pub(crate) attachment_token: String,
    pub(crate) attachment_timeout: Duration,
    pub(crate) consumed: bool,
}
impl WorkerReservation {
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn release(mut self, reason: &str) -> Result<Operation<CleanupResult>> {
        validate_reason(reason)?;
        self.consumed = true;
        self.session.release_worker(&self.id, reason).map(|v| v.0)
    }
}
impl std::fmt::Debug for WorkerReservation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerReservation")
            .field("session_id", &self.session.id)
            .field("worker_id", &self.id)
            .field("attachment_token", &"<redacted>")
            .finish()
    }
}

pub struct Operation<T> {
    owner: Weak<Mutex<Core>>,
    session_id: String,
    id: u64,
    terminal: String,
    marker: PhantomData<T>,
}
impl<T: DeserializeOwned> Operation<T> {
    #[must_use]
    pub fn id(&self) -> u64 {
        self.id
    }
    pub fn status(&self) -> Result<OperationOutcome<T>> {
        let owner = self
            .owner
            .upgrade()
            .ok_or_else(|| Error::handle("operation owner is closed"))?;
        let mut core = owner
            .lock()
            .map_err(|_| Error::disconnected("control lock poisoned"))?;
        if core.operations.get(&(self.session_id.clone(), self.id)) != Some(&self.terminal) {
            return Err(Error::handle("operation is not owned by this session"));
        }
        let timeout = core.options.request_timeout;
        let value = core.request_value(
            "operation.status",
            json!({"sessionId":self.session_id,"operationId":self.id}),
            timeout,
        )?;
        parse_operation(value, self.id, &self.terminal).inspect_err(|_| core.poison())
    }
    pub fn wait(&self, timeout: Duration) -> Result<OperationOutcome<T>> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.status()? {
                OperationOutcome::Pending if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10))
                }
                OperationOutcome::Pending => {
                    return Err(Error::deadline("operation wait deadline exceeded"));
                }
                terminal => return Ok(terminal),
            }
        }
    }
}

fn parse_operation<T: DeserializeOwned>(
    value: Json,
    expected: u64,
    terminal: &str,
) -> Result<OperationOutcome<T>> {
    validate_operation_record(&value, expected, terminal, false)?;
    let record = strict::exact(&value, &["operationId", "status"], &["result", "error"])?;
    match record["status"].as_str() {
        Some("pending") if !record.contains_key("result") && !record.contains_key("error") => {
            Ok(OperationOutcome::Pending)
        }
        Some("succeeded") if record.contains_key("result") && !record.contains_key("error") => Ok(
            OperationOutcome::Succeeded(decode(record["result"].clone())?),
        ),
        Some("failed") if record.contains_key("error") && !record.contains_key("result") => Ok(
            OperationOutcome::Failed(parse_server_error(&record["error"])?),
        ),
        _ => Err(Error::protocol("invalid operation status record")),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionOpened {
    session_id: String,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Accepted {
    operation_id: u64,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Authorized {
    authorization_id: String,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint {
    kind: String,
    path: String,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerDescriptorWire {
    worker_id: String,
    endpoint: Endpoint,
    attachment_token: String,
    attachment_timeout_ms: u64,
    release_mode: String,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseAccepted {
    operation_id: u64,
    cleanup_mode: String,
}

fn decode<T: DeserializeOwned>(value: Json) -> Result<T> {
    serde_json::from_value(value).map_err(|e| Error::protocol(e.to_string()))
}
fn parse_server_error(value: &Json) -> Result<ServerError> {
    let object = strict::exact(value, &["code", "stage", "message"], &["operationId"])?;
    let code = strict::string(&object["code"], 64)?;
    let stage = strict::string(&object["stage"], 32)?;
    const CODES: &[&str] = &[
        "VERSION_UNSUPPORTED",
        "CAPABILITY_UNAVAILABLE",
        "ARGUMENT_INVALID",
        "POLICY_DENIED",
        "HANDLE_INVALID",
        "STATE_INVALID",
        "LIMIT_EXCEEDED",
        "PREPARATION_FAILED",
        "BUILD_FAILED",
        "NEGOTIATION_ATTESTATION_INVALID",
        "BACKEND_ADMISSION_FAILED",
        "ATTACHMENT_FAILED",
        "WORKER_PROTOCOL_FAILED",
        "WORKER_EXITED",
        "CANCELLED",
        "DEADLINE_EXCEEDED",
        "CLEANUP_FAILED",
        "OPERATION_UNKNOWN",
    ];
    const STAGES: &[&str] = &[
        "bootstrap",
        "policy",
        "authoring",
        "prepare",
        "build",
        "authorize",
        "attach",
        "worker",
        "cleanup",
    ];
    if !CODES.contains(&code) || !STAGES.contains(&stage) {
        return Err(Error::protocol("unknown control error family or stage"));
    }
    Ok(ServerError {
        code: code.to_owned(),
        stage: stage.to_owned(),
        message: strict::string(&object["message"], 1024)?.to_owned(),
        operation_id: object.get("operationId").map(strict::safe_id).transpose()?,
    })
}
fn validate_handle(value: &str) -> Result<()> {
    if value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(Error::protocol("invalid opaque handle"))
    }
}
fn validate_hex(value: &str, length: usize) -> Result<()> {
    if value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(Error::protocol("invalid lowercase hexadecimal value"))
    }
}
fn validate_endpoint(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 107
        || bytes[0] != b'/'
        || bytes.contains(&0)
        || bytes.last() == Some(&b'/')
        || bytes
            .split(|b| *b == b'/')
            .enumerate()
            .any(|(i, p)| (i > 0 && p.is_empty()) || matches!(p, b"." | b".."))
    {
        Err(Error::protocol("invalid canonical Unix endpoint"))
    } else {
        Ok(())
    }
}
fn validate_reason(reason: &str) -> Result<()> {
    if matches!(
        reason,
        "normal" | "user-cancel" | "deadline" | "client-failure" | "worker-failure"
    ) {
        Ok(())
    } else {
        Err(Error::argument("invalid cleanup reason"))
    }
}
fn cleanup_reason(value: &Json) -> Result<String> {
    let value = strict::string(value, 16)?.to_owned();
    validate_reason(&value)?;
    Ok(value)
}
fn ensure_same_owner(
    left: &Weak<Mutex<Core>>,
    right: &Weak<Mutex<Core>>,
    left_session: &str,
    right_session: &str,
) -> Result<()> {
    let left = left
        .upgrade()
        .ok_or_else(|| Error::handle("owner is closed"))?;
    let right = right
        .upgrade()
        .ok_or_else(|| Error::handle("handle owner is closed"))?;
    if !Arc::ptr_eq(&left, &right) || left_session != right_session {
        return Err(Error::handle("handle belongs to another session"));
    }
    Ok(())
}
fn validate_options(options: &ClientOptions) -> Result<()> {
    if options.hello_timeout.is_zero()
        || options.request_timeout.is_zero()
        || options.connect_timeout.is_zero()
        || options.close_timeout.is_zero()
        || options.required_capabilities.len() > 64
    {
        return Err(Error::argument("invalid client limits"));
    }
    let mut seen = BTreeSet::new();
    for cap in &options.required_capabilities {
        if !seen.insert(cap) || cap.is_empty() || cap.len() > 128 {
            return Err(Error::argument("invalid or duplicate required capability"));
        }
    }
    Ok(())
}
fn validate_open(request: &OpenSession) -> Result<()> {
    validate_catalog(&request.policy_id)?;
    validate_catalog(&request.runtime)?;
    if request.manifest_json.len() > strict::MANIFEST_BYTES {
        return Err(Error::argument("manifest exceeds limit"));
    }
    let input = match &request.submission {
        Submission::Prebuilt { input } => input,
        Submission::Source {
            input,
            build_plan_id,
            ..
        } => {
            validate_catalog(build_plan_id)?;
            input
        }
    };
    validate_catalog(&input.root_id)?;
    validate_relative(&input.relative_path)?;
    if let Some(revision) = &request.model_revision_id
        && (revision.is_empty() || revision.len() > 128 || !revision.is_ascii())
    {
        return Err(Error::argument("invalid model revision ID"));
    }
    if let Some(limits) = &request.limits {
        for value in [
            limits.session_wall_ms,
            limits.execution_wall_ms,
            limits.command_cpu_seconds,
            limits.address_space_bytes,
            limits.uid_processes,
            limits.open_files,
            limits.file_bytes,
            limits.stdout_bytes,
            limits.stderr_bytes,
            limits.snapshot_files,
            limits.snapshot_bytes,
            limits.tmp_bytes,
            limits.scratch_bytes,
        ]
        .into_iter()
        .flatten()
        {
            if value == 0 || value > strict::SAFE_INTEGER {
                return Err(Error::argument("invalid tightened limit"));
            }
        }
    }
    let _ = crate::PublicManifest::from_exact_json(&request.manifest_json)?;
    Ok(())
}
fn validate_catalog(value: &str) -> Result<()> {
    let mut bytes = value.bytes();
    if value.len() > 128
        || !bytes.next().is_some_and(|b| b.is_ascii_alphabetic())
        || !bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    {
        Err(Error::argument("invalid catalog identifier"))
    } else {
        Ok(())
    }
}
fn validate_relative(value: &str) -> Result<()> {
    if value == "." {
        return Ok(());
    }
    if value.is_empty()
        || value.len() > 1024
        || value.starts_with('/')
        || value.contains('\0')
        || value
            .split('/')
            .any(|p| p.is_empty() || matches!(p, "." | ".."))
    {
        Err(Error::argument("invalid canonical relative path"))
    } else {
        Ok(())
    }
}
fn validate_hello(hello: &Hello, required: &[String]) -> Result<()> {
    if hello.control_version != 1 || hello.capabilities.len() > 64 {
        return Err(Error::protocol("invalid control hello"));
    }
    validate_hex(&hello.instance_id, 32)?;
    let limits = &hello.limits;
    if [
        limits.max_frame_bytes,
        limits.max_json_depth,
        limits.max_json_nodes,
        limits.max_pending_output_bytes,
        limits.max_sessions_per_connection,
        limits.max_inflight_requests_per_connection,
        limits.max_completed_operations_per_session,
        limits.hello_timeout_ms,
        limits.request_ack_timeout_ms,
        limits.worker_attachment_timeout_ms,
        limits.session_wall_ms,
        limits.graceful_stop_ms,
        limits.teardown_ms,
    ]
    .iter()
    .any(|v| *v == 0 || *v > strict::SAFE_INTEGER)
    {
        return Err(Error::protocol("invalid hello limit"));
    }
    let mut ids = BTreeSet::new();
    for cap in &hello.capabilities {
        if strict::identifier(&json!(cap.id)).is_err()
            || !ids.insert(&cap.id)
            || !matches!(
                cap.enforced_scope.as_str(),
                "connection" | "session" | "command" | "process" | "host-uid" | "host" | "none"
            )
            || cap.available == (cap.enforced_scope == "none")
            || (!cap.available && cap.reason.is_none())
            || (cap.available && cap.reason.is_some())
            || cap
                .reason
                .as_ref()
                .is_some_and(|reason| strict::identifier(&json!(reason)).is_err())
            || cap.limits.keys().any(|key| !is_capability_limit(key))
            || cap.limits.values().any(|v| *v > strict::SAFE_INTEGER)
        {
            return Err(Error::protocol("invalid capability report"));
        }
    }
    for needed in required {
        if !hello
            .capabilities
            .iter()
            .any(|cap| &cap.id == needed && cap.available)
        {
            return Err(Error::new(
                ErrorKind::Server(ServerError {
                    code: "CAPABILITY_UNAVAILABLE".into(),
                    stage: "bootstrap".into(),
                    message: format!("required capability unavailable: {needed}"),
                    operation_id: None,
                }),
                "required capability unavailable",
            ));
        }
    }
    Ok(())
}

fn validate_hello_value(value: &Json, required: &[String]) -> Result<Hello> {
    let object = strict::exact(
        value,
        &["controlVersion", "instanceId", "capabilities", "limits"],
        &[],
    )?;
    let capabilities = object["capabilities"]
        .as_array()
        .ok_or_else(|| Error::protocol("invalid capability array"))?;
    for capability in capabilities {
        let capability = strict::exact(
            capability,
            &["id", "available", "enforcedScope", "limits"],
            &["reason"],
        )?;
        let available = capability["available"]
            .as_bool()
            .ok_or_else(|| Error::protocol("invalid capability availability"))?;
        if available == capability.contains_key("reason") {
            return Err(Error::protocol("invalid capability reason presence"));
        }
    }
    let hello: Hello = decode(value.clone())?;
    validate_hello(&hello, required)?;
    Ok(hello)
}

fn is_capability_limit(key: &str) -> bool {
    matches!(
        key,
        "maxFrameBytes"
            | "maxJsonDepth"
            | "maxJsonNodes"
            | "maxPendingOutputBytes"
            | "maxSessionsPerConnection"
            | "maxInflightRequestsPerConnection"
            | "maxCompletedOperationsPerSession"
            | "helloTimeoutMs"
            | "requestAckTimeoutMs"
            | "workerAttachmentTimeoutMs"
            | "sessionWallMs"
            | "gracefulStopMs"
            | "teardownMs"
            | "executionWallMs"
            | "commandCpuSeconds"
            | "addressSpaceBytes"
            | "uidProcesses"
            | "openFiles"
            | "fileBytes"
            | "stdoutBytes"
            | "stderrBytes"
            | "snapshotFiles"
            | "snapshotBytes"
            | "tmpBytes"
            | "scratchBytes"
    )
}

fn validate_cleanup(result: &CleanupResult) -> Result<()> {
    let mut seen = BTreeSet::new();
    if result.remaining_resources.len() > 64
        || result
            .remaining_resources
            .iter()
            .any(|v| strict::identifier(&json!(v)).is_err() || !seen.insert(v))
    {
        return Err(Error::protocol("invalid remaining resources"));
    }
    match (
        result.phase,
        result.cleanup_status,
        result.remaining_resources.is_empty(),
    ) {
        (SessionPhase::Closed, CleanupStatus::Succeeded, true)
        | (SessionPhase::CleanupFailed, CleanupStatus::Failed, _) => Ok(()),
        _ => Err(Error::protocol("incoherent terminal cleanup result")),
    }
}
fn validate_session_status(result: &SessionStatus) -> Result<()> {
    for value in [
        result.resources.authoring_processes,
        result.resources.build_processes,
        result.resources.workers,
        result.resources.snapshots,
    ] {
        if value > strict::SAFE_INTEGER {
            return Err(Error::protocol("invalid resource count"));
        }
    }
    let mut seen = BTreeSet::new();
    if result.cleanup.remaining_resources.len() > 64
        || result
            .cleanup
            .remaining_resources
            .iter()
            .any(|v| strict::identifier(&json!(v)).is_err() || !seen.insert(v))
    {
        return Err(Error::protocol("invalid cleanup status resources"));
    }
    Ok(())
}
fn validate_prepared(value: &Json) -> Result<Prepared> {
    let object = value
        .as_object()
        .ok_or_else(|| Error::protocol("prepared result must be an object"))?;
    if let Some(source) = object.get("sourceHash") {
        validate_hex(strict::string(source, 64)?, 64)?;
    }
    let prepared: Prepared = decode(value.clone())?;
    if prepared.prepared_revision != 1 {
        return Err(Error::protocol("unsupported prepared revision"));
    }
    validate_handle(&prepared.artifact_id)?;
    validate_hex(&prepared.artifact_hash, 64)?;
    if let Some(source) = &prepared.source_hash {
        validate_hex(source, 64)?;
    }
    validate_hex(&prepared.manifest_hash, 64)?;
    validate_handle(&prepared.challenge)?;
    if prepared.runtime.is_empty()
        || prepared.runtime.len() > 128
        || prepared.policy_id.is_empty()
        || prepared.policy_id.len() > 128
    {
        return Err(Error::protocol("invalid prepared identity"));
    }
    Ok(prepared)
}
fn validate_command(value: &Json) -> Result<CommandResult> {
    let result: CommandResult = decode(value.clone())?;
    let safe_signed = i64::try_from(strict::SAFE_INTEGER).expect("safe integer fits i64");
    if result.exit_code < -safe_signed
        || result.exit_code > safe_signed
        || result.stdout_bytes > strict::SAFE_INTEGER
        || result.stderr_bytes > strict::SAFE_INTEGER
    {
        return Err(Error::protocol("invalid command result"));
    }
    Ok(result)
}
fn validate_terminal(value: &Json, terminal: &str) -> Result<()> {
    match terminal {
        "Prepared" => {
            validate_prepared(value)?;
        }
        "CommandResult" => {
            validate_command(value)?;
        }
        "CleanupResult" => {
            let result: CleanupResult = decode(value.clone())?;
            validate_cleanup(&result)?;
        }
        _ => return Err(Error::protocol("unknown terminal result contract")),
    }
    Ok(())
}
fn validate_operation_record(
    value: &Json,
    expected: u64,
    terminal: &str,
    must_terminal: bool,
) -> Result<()> {
    let record = strict::exact(value, &["operationId", "status"], &["result", "error"])?;
    if strict::safe_id(&record["operationId"])? != expected {
        return Err(Error::protocol("operation status correlation mismatch"));
    }
    match record["status"].as_str() {
        Some("pending")
            if !must_terminal
                && !record.contains_key("result")
                && !record.contains_key("error") =>
        {
            Ok(())
        }
        Some("succeeded") if record.contains_key("result") && !record.contains_key("error") => {
            validate_terminal(&record["result"], terminal)
        }
        Some("failed") if record.contains_key("error") && !record.contains_key("result") => {
            let error = parse_server_error(&record["error"])?;
            if error.operation_id.is_some_and(|id| id != expected) {
                return Err(Error::protocol(
                    "nested operation error correlation mismatch",
                ));
            }
            Ok(())
        }
        _ => Err(Error::protocol("invalid operation status record")),
    }
}

fn validate_session_value(value: &Json) -> Result<()> {
    validate_handle(strict::string(value, 32)?)
}
fn validate_attestation(value: &Json) -> Result<()> {
    let o = strict::exact(
        value,
        &[
            "registrationId",
            "request",
            "policy",
            "status",
            "descriptorSchema",
            "semanticDigest",
            "adapterId",
            "targetProfile",
            "stateComputerContractVersion",
        ],
        &[],
    )?;
    if o["request"] != "verify"
        || o["policy"] != "require"
        || o["status"] != "matched"
        || o["descriptorSchema"] != "mirrors.model-interface-descriptor/v1"
    {
        return Err(Error::protocol("invalid required-match attestation"));
    }
    strict::digest(&o["semanticDigest"])?;
    for key in [
        "registrationId",
        "adapterId",
        "targetProfile",
        "stateComputerContractVersion",
    ] {
        if strict::string(&o[key], 128)?.is_empty() {
            return Err(Error::protocol("empty attestation identity"));
        }
    }
    Ok(())
}
fn validate_control_request(value: &Json) -> Result<()> {
    let o = strict::exact(value, &["v", "kind", "id", "op", "args"], &[])?;
    if o["v"] != 1 || o["kind"] != "request" {
        return Err(Error::protocol("invalid request envelope"));
    }
    strict::safe_id(&o["id"])?;
    let op = o["op"]
        .as_str()
        .ok_or_else(|| Error::protocol("invalid operation name"))?;
    let args = o["args"]
        .as_object()
        .ok_or_else(|| Error::protocol("args must be object"))?;
    match op {
        "hello" => {
            strict::exact(
                &o["args"],
                &["controlVersions", "requiredCapabilities"],
                &[],
            )?;
            let versions = args["controlVersions"]
                .as_array()
                .filter(|v| !v.is_empty() && v.len() <= 8)
                .ok_or_else(|| Error::protocol("invalid versions"))?;
            let mut seen = BTreeSet::new();
            for version in versions {
                if strict::safe_id(version).is_err() || !seen.insert(version.as_u64()) {
                    return Err(Error::protocol("invalid versions"));
                }
            }
            strict::unique_strings(&args["requiredCapabilities"], 64, 128)?;
        }
        "session.open" => {
            if args.get("limits").is_some_and(Json::is_null)
                || args.get("modelRevisionId").is_some_and(Json::is_null)
                || args
                    .get("limits")
                    .and_then(Json::as_object)
                    .is_some_and(|limits| limits.values().any(Json::is_null))
            {
                return Err(Error::protocol("optional session field must not be null"));
            }
            let decoded: OpenSession = decode(o["args"].clone())?;
            validate_open(&decoded)?;
        }
        "authoring.exec" => {
            strict::exact(
                &o["args"],
                &["sessionId", "toolId", "arguments", "cwd"],
                &[],
            )?;
            validate_session_value(&args["sessionId"])?;
            strict::identifier(&args["toolId"])?;
            let cwd = args["cwd"]
                .as_str()
                .ok_or_else(|| Error::protocol("invalid cwd"))?;
            validate_relative(cwd)?;
            let arguments = args["arguments"]
                .as_array()
                .filter(|v| v.len() <= 256)
                .ok_or_else(|| Error::protocol("invalid arguments"))?;
            let mut total = 0;
            for arg in arguments {
                let s = arg
                    .as_str()
                    .filter(|s| !s.contains('\0'))
                    .ok_or_else(|| Error::protocol("invalid argument"))?;
                total += s.len();
            }
            if total > 65_535 {
                return Err(Error::limit("arguments exceed limit"));
            }
        }
        "session.prepare" | "session.status" => {
            strict::exact(&o["args"], &["sessionId"], &[])?;
            validate_session_value(&args["sessionId"])?;
        }
        "session.authorize" => {
            strict::exact(
                &o["args"],
                &["sessionId", "preparedRevision", "challenge", "attestation"],
                &[],
            )?;
            validate_session_value(&args["sessionId"])?;
            if strict::safe_id(&args["preparedRevision"])? != 1 {
                return Err(Error::protocol("unsupported revision"));
            }
            validate_session_value(&args["challenge"])?;
            validate_attestation(&args["attestation"])?;
        }
        "worker.acquire" => {
            strict::exact(&o["args"], &["sessionId", "authorizationId"], &[])?;
            validate_session_value(&args["sessionId"])?;
            validate_session_value(&args["authorizationId"])?;
        }
        "worker.release" => {
            strict::exact(&o["args"], &["sessionId", "workerId", "reason"], &[])?;
            validate_session_value(&args["sessionId"])?;
            validate_session_value(&args["workerId"])?;
            validate_reason(
                args["reason"]
                    .as_str()
                    .ok_or_else(|| Error::protocol("invalid reason"))?,
            )?;
        }
        "session.cancel" => {
            strict::exact(&o["args"], &["sessionId", "reason"], &[])?;
            validate_session_value(&args["sessionId"])?;
            validate_reason(
                args["reason"]
                    .as_str()
                    .ok_or_else(|| Error::protocol("invalid reason"))?,
            )?;
        }
        "session.close" => {
            strict::exact(&o["args"], &["sessionId"], &["outcomeSummary"])?;
            validate_session_value(&args["sessionId"])?;
            if let Some(outcome) = args.get("outcomeSummary") {
                let outcome_fields = outcome
                    .as_object()
                    .ok_or_else(|| Error::protocol("outcome summary must be an object"))?;
                if let Some(family) = outcome_fields.get("failureFamily") {
                    strict::identifier(family)?;
                }
                let decoded: OutcomeSummary = decode(outcome.clone())?;
                if let Some(family) = decoded.failure_family {
                    validate_catalog(&family)?;
                }
            }
        }
        "operation.status" => {
            strict::exact(&o["args"], &["sessionId", "operationId"], &[])?;
            validate_session_value(&args["sessionId"])?;
            strict::safe_id(&args["operationId"])?;
        }
        _ => return Err(Error::protocol("unknown control operation")),
    }
    Ok(())
}
fn validate_control_response(value: &Json, request: &Json, operation: Option<&str>) -> Result<()> {
    validate_control_request(request)?;
    let req = request
        .as_object()
        .ok_or_else(|| Error::protocol("request context missing"))?;
    let req_op = req["op"]
        .as_str()
        .ok_or_else(|| Error::protocol("request operation missing"))?;
    let req_id = strict::safe_id(&req["id"])?;
    let o = strict::exact(value, &["v", "kind", "id", "ok"], &["result", "error"])?;
    if o["v"] != 1 || o["kind"] != "response" || strict::safe_id(&o["id"])? != req_id {
        return Err(Error::protocol("response correlation mismatch"));
    }
    let ok = o["ok"]
        .as_bool()
        .ok_or_else(|| Error::protocol("invalid response status"))?;
    if !ok {
        if o.contains_key("result") || !o.contains_key("error") {
            return Err(Error::protocol("invalid failure envelope"));
        }
        parse_server_error(&o["error"])?;
        return Ok(());
    }
    if !o.contains_key("result") || o.contains_key("error") {
        return Err(Error::protocol("invalid success envelope"));
    }
    let result = &o["result"];
    match req_op {
        "hello" => {
            let required = req["args"]["requiredCapabilities"]
                .as_array()
                .ok_or_else(|| Error::protocol("required capabilities missing"))?
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(ToOwned::to_owned)
                        .ok_or_else(|| Error::protocol("invalid capability"))
                })
                .collect::<Result<Vec<_>>>()?;
            validate_hello_value(result, &required).map(|_| ())
        }
        "session.open" => {
            let r: SessionOpened = decode(result.clone())?;
            validate_handle(&r.session_id)
        }
        "authoring.exec" | "session.prepare" | "session.cancel" | "session.close" => {
            let r: Accepted = decode(result.clone())?;
            if r.operation_id == 0 || r.operation_id > strict::SAFE_INTEGER {
                Err(Error::protocol("invalid accepted operation"))
            } else {
                Ok(())
            }
        }
        "session.authorize" => {
            let r: Authorized = decode(result.clone())?;
            validate_handle(&r.authorization_id)
        }
        "worker.acquire" => {
            let r: WorkerDescriptorWire = decode(result.clone())?;
            validate_handle(&r.worker_id)?;
            validate_hex(&r.attachment_token, 64)?;
            validate_endpoint(&r.endpoint.path)?;
            if r.endpoint.kind != "unix"
                || r.release_mode != "control-v1"
                || r.attachment_timeout_ms == 0
                || r.attachment_timeout_ms > strict::SAFE_INTEGER
            {
                return Err(Error::protocol("invalid descriptor"));
            }
            Ok(())
        }
        "worker.release" => {
            let r: ReleaseAccepted = decode(result.clone())?;
            if r.operation_id == 0
                || r.operation_id > strict::SAFE_INTEGER
                || !matches!(
                    r.cleanup_mode.as_str(),
                    "dispose-then-terminate" | "terminate-only"
                )
            {
                return Err(Error::protocol("invalid release acceptance"));
            }
            Ok(())
        }
        "session.status" => {
            let r: SessionStatus = decode(result.clone())?;
            validate_session_status(&r)
        }
        "operation.status" => {
            let expected = strict::safe_id(&req["args"]["operationId"])?;
            validate_operation_record(
                result,
                expected,
                operation.ok_or_else(|| Error::protocol("missing operation context"))?,
                false,
            )
        }
        _ => Err(Error::protocol("unsupported response operation")),
    }
}
pub(crate) fn validate_attachment(value: &Json, reply: bool) -> Result<()> {
    let required = if reply {
        &["v", "kind", "sessionId", "workerId"][..]
    } else {
        &["v", "kind", "sessionId", "workerId", "attachmentToken"][..]
    };
    let o = strict::exact(value, required, &[])?;
    if o["v"] != 1 || o["kind"] != if reply { "attached" } else { "attach" } {
        return Err(Error::protocol("invalid attachment envelope"));
    }
    validate_session_value(&o["sessionId"])?;
    validate_session_value(&o["workerId"])?;
    if !reply {
        validate_hex(
            o["attachmentToken"]
                .as_str()
                .ok_or_else(|| Error::protocol("invalid token"))?,
            64,
        )?;
    }
    Ok(())
}
fn validate_control_event(value: &Json, operation: Option<&str>) -> Result<()> {
    let o = strict::exact(
        value,
        &["v", "kind", "seq", "sessionId", "event", "data"],
        &[],
    )?;
    if o["v"] != 1 || o["kind"] != "event" {
        return Err(Error::protocol("invalid event envelope"));
    }
    strict::safe_id(&o["seq"])?;
    validate_session_value(&o["sessionId"])?;
    let name = o["event"]
        .as_str()
        .ok_or_else(|| Error::protocol("invalid event name"))?;
    let data = &o["data"];
    match name {
        "operation.finished" => {
            let id = strict::safe_id(&data["operationId"])?;
            validate_operation_record(
                data,
                id,
                operation.ok_or_else(|| Error::protocol("missing operation context"))?,
                true,
            )
        }
        "authoring.output" | "build.output" => {
            let r = strict::exact(
                data,
                &["operationId", "stream", "chunk", "bytesBase64"],
                &[],
            )?;
            strict::safe_id(&r["operationId"])?;
            strict::safe_id(&r["chunk"])?;
            if !matches!(r["stream"].as_str(), Some("stdout" | "stderr")) {
                return Err(Error::protocol("invalid stream"));
            }
            let encoded = r["bytesBase64"]
                .as_str()
                .ok_or_else(|| Error::protocol("invalid base64"))?;
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| Error::protocol("invalid base64"))?;
            if bytes.len() > 16_384 || STANDARD.encode(&bytes) != encoded {
                return Err(Error::protocol("invalid base64"));
            }
            Ok(())
        }
        "worker.started" | "worker.ready" => {
            let r = strict::exact(data, &["workerId"], &[])?;
            validate_session_value(&r["workerId"])
        }
        "worker.closing" => {
            let r = strict::exact(data, &["workerId", "reason"], &[])?;
            validate_session_value(&r["workerId"])?;
            validate_reason(
                r["reason"]
                    .as_str()
                    .ok_or_else(|| Error::protocol("invalid reason"))?,
            )
        }
        "worker.exited" => {
            let r = strict::exact(data, &["workerId", "reason"], &["exitCode"])?;
            validate_session_value(&r["workerId"])?;
            validate_reason(
                r["reason"]
                    .as_str()
                    .ok_or_else(|| Error::protocol("invalid reason"))?,
            )?;
            if let Some(exit) = r.get("exitCode") {
                exit.as_i64()
                    .ok_or_else(|| Error::protocol("invalid exit code"))?;
            }
            Ok(())
        }
        "session.closed" => {
            let r: CleanupResult = decode(data.clone())?;
            validate_cleanup(&r)
        }
        _ => Err(Error::protocol("unknown event")),
    }
}

#[cfg(test)]
#[allow(dead_code)]
mod vectors {
    use super::*;
    fn relative(value: &Json) -> Result<()> {
        let path = strict::string(value, 1024)?;
        if path == "." {
            return Ok(());
        }
        if path.is_empty()
            || path.starts_with('/')
            || path.contains('\0')
            || path
                .split('/')
                .any(|p| p.is_empty() || matches!(p, "." | ".."))
        {
            Err(Error::protocol("invalid relative path"))
        } else {
            Ok(())
        }
    }
    fn session(value: &Json) -> Result<()> {
        validate_handle(strict::string(value, 32)?)
    }
    fn attestation(value: &Json) -> Result<()> {
        let o = strict::exact(
            value,
            &[
                "registrationId",
                "request",
                "policy",
                "status",
                "descriptorSchema",
                "semanticDigest",
                "adapterId",
                "targetProfile",
                "stateComputerContractVersion",
            ],
            &[],
        )?;
        if o["request"] != "verify"
            || o["policy"] != "require"
            || o["status"] != "matched"
            || o["descriptorSchema"] != "mirrors.model-interface-descriptor/v1"
        {
            return Err(Error::protocol("invalid required-match attestation"));
        }
        strict::digest(&o["semanticDigest"])?;
        for key in [
            "registrationId",
            "adapterId",
            "targetProfile",
            "stateComputerContractVersion",
        ] {
            if strict::string(&o[key], 128)?.is_empty() {
                return Err(Error::protocol("empty attestation identity"));
            }
        }
        Ok(())
    }
    fn request(value: &Json) -> Result<()> {
        let o = strict::exact(value, &["v", "kind", "id", "op", "args"], &[])?;
        if o["v"] != 1 || o["kind"] != "request" {
            return Err(Error::protocol("invalid request envelope"));
        }
        strict::safe_id(&o["id"])?;
        let op = o["op"]
            .as_str()
            .ok_or_else(|| Error::protocol("invalid operation name"))?;
        let args = o["args"]
            .as_object()
            .ok_or_else(|| Error::protocol("args must be object"))?;
        match op {
            "hello" => {
                strict::exact(
                    &o["args"],
                    &["controlVersions", "requiredCapabilities"],
                    &[],
                )?;
                let versions = args["controlVersions"]
                    .as_array()
                    .filter(|v| !v.is_empty() && v.len() <= 8)
                    .ok_or_else(|| Error::protocol("invalid versions"))?;
                let mut seen = BTreeSet::new();
                for version in versions {
                    if strict::safe_id(version).is_err() || !seen.insert(version.as_u64()) {
                        return Err(Error::protocol("invalid versions"));
                    }
                }
                strict::unique_strings(&args["requiredCapabilities"], 64, 128)?;
            }
            "session.open" => {
                let decoded: OpenSession = decode(o["args"].clone())?;
                validate_open(&decoded)?;
            }
            "authoring.exec" => {
                strict::exact(
                    &o["args"],
                    &["sessionId", "toolId", "arguments", "cwd"],
                    &[],
                )?;
                session(&args["sessionId"])?;
                strict::identifier(&args["toolId"])?;
                relative(&args["cwd"])?;
                let arguments = args["arguments"]
                    .as_array()
                    .filter(|v| v.len() <= 256)
                    .ok_or_else(|| Error::protocol("invalid arguments"))?;
                let mut total = 0;
                for arg in arguments {
                    let s = arg
                        .as_str()
                        .filter(|s| !s.contains('\0'))
                        .ok_or_else(|| Error::protocol("invalid argument"))?;
                    total += s.len();
                }
                if total > 65_535 {
                    return Err(Error::limit("arguments exceed limit"));
                }
            }
            "session.prepare" | "session.status" => {
                strict::exact(&o["args"], &["sessionId"], &[])?;
                session(&args["sessionId"])?;
            }
            "session.authorize" => {
                strict::exact(
                    &o["args"],
                    &["sessionId", "preparedRevision", "challenge", "attestation"],
                    &[],
                )?;
                session(&args["sessionId"])?;
                if strict::safe_id(&args["preparedRevision"])? != 1 {
                    return Err(Error::protocol("unsupported revision"));
                }
                session(&args["challenge"])?;
                attestation(&args["attestation"])?;
            }
            "worker.acquire" => {
                strict::exact(&o["args"], &["sessionId", "authorizationId"], &[])?;
                session(&args["sessionId"])?;
                session(&args["authorizationId"])?;
            }
            "worker.release" => {
                strict::exact(&o["args"], &["sessionId", "workerId", "reason"], &[])?;
                session(&args["sessionId"])?;
                session(&args["workerId"])?;
                validate_reason(
                    args["reason"]
                        .as_str()
                        .ok_or_else(|| Error::protocol("invalid reason"))?,
                )?;
            }
            "session.cancel" => {
                strict::exact(&o["args"], &["sessionId", "reason"], &[])?;
                session(&args["sessionId"])?;
                validate_reason(
                    args["reason"]
                        .as_str()
                        .ok_or_else(|| Error::protocol("invalid reason"))?,
                )?;
            }
            "session.close" => {
                strict::exact(&o["args"], &["sessionId"], &["outcomeSummary"])?;
                session(&args["sessionId"])?;
                if let Some(outcome) = args.get("outcomeSummary") {
                    let _: OutcomeSummary = decode(outcome.clone())?;
                }
            }
            "operation.status" => {
                strict::exact(&o["args"], &["sessionId", "operationId"], &[])?;
                session(&args["sessionId"])?;
                strict::safe_id(&args["operationId"])?;
            }
            _ => return Err(Error::protocol("unknown control operation")),
        }
        Ok(())
    }
    fn response(value: &Json, context: &Json, operation: Option<&str>) -> Result<()> {
        let request_value = &context["request"];
        request(request_value)?;
        let req = request_value.as_object().unwrap();
        let req_op = req["op"].as_str().unwrap();
        let req_id = strict::safe_id(&req["id"])?;
        let o = strict::exact(value, &["v", "kind", "id", "ok"], &["result", "error"])?;
        if o["v"] != 1 || o["kind"] != "response" || strict::safe_id(&o["id"])? != req_id {
            return Err(Error::protocol("response correlation mismatch"));
        }
        let ok = o["ok"]
            .as_bool()
            .ok_or_else(|| Error::protocol("invalid response status"))?;
        if !ok {
            if o.contains_key("result") || !o.contains_key("error") {
                return Err(Error::protocol("invalid failure envelope"));
            }
            parse_server_error(&o["error"])?;
            return Ok(());
        }
        if !o.contains_key("result") || o.contains_key("error") {
            return Err(Error::protocol("invalid success envelope"));
        }
        let result = &o["result"];
        match req_op {
            "hello" => {
                let required = req["args"]["requiredCapabilities"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_owned())
                    .collect::<Vec<_>>();
                validate_hello_value(result, &required).map(|_| ())
            }
            "session.open" => {
                let r: SessionOpened = decode(result.clone())?;
                validate_handle(&r.session_id)
            }
            "authoring.exec" | "session.prepare" | "session.cancel" | "session.close" => {
                let r: Accepted = decode(result.clone())?;
                strict::safe_id(&json!(r.operation_id)).map(|_| ())
            }
            "session.authorize" => {
                let r: Authorized = decode(result.clone())?;
                validate_handle(&r.authorization_id)
            }
            "worker.acquire" => {
                let r: WorkerDescriptorWire = decode(result.clone())?;
                validate_handle(&r.worker_id)?;
                validate_hex(&r.attachment_token, 64)?;
                validate_endpoint(&r.endpoint.path)?;
                if r.endpoint.kind != "unix"
                    || r.release_mode != "control-v1"
                    || r.attachment_timeout_ms == 0
                    || r.attachment_timeout_ms > strict::SAFE_INTEGER
                {
                    return Err(Error::protocol("invalid descriptor"));
                }
                Ok(())
            }
            "worker.release" => {
                let r: ReleaseAccepted = decode(result.clone())?;
                strict::safe_id(&json!(r.operation_id))?;
                if !matches!(
                    r.cleanup_mode.as_str(),
                    "dispose-then-terminate" | "terminate-only"
                ) {
                    return Err(Error::protocol("invalid cleanup mode"));
                }
                Ok(())
            }
            "session.status" => {
                let r: SessionStatus = decode(result.clone())?;
                validate_session_status(&r)
            }
            "operation.status" => {
                let expected = strict::safe_id(&req["args"]["operationId"])?;
                let terminal = terminal_for(
                    operation.ok_or_else(|| Error::protocol("missing operation context"))?,
                )?;
                validate_operation_record(result, expected, terminal, false)
            }
            _ => Err(Error::protocol("unsupported response operation")),
        }
    }
    fn terminal_for(operation: &str) -> Result<&'static str> {
        match operation {
            "session.prepare" => Ok("Prepared"),
            "authoring.exec" => Ok("CommandResult"),
            "worker.release" | "session.cancel" | "session.close" => Ok("CleanupResult"),
            _ => Err(Error::protocol("unknown terminal operation")),
        }
    }
    fn attachment(value: &Json, reply: bool) -> Result<()> {
        let required = if reply {
            vec!["v", "kind", "sessionId", "workerId"]
        } else {
            vec!["v", "kind", "sessionId", "workerId", "attachmentToken"]
        };
        let o = strict::exact(value, &required, &[])?;
        if o["v"] != 1 || o["kind"] != if reply { "attached" } else { "attach" } {
            return Err(Error::protocol("invalid attachment envelope"));
        }
        session(&o["sessionId"])?;
        session(&o["workerId"])?;
        if !reply {
            validate_hex(
                o["attachmentToken"]
                    .as_str()
                    .ok_or_else(|| Error::protocol("invalid token"))?,
                64,
            )?;
        }
        Ok(())
    }
    fn event(value: &Json, operation: Option<&str>) -> Result<()> {
        let o = strict::exact(
            value,
            &["v", "kind", "seq", "sessionId", "event", "data"],
            &[],
        )?;
        if o["v"] != 1 || o["kind"] != "event" {
            return Err(Error::protocol("invalid event envelope"));
        }
        strict::safe_id(&o["seq"])?;
        session(&o["sessionId"])?;
        let name = o["event"]
            .as_str()
            .ok_or_else(|| Error::protocol("invalid event name"))?;
        let data = &o["data"];
        match name {
            "operation.finished" => {
                let id = strict::safe_id(&data["operationId"])?;
                validate_operation_record(
                    data,
                    id,
                    terminal_for(operation.ok_or_else(|| Error::protocol("missing operation"))?)?,
                    true,
                )
            }
            "authoring.output" | "build.output" => {
                let r = strict::exact(
                    data,
                    &["operationId", "stream", "chunk", "bytesBase64"],
                    &[],
                )?;
                strict::safe_id(&r["operationId"])?;
                strict::safe_id(&r["chunk"])?;
                if !matches!(r["stream"].as_str(), Some("stdout" | "stderr")) {
                    return Err(Error::protocol("invalid stream"));
                }
                let encoded = r["bytesBase64"]
                    .as_str()
                    .ok_or_else(|| Error::protocol("invalid base64"))?;
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|_| Error::protocol("invalid base64"))?;
                if bytes.len() > 16_384 || STANDARD.encode(&bytes) != encoded {
                    return Err(Error::protocol("invalid base64"));
                }
                Ok(())
            }
            "worker.started" | "worker.ready" => {
                let r = strict::exact(data, &["workerId"], &[])?;
                session(&r["workerId"])
            }
            "worker.closing" => {
                let r = strict::exact(data, &["workerId", "reason"], &[])?;
                session(&r["workerId"])?;
                validate_reason(
                    r["reason"]
                        .as_str()
                        .ok_or_else(|| Error::protocol("invalid reason"))?,
                )
            }
            "worker.exited" => {
                let r = strict::exact(data, &["workerId", "reason"], &["exitCode"])?;
                session(&r["workerId"])?;
                validate_reason(
                    r["reason"]
                        .as_str()
                        .ok_or_else(|| Error::protocol("invalid reason"))?,
                )
            }
            "session.closed" => {
                let r: CleanupResult = decode(data.clone())?;
                validate_cleanup(&r)
            }
            _ => Err(Error::protocol("unknown event")),
        }
    }
    #[test]
    fn all_control_vectors_match() {
        for (line_number, line) in include_str!("../../../conformance/control-v1/vectors.jsonl")
            .lines()
            .enumerate()
        {
            let context: Json = serde_json::from_str(line).unwrap();
            let kind = context["kind"].as_str().unwrap();
            let operation = context
                .get("operation")
                .and_then(Json::as_str)
                .and_then(|value| terminal_for(value).ok());
            let result = match kind {
                "request" => super::validate_control_request(&context["value"]),
                "response" => super::validate_control_response(
                    &context["value"],
                    &context["request"],
                    operation,
                ),
                "operation" => {
                    let id = strict::safe_id(&context["value"]["operationId"]).unwrap_or(1);
                    validate_operation_record(&context["value"], id, operation.unwrap_or(""), false)
                }
                "event" => super::validate_control_event(&context["value"], operation),
                "attachment" => super::validate_attachment(&context["value"], false),
                "attached" => super::validate_attachment(&context["value"], true),
                _ => panic!("unknown vector kind"),
            };
            assert_eq!(
                result.is_ok(),
                context["valid"].as_bool().unwrap(),
                "line {} {}: {:?}",
                line_number + 1,
                context["name"],
                result
            );
        }
    }
}

#[cfg(test)]
mod ownership_tests {
    use super::*;
    fn core() -> Arc<Mutex<Core>> {
        Arc::new(Mutex::new(Core {
            transport: None,
            options: ClientOptions::default(),
            next_request: 1,
            next_event: 1,
            hello: None,
            sessions: HashSet::new(),
            operations: HashMap::new(),
            workers: HashSet::new(),
            output_chunks: HashMap::new(),
            events: VecDeque::new(),
            event_bytes: 0,
            closed: false,
        }))
    }
    fn session(owner: &Arc<Mutex<Core>>, id: &str) -> Session {
        owner.lock().unwrap().sessions.insert(id.into());
        Session {
            owner: Arc::downgrade(owner),
            id: id.into(),
            runtime: "node-v1".into(),
            manifest_json: "{}".into(),
        }
    }
    #[test]
    fn forged_or_foreign_authorization_is_rejected_before_transport() {
        let first = core();
        let second = core();
        let left = session(&first, "11111111111111111111111111111111");
        let right = session(&second, "22222222222222222222222222222222");
        let authorization = Authorization {
            owner: left.owner.clone(),
            session_id: left.id.clone(),
            id: "33333333333333333333333333333333".into(),
        };
        let error = right.acquire_worker(authorization).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Handle);
        assert!(!second.lock().unwrap().closed);
    }
    #[test]
    fn stale_session_and_operation_handles_fail_after_owner_drop() {
        let owner = core();
        let session = session(&owner, "11111111111111111111111111111111");
        let operation = session
            .operation::<CleanupResult>(1, "CleanupResult")
            .unwrap();
        drop(owner);
        assert_eq!(session.status().unwrap_err().kind, ErrorKind::Handle);
        assert_eq!(operation.status().unwrap_err().kind, ErrorKind::Handle);
    }
    #[test]
    fn concurrent_sessions_keep_operation_ownership_separate() {
        let owner = core();
        let first = session(&owner, "11111111111111111111111111111111");
        let second = session(&owner, "22222222222222222222222222222222");
        assert!(first.operation::<CleanupResult>(1, "CleanupResult").is_ok());
        assert!(
            second
                .operation::<CleanupResult>(1, "CleanupResult")
                .is_ok()
        );
        assert_eq!(owner.lock().unwrap().operations.len(), 2);
    }
    #[test]
    fn cleanup_operation_can_be_joined_but_not_retyped() {
        let owner = core();
        let session = session(&owner, "11111111111111111111111111111111");
        assert!(
            session
                .operation::<CleanupResult>(1, "CleanupResult")
                .is_ok()
        );
        assert!(
            session
                .operation::<CleanupResult>(1, "CleanupResult")
                .is_ok()
        );
        assert!(session.operation::<Prepared>(1, "Prepared").is_err());
        assert!(owner.lock().unwrap().closed);
    }
}

#[cfg(test)]
mod boundary_tests {
    use super::*;

    fn hello() -> Json {
        json!({
            "controlVersion": 1,
            "instanceId": "11111111111111111111111111111111",
            "capabilities": [{
                "id": "control.local-stdio-v1",
                "available": true,
                "enforcedScope": "connection",
                "limits": {}
            }],
            "limits": {
                "maxFrameBytes": 1048576,
                "maxJsonDepth": 128,
                "maxJsonNodes": 16384,
                "maxPendingOutputBytes": 4194304,
                "maxSessionsPerConnection": 4,
                "maxInflightRequestsPerConnection": 16,
                "maxCompletedOperationsPerSession": 128,
                "helloTimeoutMs": 5000,
                "requestAckTimeoutMs": 5000,
                "workerAttachmentTimeoutMs": 5000,
                "sessionWallMs": 600000,
                "gracefulStopMs": 1000,
                "teardownMs": 5000
            }
        })
    }

    fn vector_request(name: &str) -> Json {
        include_str!("../../../conformance/control-v1/vectors.jsonl")
            .lines()
            .map(|line| serde_json::from_str::<Json>(line).unwrap())
            .find(|vector| vector["name"] == name)
            .unwrap()["value"]
            .clone()
    }

    #[test]
    fn valid_hello_keeps_existing_semantics() {
        assert!(validate_hello_value(&hello(), &["control.local-stdio-v1".into()]).is_ok());
    }

    #[test]
    fn hello_rejects_non_hex_instance_id() {
        let mut value = hello();
        value["instanceId"] = json!("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");
        assert!(validate_hello_value(&value, &[]).is_err());
    }

    #[test]
    fn hello_rejects_invalid_unavailable_reason() {
        let mut value = hello();
        value["capabilities"][0] = json!({
            "id": "worker.node-v1",
            "available": false,
            "enforcedScope": "none",
            "limits": {},
            "reason": "not available"
        });
        assert!(validate_hello_value(&value, &[]).is_err());
    }

    #[test]
    fn hello_rejects_unknown_capability_limit() {
        let mut value = hello();
        value["capabilities"][0]["limits"] = json!({"privateLimit": 1});
        assert!(validate_hello_value(&value, &[]).is_err());
    }

    #[test]
    fn hello_rejects_available_capability_with_explicit_null_reason() {
        let mut value = hello();
        value["capabilities"][0]["reason"] = Json::Null;
        assert!(validate_hello_value(&value, &[]).is_err());
    }

    #[test]
    fn optional_session_fields_reject_explicit_null() {
        for field in ["limits", "modelRevisionId"] {
            let mut request = vector_request("open-source-request");
            request["args"][field] = Json::Null;
            assert!(validate_control_request(&request).is_err(), "{field}");
        }
        let mut request = vector_request("open-source-request");
        request["args"]["limits"]["sessionWallMs"] = Json::Null;
        assert!(validate_control_request(&request).is_err());
    }

    #[test]
    fn outcome_failure_family_rejects_explicit_null() {
        let request = json!({
            "v": 1,
            "kind": "request",
            "id": 1,
            "op": "session.close",
            "args": {
                "sessionId": "22222222222222222222222222222222",
                "outcomeSummary": {"status": "failed", "failureFamily": null}
            }
        });
        assert!(validate_control_request(&request).is_err());
    }

    #[test]
    fn prepared_source_hash_rejects_explicit_null() {
        let prepared = json!({
            "preparedRevision": 1,
            "artifactId": "33333333333333333333333333333333",
            "artifactHash": "0".repeat(64),
            "sourceHash": null,
            "manifestHash": "1".repeat(64),
            "runtime": "node-v1",
            "policyId": "default",
            "challenge": "44444444444444444444444444444444"
        });
        assert!(validate_prepared(&prepared).is_err());
    }

    #[test]
    fn command_exit_code_must_be_a_safe_signed_integer() {
        assert!(
            validate_command(&json!({
                "exitCode": i64::try_from(strict::SAFE_INTEGER).unwrap(),
                "stdoutBytes": 0,
                "stderrBytes": 0
            }))
            .is_ok()
        );
        assert!(
            validate_command(&json!({
                "exitCode": i64::try_from(strict::SAFE_INTEGER).unwrap() + 1,
                "stdoutBytes": 0,
                "stderrBytes": 0
            }))
            .is_err()
        );
    }
}
