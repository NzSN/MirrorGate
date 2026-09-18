#!/usr/bin/env bash
set -euo pipefail

gate_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$gate_root"

rust_toolchain="${MIRRORGATE_RUST_TOOLCHAIN:-1.96.0}"
export RUSTUP_TOOLCHAIN="$rust_toolchain"
manifest="$gate_root/sdk/rust/Cargo.toml"
[[ -f "$manifest" ]] || {
  echo "missing Rust SDK manifest: $manifest" >&2
  exit 1
}

scratch="$(mktemp -d)"
cleanup() {
  rm -rf "$scratch"
}
trap cleanup EXIT

cargo package --manifest-path "$manifest" --locked --offline --allow-dirty \
  --target-dir "$scratch/package-target"
archive="$scratch/package-target/package/mirrorgate-sdk-0.1.0.crate"
[[ -f "$archive" ]] || {
  echo "missing packaged Rust SDK archive: $archive" >&2
  exit 1
}
archive_sha256="$(sha256sum "$archive" | cut -d' ' -f1)"
printf 'mirrorgate-sdk-package-sha256=%s\n' "$archive_sha256"

mkdir -p "$scratch/unpacked" "$scratch/consumer/src"
tar -xzf "$archive" -C "$scratch/unpacked"
packaged="$scratch/unpacked/mirrorgate-sdk-0.1.0"
[[ -f "$packaged/Cargo.toml" ]] || {
  echo 'packaged Rust SDK did not contain Cargo.toml' >&2
  exit 1
}

cat > "$scratch/consumer/Cargo.toml" <<EOF
[package]
name = "mirrorgate-sdk-package-consumer"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
mirrorgate-sdk = { path = "$packaged" }
EOF
cat > "$scratch/consumer/src/main.rs" <<'EOF'
use mirrorgate_sdk::{
    ClientOptions, InputRef, OpenSession, PublicManifest, RequiredMatchAttestation, Submission,
};

fn main() {
    let digest = "193d6cc187d05c18f02ad483a44f8ad0c1634b02083df241df08b9281b045d1c";
    let manifest_json = format!(
        "{{\"schema\":\"mirrorgate.port/v1\",\"interfaceDigest\":\"{digest}\",\"initializers\":[{{\"id\":\"Initialize\",\"inputs\":[]}}],\"actions\":[],\"observations\":[{{\"id\":\"Count\",\"type\":{{\"kind\":\"int\"}}}}]}}"
    );
    let manifest = PublicManifest::from_exact_json(&manifest_json).expect("valid public manifest");
    assert_eq!(manifest.interface_digest(), digest);
    assert!(manifest.is_initializer("Initialize"));
    assert!(PublicManifest::from_exact_json("{\"schema\":\"mirrorgate.port/v1\"}").is_err());

    let session = OpenSession {
        policy_id: "approved-policy".into(),
        submission: Submission::Prebuilt {
            input: InputRef {root_id: "submission".into(), relative_path: "counter".into()},
        },
        runtime: "rust-v1".into(),
        manifest_json,
        limits: None,
        model_revision_id: Some("private-revision-reference".into()),
    };
    assert_eq!(session.runtime, "rust-v1");
    let attestation = RequiredMatchAttestation::matched(
        "registration", digest, "mirrorgate/rust-v1",
        "mirrorrust-counter-fixture-v1", "mirrors.state-computer/v1",
    );
    assert_eq!(attestation.semantic_digest, digest);
    assert!(ClientOptions::default().required_capabilities.is_empty());
}
EOF

cargo run --manifest-path "$scratch/consumer/Cargo.toml" --offline
