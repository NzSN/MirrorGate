use crate::{
    CleanupResult, Error, ErrorKind, Operation, OperationOutcome, PublicManifest, Result, Value,
    WorkerReservation, strict,
};
use serde_json::{Value as Json, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Default)]
pub struct CancellationToken(Arc<AtomicBool>);
impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug)]
pub struct WorkerOptions {
    pub call_timeout: Duration,
    pub cleanup_timeout: Duration,
}
impl Default for WorkerOptions {
    fn default() -> Self {
        Self {
            call_timeout: Duration::from_secs(10),
            cleanup_timeout: Duration::from_secs(5),
        }
    }
}
#[derive(Clone, Debug)]
pub struct WorkerCallOptions {
    pub timeout: Duration,
    pub cancellation: Option<CancellationToken>,
}
impl Default for WorkerCallOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(10),
            cancellation: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct WorkerFinishReport {
    pub primary: Option<Error>,
    pub cleanup: Option<OperationOutcome<CleanupResult>>,
    pub cleanup_error: Option<Error>,
    pub cooperative_dispose: bool,
}
impl WorkerFinishReport {
    #[must_use]
    pub fn cleanup_confirmed(&self) -> bool {
        matches!(&self.cleanup,Some(OperationOutcome::Succeeded(result)) if result.phase==crate::SessionPhase::Closed&&result.cleanup_status==crate::CleanupStatus::Succeeded&&result.remaining_resources.is_empty())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    NeedInitializer,
    NeedObserve,
    ReadyAction,
    Poisoned,
    Closed,
}

pub struct ManagedWorker {
    session: crate::Session,
    worker_id: String,
    manifest: PublicManifest,
    runtime: String,
    transport: Option<crate::transport::Transport>,
    state: State,
    next_id: u64,
    options: WorkerOptions,
    primary: Option<Error>,
    session_cleanup: Option<Operation<CleanupResult>>,
    finished: bool,
}

impl WorkerReservation {
    pub fn connect(
        mut self,
        manifest: PublicManifest,
        runtime: impl Into<String>,
        options: WorkerOptions,
    ) -> Result<ManagedWorker> {
        if self.consumed {
            return Err(Error::handle("worker reservation already consumed"));
        }
        let runtime = runtime.into();
        if runtime != self.session.runtime() {
            return Err(Error::argument(
                "worker runtime differs from session runtime",
            ));
        }
        if options.call_timeout.is_zero() || options.cleanup_timeout.is_zero() {
            return Err(Error::argument("worker deadlines must be positive"));
        }
        self.consumed = true;
        let mut transport = match crate::transport::Transport::connect_unix(
            std::path::Path::new(&self.endpoint),
            self.attachment_timeout,
            self.attachment_timeout,
        ) {
            Ok(t) => t,
            Err(error) => {
                cleanup_partial(&self.session, &self.id, options.cleanup_timeout);
                return Err(error);
            }
        };
        let attach = json!({"v":1,"kind":"attach","sessionId":self.session.id(),"workerId":self.id,"attachmentToken":self.attachment_token});
        let attached = (|| {
            crate::control::validate_attachment(&attach, false)?;
            let encoded = strict::encode(&attach, strict::ATTACHMENT_LIMITS)?;
            transport.write_frame(&encoded, strict::ATTACHMENT_BYTES)?;
            let frame = transport.read_frame(strict::ATTACHMENT_BYTES, self.attachment_timeout)?;
            let reply = strict::parse(&frame, strict::ATTACHMENT_LIMITS)?;
            crate::control::validate_attachment(&reply, true)?;
            let object = reply
                .as_object()
                .ok_or_else(|| Error::worker("invalid worker attachment acknowledgement"))?;
            if object["sessionId"] != self.session.id() || object["workerId"] != self.id {
                return Err(Error::worker("invalid worker attachment acknowledgement"));
            }
            Ok(())
        })();
        if let Err(error) = attached {
            let _ = transport.close();
            cleanup_partial(&self.session, &self.id, options.cleanup_timeout);
            return Err(error);
        }
        let mut worker = ManagedWorker {
            session: self.session.clone(),
            worker_id: self.id.clone(),
            manifest,
            runtime,
            transport: Some(transport),
            state: State::Poisoned,
            next_id: 1,
            options,
            primary: None,
            session_cleanup: None,
            finished: false,
        };
        let startup = WorkerCallOptions {
            timeout: self.attachment_timeout,
            cancellation: None,
        };
        let initialized = (|| {
            let hello=worker.call_raw("hello",json!({"interfaceDigest":worker.manifest.interface_digest(),"runtime":worker.runtime}),&startup)?;
            let object = strict::exact(&hello, &["interfaceDigest", "runtime"], &[])?;
            if object["interfaceDigest"] != worker.manifest.interface_digest()
                || object["runtime"] != worker.runtime
            {
                return Err(Error::worker("worker identity mismatch"));
            }
            let create = worker.call_raw("create", json!({}), &startup)?;
            if !create.is_null() {
                return Err(Error::worker("create result must be null"));
            }
            worker.state = State::NeedInitializer;
            Ok(())
        })();
        if let Err(error) = initialized {
            worker.remember(error.clone());
            let _ = worker.finish_mut("client-failure");
            return Err(error);
        }
        Ok(worker)
    }
}
impl Drop for WorkerReservation {
    fn drop(&mut self) {
        if !self.consumed {
            self.consumed = true;
            if let Ok((operation, _)) = self.session.release_worker(&self.id, "client-failure") {
                let _ = operation.wait(Duration::from_secs(5));
            }
        }
    }
}

impl ManagedWorker {
    pub fn invoke(
        &mut self,
        operation: &str,
        inputs: &BTreeMap<String, Value>,
        call: WorkerCallOptions,
    ) -> Result<()> {
        if !matches!(self.state, State::NeedInitializer | State::ReadyAction)
            || (self.state == State::NeedInitializer && !self.manifest.is_initializer(operation))
        {
            return Err(Error::worker(
                "worker invocation is invalid in current state",
            ));
        }
        let wire = self.manifest.encode_inputs(operation, inputs)?;
        let result = self.call_raw("invoke", json!({"action":operation,"inputs":wire}), &call)?;
        if !result.is_null() {
            return self.fail(Error::worker("invoke result must be null"));
        }
        self.state = State::NeedObserve;
        Ok(())
    }
    pub fn observe(&mut self, call: WorkerCallOptions) -> Result<BTreeMap<String, Value>> {
        if self.state != State::NeedObserve {
            return Err(Error::worker("observation requires a completed invocation"));
        }
        let result = self.call_raw("observe", json!({}), &call)?;
        match self.manifest.decode_observations(&result) {
            Ok(values) => {
                self.state = State::ReadyAction;
                Ok(values)
            }
            Err(error) => self.fail_with_cleanup(error, "worker-failure"),
        }
    }
    pub fn finish(mut self, reason: &str) -> WorkerFinishReport {
        self.finish_mut(reason)
    }
    fn call_raw(
        &mut self,
        operation: &str,
        fields: Json,
        options: &WorkerCallOptions,
    ) -> Result<Json> {
        if matches!(self.state, State::Closed) {
            return Err(Error::worker("worker is closed"));
        }
        if options.timeout.is_zero() {
            return Err(Error::argument("worker deadline must be positive"));
        }
        if options
            .cancellation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(Error::cancelled("worker call cancelled before dispatch"));
        }
        if self.next_id > strict::SAFE_INTEGER {
            return self.fail(Error::limit("worker request ID exhausted"));
        }
        let id = self.next_id;
        self.next_id += 1;
        let mut request = json!({"v":1,"id":id,"op":operation});
        if let (Some(target), Some(source)) = (request.as_object_mut(), fields.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        let encoded = strict::encode(&request, strict::WORKER_LIMITS)?;
        let sent = self
            .transport
            .as_mut()
            .ok_or_else(|| Error::worker("worker transport unavailable"))?
            .write_frame(&encoded, strict::WORKER_FRAME_BYTES);
        if let Err(error) = sent {
            return self.fail_with_cleanup(error, "client-failure");
        }
        let deadline = Instant::now() + options.timeout;
        loop {
            if options
                .cancellation
                .as_ref()
                .is_some_and(CancellationToken::is_cancelled)
            {
                self.cancel_pending(id, "user-cancel");
                return self.fail(Error::cancelled("worker call cancelled"));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.cancel_pending(id, "deadline");
                return self.fail(Error::deadline("worker call deadline exceeded"));
            }
            let slice = remaining.min(Duration::from_millis(10));
            let frame = match self
                .transport
                .as_mut()
                .ok_or_else(|| Error::worker("worker transport unavailable"))?
                .read_frame(strict::WORKER_FRAME_BYTES, slice)
            {
                Ok(v) => v,
                Err(error) if matches!(error.kind, ErrorKind::Deadline) => continue,
                Err(error) => return self.fail_with_cleanup(error, "client-failure"),
            };
            let response = match strict::parse(&frame, strict::WORKER_LIMITS)
                .and_then(|value| validate_worker_response(value, id))
            {
                Ok(v) => v,
                Err(error) => return self.fail_with_cleanup(error, "client-failure"),
            };
            if response["ok"] == true {
                return Ok(response["result"].clone());
            }
            let error = &response["error"];
            let code = error["code"].as_str().unwrap_or("WORKER_PROTOCOL_FAILED");
            let message = error["message"].as_str().unwrap_or("worker failure");
            return self.fail_with_cleanup(
                Error::worker(format!("{code}: {message}")),
                "worker-failure",
            );
        }
    }
    fn cancel_pending(&mut self, pending: u64, reason: &str) {
        self.start_session_cleanup(reason);
        if self.next_id > strict::SAFE_INTEGER {
            return;
        }
        let cancel_id = self.next_id;
        self.next_id += 1;
        let request = json!({"v":1,"id":cancel_id,"op":"cancel","requestId":pending});
        let Some(transport) = self.transport.as_mut() else {
            return;
        };
        let Ok(encoded) = strict::encode(&request, strict::WORKER_LIMITS) else {
            return;
        };
        if transport
            .write_frame(&encoded, strict::WORKER_FRAME_BYTES)
            .is_err()
        {
            return;
        }
        let first = transport
            .read_frame(strict::WORKER_FRAME_BYTES, Duration::from_millis(250))
            .and_then(|v| strict::parse(&v, strict::WORKER_LIMITS))
            .and_then(|v| validate_worker_response(v, pending));
        if !matches!(first,Ok(ref v)if v["ok"]==false&&v["error"]["code"]=="CANCELLED") {
            return;
        }
        let _ = transport
            .read_frame(strict::WORKER_FRAME_BYTES, Duration::from_millis(250))
            .and_then(|v| strict::parse(&v, strict::WORKER_LIMITS))
            .and_then(|v| validate_worker_response(v, cancel_id));
    }
    fn start_session_cleanup(&mut self, reason: &str) {
        if self.session_cleanup.is_none() {
            self.session_cleanup = self.session.cancel(reason).ok();
        }
    }
    fn remember(&mut self, error: Error) {
        if self.primary.is_none() {
            self.primary = Some(error);
        }
    }
    fn fail<T>(&mut self, error: Error) -> Result<T> {
        self.state = State::Poisoned;
        self.remember(error.clone());
        Err(error)
    }
    fn fail_with_cleanup<T>(&mut self, error: Error, reason: &str) -> Result<T> {
        self.start_session_cleanup(reason);
        self.fail(error)
    }
    fn finish_mut(&mut self, reason: &str) -> WorkerFinishReport {
        if self.finished {
            return WorkerFinishReport {
                primary: self.primary.clone(),
                cleanup: None,
                cleanup_error: Some(Error::handle("worker already finished")),
                cooperative_dispose: false,
            };
        }
        self.finished = true;
        let mut cooperative = false;
        let mut cleanup_error = None;
        let operation = if let Some(operation) = self.session_cleanup.take() {
            Some(operation)
        } else {
            match self.session.release_worker(&self.worker_id, reason) {
                Ok((operation, mode)) => {
                    if mode == "dispose-then-terminate"
                        && !matches!(self.state, State::Poisoned | State::Closed)
                    {
                        cooperative = true;
                        if let Err(error) = self.call_raw(
                            "dispose",
                            json!({}),
                            &WorkerCallOptions {
                                timeout: self.options.cleanup_timeout,
                                cancellation: None,
                            },
                        ) {
                            self.remember(error);
                        }
                    }
                    Some(operation)
                }
                Err(error) => {
                    cleanup_error = Some(error);
                    None
                }
            }
        };
        self.state = State::Closed;
        if let Some(transport) = self.transport.as_mut() {
            let _ = transport.close();
        }
        self.transport = None;
        let cleanup =
            operation.and_then(
                |operation| match operation.wait(self.options.cleanup_timeout) {
                    Ok(value) => Some(value),
                    Err(error) => {
                        cleanup_error = Some(error);
                        None
                    }
                },
            );
        WorkerFinishReport {
            primary: self.primary.clone(),
            cleanup,
            cleanup_error,
            cooperative_dispose: cooperative,
        }
    }
}
impl Drop for ManagedWorker {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.finish_mut(if self.primary.is_some() {
                "client-failure"
            } else {
                "normal"
            });
        }
    }
}

