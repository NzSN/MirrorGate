//! Blocking native client for MirrorGate control-v1 and worker-v1.
//!
//! The crate interprets the frozen protocols. MirrorGate remains the sole owner
//! of session transitions, process supervision, cancellation deadlines, and
//! physical cleanup.

mod control;
mod error;
mod manifest;
mod protocol;
mod strict;
mod transport;
mod value;
mod worker;

pub use control::{
    Authorization, Capability, CleanupResult, CleanupStatus, ClientOptions, CommandResult,
    ControlClient, ControlCloseReceipt, ControlEvent, ControllerCommand, Hello, HelloLimits,
    InputRef, OpenSession, Operation, OperationOutcome, OutcomeStatus, OutcomeSummary, Prepared,
    ProcessCloseState, RequiredMatchAttestation, Session, SessionPhase, SessionStatus, Submission,
    TightenedLimits, WorkerReservation,
};
pub use error::{Error, ErrorKind, Result, ServerError};
pub use manifest::{OperationSpec, PublicManifest};
pub use value::{PortableType, Value};
pub use worker::{
    CancellationToken, ManagedWorker, WorkerCallOptions, WorkerFinishReport, WorkerOptions,
};
