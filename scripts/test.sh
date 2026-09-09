#!/usr/bin/env bash
set -euo pipefail
GATE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$GATE_ROOT"
bash scripts/build.sh
export PYTHONPATH="$GATE_ROOT/supervisor"
export MIRRORGATE_REQUIRE_SANDBOX=1
python3 -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/node/*.test.mjs
node --test tests/integration/*.test.mjs
MIRRORGATE_CPP_REAL_CONTROL=1 MIRRORGATE_CPP_HOSTING_CONTROL=1 bash scripts/test-control-cpp.sh
cargo test --manifest-path runtimes/rust/Cargo.toml --locked --offline
cargo fmt --manifest-path runtimes/rust/Cargo.toml -- --check
node conformance/run.mjs
node conformance/lifecycle.mjs