fn cleanup_partial(session: &crate::Session, worker_id: &str, timeout: Duration) {
    if let Ok((operation, _)) = session.release_worker(worker_id, "client-failure") {
        let _ = operation.wait(timeout);
    }
}
fn validate_worker_response(value: Json, id: u64) -> Result<Json> {
    let object = strict::exact(&value, &["v", "id", "ok"], &["result", "error"])?;
    if object["v"] != 1 || strict::safe_id(&object["id"])? != id {
        return Err(Error::worker("uncorrelated worker response"));
    }
    let ok = object["ok"]
        .as_bool()
        .ok_or_else(|| Error::worker("invalid worker response status"))?;
    if ok {
        if !object.contains_key("result") || object.contains_key("error") {
            return Err(Error::worker("invalid worker success"));
        }
    } else {
        if object.contains_key("result") || !object.contains_key("error") {
            return Err(Error::worker("invalid worker failure"));
        }
        let error = strict::exact(&object["error"], &["code", "message"], &[])?;
        let code = strict::string(&error["code"], 64)?;
        if code.is_empty()
            || !code.bytes().next().is_some_and(|b| b.is_ascii_uppercase())
            || !code
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        {
            return Err(Error::worker("invalid worker error code"));
        }
        strict::string(&error["message"], 1024)?;
    }
    Ok(value)
}

