#!/usr/bin/env bash
set -euo pipefail

gate_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$gate_root"

rust_toolchain="${MIRRORGATE_RUST_TOOLCHAIN:-1.96.0}"
export RUSTUP_TOOLCHAIN="$rust_toolchain"
[[ "$(rustc --version)" == rustc\ 1.96.0\ * ]] || {
  echo 'MirrorGate Rust SDK requires rustc 1.96.0' >&2
  exit 1
}

sdk_manifest="$gate_root/sdk/rust/Cargo.toml"
[[ -f "$sdk_manifest" ]] || {
  echo "missing Rust SDK manifest: $sdk_manifest" >&2
  exit 1
}

cargo test --manifest-path "$sdk_manifest" --locked --offline
cargo test --manifest-path "$sdk_manifest" --locked --offline --all-features
cargo fmt --manifest-path "$sdk_manifest" -- --check
cargo clippy --manifest-path "$sdk_manifest" --locked --offline --all-targets --all-features -- -D warnings
bash "$gate_root/scripts/test-rust-package-consumer.sh"

if [[ "${MIRRORGATE_RUST_REAL_CONTROL:-0}" == "1" ]]; then
  bash "$gate_root/conformance/control-v1/run-rust"
fi
