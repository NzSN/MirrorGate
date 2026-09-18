#!/usr/bin/env bash
set -euo pipefail
GATE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$GATE_ROOT"
bash scripts/build.sh
export PYTHONPATH="$GATE_ROOT/supervisor"
export MIRRORGATE_REQUIRE_SANDBOX=1
python3 -m unittest discover -s tests -p 'test_*.py' -v
# Keep real controller/backend startup deterministic on cold hosts. Callers may
# raise this bound after establishing that their namespace backend has capacity.
NODE_TEST_CONCURRENCY="${MIRRORGATE_NODE_TEST_CONCURRENCY:-1}"
node --test --test-concurrency="$NODE_TEST_CONCURRENCY" tests/node/*.test.mjs
node --test --test-concurrency="$NODE_TEST_CONCURRENCY" tests/integration/*.test.mjs
MIRRORGATE_CPP_REAL_CONTROL=1 MIRRORGATE_CPP_HOSTING_CONTROL=1 bash scripts/test-control-cpp.sh
bash scripts/test-control-rust.sh
cargo test --manifest-path runtimes/rust/Cargo.toml --locked --offline
cargo fmt --manifest-path runtimes/rust/Cargo.toml -- --check
node conformance/run.mjs
node conformance/lifecycle.mjs