#[cfg(test)]
mod vectors {
    use super::*;
    fn from_hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
            .collect()
    }
    fn frame(context: &Json) -> Result<()> {
        let bytes = from_hex(context["hex"].as_str().unwrap());
        if bytes.last() != Some(&b'\n')
            || bytes[..bytes.len().saturating_sub(1)].contains(&b'\n')
            || bytes.contains(&b'\r')
        {
            return Err(Error::protocol("invalid worker frame"));
        }
        let value = strict::parse(&bytes[..bytes.len() - 1], strict::WORKER_LIMITS)?;
        if !value.is_object() {
            return Err(Error::protocol("worker frame must be object"));
        }
        Ok(())
    }
    fn request(value: &Json) -> Result<()> {
        let object = value
            .as_object()
            .ok_or_else(|| Error::protocol("request must be object"))?;
        if object.get("v") != Some(&json!(1)) {
            return Err(Error::protocol("invalid request version"));
        }
        let id = strict::safe_id(
            object
                .get("id")
                .ok_or_else(|| Error::protocol("missing id"))?,
        )?;
        let op = object
            .get("op")
            .and_then(Json::as_str)
            .ok_or_else(|| Error::protocol("missing op"))?;
        match op {
            "hello" => {
                strict::exact(value, &["v", "id", "op", "interfaceDigest", "runtime"], &[])?;
                strict::digest(&object["interfaceDigest"])?;
                strict::identifier(&object["runtime"])?;
            }
            "create" | "observe" | "dispose" => {
                strict::exact(value, &["v", "id", "op"], &[])?;
            }
            "invoke" => {
                strict::exact(value, &["v", "id", "op", "action", "inputs"], &[])?;
                strict::identifier(&object["action"])?;
                if !object["inputs"].is_object() {
                    return Err(Error::protocol("inputs must be object"));
                }
            }
            "cancel" => {
                strict::exact(value, &["v", "id", "op", "requestId"], &[])?;
                let target = strict::safe_id(&object["requestId"])?;
                if target >= id {
                    return Err(Error::protocol("cancel must target earlier request"));
                }
            }
            _ => return Err(Error::protocol("unknown worker operation")),
        }
        Ok(())
    }
    fn response(value: Json) -> Result<()> {
        let id = value.get("id").and_then(Json::as_u64).unwrap_or(1);
        validate_worker_response(value, id).map(|_| ())
    }
    #[test]
    fn all_worker_vectors_match() {
        for (line_number, line) in include_str!("../../../conformance/vectors.jsonl")
            .lines()
            .enumerate()
        {
            let context: Json = serde_json::from_str(line).unwrap();
            let result = match context["kind"].as_str().unwrap() {
                "frame" => frame(&context),
                "manifest" => crate::PublicManifest::from_json(&context["value"]).map(|_| ()),
                "value" => crate::PortableType::parse(&context["type"])
                    .and_then(|ty| ty.decode(&context["value"]).map(|_| ())),
                "request" => request(&context["value"]),
                "response" => response(context["value"].clone()),
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
