//! Native adapter SDK for the language-neutral MirrorGate port protocol.
//!
//! This is a protocol runtime, not a sandbox. Launch submissions through the
//! trusted MirrorGate supervisor to establish an isolation boundary.
pub mod manifest;
pub mod strict;
pub mod value;
pub mod worker;

pub use manifest::{Manifest, Operation};
pub use worker::{Adapter, CancellationToken, WorkerError, run_worker};
