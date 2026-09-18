use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerError {
    pub code: String,
    pub stage: String,
    pub message: String,
    pub operation_id: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    Argument,
    Limit,
    Protocol,
    Transport,
    Disconnected,
    Deadline,
    Handle,
    Cancelled,
    Worker,
    Server(ServerError),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
}

impl Error {
    pub(crate) fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    pub(crate) fn argument(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Argument, message)
    }
    pub(crate) fn limit(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Limit, message)
    }
    pub(crate) fn protocol(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Protocol, message)
    }
    pub(crate) fn transport(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Transport, message)
    }
    pub(crate) fn disconnected(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Disconnected, message)
    }
    pub(crate) fn deadline(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Deadline, message)
    }
    pub(crate) fn handle(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Handle, message)
    }
    pub(crate) fn cancelled(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Cancelled, message)
    }
    pub(crate) fn worker(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Worker, message)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Self::transport(value.to_string())
    }
}
