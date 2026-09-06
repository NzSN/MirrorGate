use crate::{
    manifest::{Manifest, valid_digest},
    strict,
};
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
};

#[derive(Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);
impl CancellationToken {
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
    pub fn check(&self) -> Result<(), WorkerError> {
        if self.is_cancelled() {
            Err(WorkerError::new("operation cancelled"))
        } else {
            Ok(())
        }
    }
    fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
}

#[derive(Debug)]
pub struct WorkerError {
    pub message: String,
}
impl WorkerError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}
impl From<String> for WorkerError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}
impl From<&str> for WorkerError {
    fn from(message: &str) -> Self {
        Self::new(message)
    }
}

/// Implement a public generated port using the actual application's operations
/// and observations. The SDK validates all input/output values against the
/// admitted public manifest. Native conversions belong to this adapter.
pub trait Adapter: Send + 'static {
    fn invoke(
        &mut self,
        action: &str,
        inputs: &Value,
        cancellation: &CancellationToken,
    ) -> Result<(), WorkerError>;
    fn observe(&mut self, cancellation: &CancellationToken) -> Result<Value, WorkerError>;
    fn dispose(&mut self, _cancellation: &CancellationToken) -> Result<(), WorkerError> {
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub enum OperationRequest {
    Hello {
        interface_digest: String,
        runtime: String,
    },
    Create,
    Invoke {
        action: String,
        inputs: Value,
    },
    Observe,
    Cancel {
        request_id: u64,
    },
    Dispose,
}

#[derive(Debug, Clone)]
pub struct Request {
    pub id: u64,
    pub operation: OperationRequest,
}

fn request_id(value: &Value) -> Result<u64, String> {
    let id = value
        .as_u64()
        .ok_or("request ID must be positive integer")?;
    if id == 0 || id > 9_007_199_254_740_991 {
        return Err("request ID out of range".into());
    }
    Ok(id)
}

pub fn validate_request(value: &Value) -> Result<Request, String> {
    strict::check_bounds(value)?;
    let object = value.as_object().ok_or("request must be object")?;
    if object.get("v") != Some(&json!(1)) {
        return Err("unsupported protocol version".into());
    }
    let id = request_id(object.get("id").ok_or("missing request ID")?)?;
    let op = object
        .get("op")
        .and_then(Value::as_str)
        .ok_or("missing operation")?;
    let operation = match op {
        "hello" => {
            strict::exact(value, &["v", "id", "op", "interfaceDigest", "runtime"])?;
            let digest = object["interfaceDigest"].as_str().ok_or("invalid digest")?;
            if !valid_digest(digest) {
                return Err("invalid digest".into());
            }
            let runtime = strict::identifier(&object["runtime"])?;
            OperationRequest::Hello {
                interface_digest: digest.into(),
                runtime: runtime.into(),
            }
        }
        "create" | "observe" | "dispose" => {
            strict::exact(value, &["v", "id", "op"])?;
            match op {
                "create" => OperationRequest::Create,
                "observe" => OperationRequest::Observe,
                _ => OperationRequest::Dispose,
            }
        }
        "invoke" => {
            strict::exact(value, &["v", "id", "op", "action", "inputs"])?;
            let action = strict::identifier(&object["action"])?;
            if !object["inputs"].is_object() {
                return Err("inputs must be object".into());
            }
            for key in object["inputs"].as_object().unwrap().keys() {
                strict::identifier(&Value::String(key.clone()))?;
            }
            OperationRequest::Invoke {
                action: action.into(),
                inputs: object["inputs"].clone(),
            }
        }
        "cancel" => {
            strict::exact(value, &["v", "id", "op", "requestId"])?;
            let target = request_id(&object["requestId"])?;
            if target >= id {
                return Err("cancel target must precede its request ID".into());
            }
            OperationRequest::Cancel { request_id: target }
        }
        _ => return Err("unknown operation".into()),
    };
    Ok(Request { id, operation })
}

pub fn validate_response(value: &Value) -> Result<(), String> {
    strict::check_bounds(value)?;
    let object = value.as_object().ok_or("response must be object")?;
    if object.get("v") != Some(&json!(1)) {
        return Err("unsupported protocol version".into());
    }
    request_id(object.get("id").ok_or("missing response ID")?)?;
    match object.get("ok") {
        Some(Value::Bool(true)) => {
            strict::exact(value, &["v", "id", "ok", "result"])?;
        }
        Some(Value::Bool(false)) => {
            strict::exact(value, &["v", "id", "ok", "error"])?;
            let error = strict::exact(&object["error"], &["code", "message"])?;
            let code = error["code"].as_str().ok_or("error code must be string")?;
            if code.is_empty()
                || code.len() > 64
                || !code.as_bytes()[0].is_ascii_uppercase()
                || !code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            {
                return Err("invalid error code".into());
            }
            if error["message"]
                .as_str()
                .ok_or("error message must be string")?
                .len()
                > 1024
            {
                return Err("error message too long".into());
            }
        }
        _ => return Err("response ok must be boolean".into()),
    }
    Ok(())
}

enum Event {
    Request(Value),
    ReaderError(String),
    Eof,
    Complete {
        id: u64,
        result: Result<Value, WorkerError>,
    },
}
enum CommandKind {
    Create,
    Invoke { action: String, inputs: Value },
    Observe,
    Dispose,
}
struct Command {
    id: u64,
    kind: CommandKind,
    cancellation: CancellationToken,
}
#[derive(Clone, Copy, PartialEq)]
enum State {
    Hello,
    Create,
    Initialize,
    Observe,
    Ready,
    Poisoned,
}
struct Pending {
    id: u64,
    next_state: State,
    dispose: bool,
    observation: bool,
    cancellation: CancellationToken,
}

fn success(id: u64, result: Value) -> Value {
    json!({"v":1,"id":id,"ok":true,"result":result})
}
fn failure(id: u64, code: &str, message: &str) -> Value {
    let mut end = message.len().min(1024);
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    json!({"v":1,"id":id,"ok":false,"error":{"code":code,"message":&message[..end]}})
}

fn output(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    // Reparse to enforce aggregate node/depth limits on application output, too.
    strict::parse(&bytes, strict::MAX_FRAME_BYTES)?;
    writer
        .write_all(&bytes)
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|e| e.to_string())
}

