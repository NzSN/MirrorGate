#!/usr/bin/env bash
set -euo pipefail
GATE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$GATE_ROOT"
[[ "$(node --version)" == "v24.15.0" ]] || { echo 'Node24.15.0 required' >&2; exit 1; }
[[ "$(rustc --version)" == rustc\ 1.96.0\ * ]] || { echo 'Rust1.96.0 required (RUSTUP_TOOLCHAIN may select a matching installed toolchain)' >&2; exit 1; }
cargo build --manifest-path runtimes/rust/Cargo.toml --locked --offline