fn reader(sender: mpsc::SyncSender<Event>) {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    loop {
        let mut bytes = Vec::new();
        loop {
            let buffer = match reader.fill_buf() {
                Ok(buffer) => buffer,
                Err(e) => {
                    let _ = sender.send(Event::ReaderError(e.to_string()));
                    return;
                }
            };
            if buffer.is_empty() {
                let event = if bytes.is_empty() {
                    Event::Eof
                } else {
                    Event::ReaderError("unterminated frame".into())
                };
                let _ = sender.send(event);
                return;
            }
            let length = buffer
                .iter()
                .position(|b| *b == b'\n')
                .map_or(buffer.len(), |p| p + 1);
            if bytes.len() + length > strict::MAX_FRAME_BYTES + 1 {
                let _ = sender.send(Event::ReaderError("frame byte limit exceeded".into()));
                return;
            }
            bytes.extend_from_slice(&buffer[..length]);
            reader.consume(length);
            if bytes.last() == Some(&b'\n') {
                break;
            }
        }
        match strict::frame(&bytes) {
            Ok(value) => {
                if sender.send(Event::Request(value)).is_err() {
                    return;
                }
            }
            Err(e) => {
                let _ = sender.send(Event::ReaderError(e));
                return;
            }
        }
    }
}

/// Run one stdio worker session. Factories are called only after a valid hello
/// and create. Callbacks execute on a dedicated thread; the controller continues
/// to receive cancellation. Tokens are cooperative; use supervisor termination
/// for a callback that fails to cooperate. No timed-out mutation is retried.
pub fn run_worker<F>(manifest: Manifest, runtime: &str, factory: F) -> Result<(), String>
where
    F: FnOnce(&Manifest, &CancellationToken) -> Result<Box<dyn Adapter>, WorkerError>
        + Send
        + 'static,
{
    strict::identifier(&Value::String(runtime.into()))?;
    // Bound queued decoded input as well as individual frames.
    let (events, incoming) = mpsc::sync_channel(4);
    let (commands, work) = mpsc::channel::<Command>();
    let callback_events = events.clone();
    let callback_manifest = manifest.clone();
    thread::spawn(move || {
        let mut factory = Some(factory);
        let mut adapter: Option<Box<dyn Adapter>> = None;
        for command in work {
            let result = catch_unwind(AssertUnwindSafe(|| -> Result<Value, WorkerError> {
                match command.kind {
                    CommandKind::Create => {
                        adapter = Some(factory.take().ok_or("factory already used")?(
                            &callback_manifest,
                            &command.cancellation,
                        )?);
                        Ok(Value::Null)
                    }
                    CommandKind::Invoke { action, inputs } => {
                        adapter
                            .as_mut()
                            .ok_or("adapter is not constructed")?
                            .invoke(&action, &inputs, &command.cancellation)?;
                        Ok(Value::Null)
                    }
                    CommandKind::Observe => adapter
                        .as_mut()
                        .ok_or("adapter is not constructed")?
                        .observe(&command.cancellation),
                    CommandKind::Dispose => {
                        if let Some(mut adapter) = adapter.take() {
                            adapter.dispose(&command.cancellation)?;
                        }
                        Ok(Value::Null)
                    }
                }
            }))
            .unwrap_or_else(|_| Err(WorkerError::new("adapter callback panicked")));
            if callback_events
                .send(Event::Complete {
                    id: command.id,
                    result,
                })
                .is_err()
            {
                break;
            }
        }
    });
    thread::spawn(move || reader(events));
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    let mut state = State::Hello;
    let mut pending: Option<Pending> = None;
    let mut last_id = 0;
    loop {
        match incoming.recv().map_err(|_| "worker event channel closed")? {
            Event::Eof => {
                return if pending.is_none() {
                    Ok(())
                } else {
                    Err("EOF with pending operation".into())
                };
            }
            Event::ReaderError(error) => return Err(error),
            Event::Complete { id, result } => {
                if pending.as_ref().is_none_or(|p| p.id != id) {
                    continue;
                }
                let operation = pending.take().unwrap();
                match result {
                    Ok(value) => {
                        let invalid = operation
                            .observation
                            .then(|| manifest.validate_observations(&value))
                            .transpose();
                        if let Err(error) = invalid {
                            state = State::Poisoned;
                            output(&mut writer, &failure(id, "VALUE", &error))?;
                        } else {
                            let response = success(id, value);
                            let encoding =
                                serde_json::to_vec(&response).map_err(|e| e.to_string())?;
                            if strict::parse(&encoding, strict::MAX_FRAME_BYTES).is_err() {
                                state = State::Poisoned;
                                output(
                                    &mut writer,
                                    &failure(id, "VALUE", "response resource limit exceeded"),
                                )?;
                            } else {
                                state = operation.next_state;
                                output(&mut writer, &response)?;
                            }
                        }
                    }
                    Err(error) => {
                        state = State::Poisoned;
                        output(&mut writer, &failure(id, "APPLICATION", &error.message))?;
                    }
                }
                if operation.dispose {
                    return Ok(());
                }
            }
            Event::Request(value) => {
                let request = validate_request(&value)?;
                if request.id <= last_id {
                    return Err("request IDs must strictly increase".into());
                }
                last_id = request.id;
                if let Some(operation) = pending.take() {
                    if let OperationRequest::Cancel { request_id } = request.operation {
                        if request_id != operation.id || operation.dispose {
                            return Err("cancel target is not a cancellable pending request".into());
                        }
                        operation.cancellation.cancel();
                        state = State::Poisoned;
                        output(
                            &mut writer,
                            &failure(operation.id, "CANCELLED", "operation cancelled"),
                        )?;
                        output(&mut writer, &success(request.id, Value::Null))?;
                        continue;
                    }
                    return Err("operation pipelining is forbidden".into());
                }
                let id = request.id;
                let mut error: Option<(&str, String)> = None;
                let mut command: Option<(CommandKind, State, bool, bool)> = None;
                match request.operation {
                    OperationRequest::Hello {
                        interface_digest,
                        runtime: requested_runtime,
                    } if state == State::Hello => {
                        if interface_digest != manifest.interface_digest
                            || requested_runtime != runtime
                        {
                            error =
                                Some(("HANDSHAKE", "interface digest or runtime mismatch".into()));
                        } else {
                            state = State::Create;
                            output(
                                &mut writer,
                                &success(
                                    id,
                                    json!({"interfaceDigest":manifest.interface_digest,"runtime":runtime}),
                                ),
                            )?;
                        }
                    }
                    OperationRequest::Create if state == State::Create => {
                        command = Some((CommandKind::Create, State::Initialize, false, false))
                    }
                    OperationRequest::Invoke { action, inputs }
                        if state == State::Initialize || state == State::Ready =>
                    {
                        let initializer = manifest.initializers.contains_key(&action);
                        if state == State::Initialize && !initializer {
                            error = Some(("LIFECYCLE", "initialization is required".into()));
                        } else if let Some(operation) = manifest.operation(&action) {
                            match operation.validate_inputs(&inputs) {
                                Ok(()) => {
                                    command = Some((
                                        CommandKind::Invoke { action, inputs },
                                        State::Observe,
                                        false,
                                        false,
                                    ))
                                }
                                Err(e) => error = Some(("VALUE", e)),
                            }
                        } else {
                            error = Some(("VALUE", "unknown action ID".into()));
                        }
                    }
                    OperationRequest::Observe if state == State::Observe => {
                        command = Some((CommandKind::Observe, State::Ready, false, true))
                    }
                    OperationRequest::Dispose if state != State::Hello => {
                        command = Some((CommandKind::Dispose, State::Poisoned, true, false))
                    }
                    _ => {
                        error = Some((
                            "LIFECYCLE",
                            "operation is invalid in the current lifecycle state".into(),
                        ))
                    }
                }
                if let Some((code, message)) = error {
                    state = State::Poisoned;
                    output(&mut writer, &failure(id, code, &message))?;
                }
                if let Some((kind, next_state, dispose, observation)) = command {
                    let cancellation = CancellationToken::default();
                    pending = Some(Pending {
                        id,
                        next_state,
                        dispose,
                        observation,
                        cancellation: cancellation.clone(),
                    });
                    commands
                        .send(Command {
                            id,
                            kind,
                            cancellation,
                        })
                        .map_err(|_| "callback thread unavailable")?;
                }
            }
        }
    }
}
