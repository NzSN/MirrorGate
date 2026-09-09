#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="${MIRRORGATE_CPP_BUILD_DIR:-$repo_root/.build/control-cpp}"
json_include="${MIRRORGATE_NLOHMANN_JSON_INCLUDE_DIR:-}"

cmake_args=(-S "$repo_root/sdk/cpp" -B "$build_dir" -DBUILD_TESTING=ON)
if [[ -n "$json_include" ]]; then
  cmake_args+=("-DMIRRORGATE_NLOHMANN_JSON_INCLUDE_DIR=$json_include")
fi

cmake "${cmake_args[@]}"
cmake --build "$build_dir" --parallel
ctest --test-dir "$build_dir" --output-on-failure

if [[ "${MIRRORGATE_CPP_REAL_CONTROL:-0}" == "1" ]]; then
  scratch="$(mktemp -d)"
  daemon_pid=""
  cleanup() {
    if [[ -n "$daemon_pid" ]]; then
      kill "$daemon_pid" 2>/dev/null || true
      wait "$daemon_pid" 2>/dev/null || true
    fi
    rm -rf "$scratch"
  }
  trap cleanup EXIT

  mkdir -p "$scratch/submissions/correct" "$scratch/submissions/faulty"
  cp "$repo_root/runtimes/node/examples/counter.mjs" "$scratch/submissions/correct/adapter.mjs"
  cp "$repo_root/runtimes/node/examples/faulty-counter.mjs" "$scratch/submissions/faulty/adapter.mjs"
  cp "$repo_root/runtimes/node/examples/counter.mjs" "$scratch/submissions/faulty/counter.mjs"
  python3 "$repo_root/tests/control_policy_fixture.py" "$scratch/policy.json" "$scratch/submissions" --adapter-entry adapter.mjs >/dev/null
  e2e="$build_dir/mirrorgate_control_e2e"
  manifest="$repo_root/conformance/manifests/counter.json"
  "$e2e" stdio "$repo_root/bin/mirrorgate" "$scratch/policy.json" "$manifest" correct node-v1 2
  "$e2e" stdio "$repo_root/bin/mirrorgate" "$scratch/policy.json" "$manifest" faulty node-v1 1

  mkdir "$scratch/control" && chmod 0700 "$scratch/control"
  socket="$scratch/control/control.sock"
  "$repo_root/bin/mirrorgate" control --unix-socket "$socket" --policy-file "$scratch/policy.json" &
  daemon_pid=$!
  for _ in {1..100}; do [[ -S "$socket" ]] && break; sleep 0.01; done
  [[ -S "$socket" ]]
  "$e2e" unix "$socket" "$scratch/policy.json" "$manifest" correct node-v1 2

  rust_worker="$repo_root/runtimes/rust/target/debug/mirrorgate-counter-worker"
  if [[ ! -x "$rust_worker" ]]; then
    echo "C++ real control gate requires the pinned Rust worker build: $rust_worker" >&2
    exit 1
  fi
  mkdir -p "$scratch/rust-submissions/rust"
  cp "$rust_worker" "$scratch/rust-submissions/rust/worker"
  python3 "$repo_root/tests/control_policy_fixture.py" "$scratch/rust-policy.json" \
    "$scratch/rust-submissions" --runtime rust --artifact-entry worker >/dev/null
  "$e2e" stdio "$repo_root/bin/mirrorgate" "$scratch/rust-policy.json" "$manifest" rust rust-v1 2
  python3 "$repo_root/tests/control_policy_fixture.py" "$scratch/rust-faulty-policy.json" \
    "$scratch/rust-submissions" --runtime rust --artifact-entry worker --faulty >/dev/null
  "$e2e" stdio "$repo_root/bin/mirrorgate" "$scratch/rust-faulty-policy.json" "$manifest" rust rust-v1 1
  cleanup
  trap - EXIT
fi

# Native client and real controller/backend, with only the author runtime and
# admission replaced by the explicitly test-only deterministic fixture.
if [[ "${MIRRORGATE_CPP_HOSTING_CONTROL:-0}" == "1" ]]; then
  hosting_scratch="$(mktemp -d)"
  hosting_pid=""
  hosting_cleanup() {
    if [[ -n "$hosting_pid" ]]; then
      kill "$hosting_pid" 2>/dev/null || true
      wait "$hosting_pid" 2>/dev/null || true
    fi
    rm -rf "$hosting_scratch"
  }
  trap hosting_cleanup EXIT
  mkdir -p "$hosting_scratch/source" "$hosting_scratch/control"
  chmod 0700 "$hosting_scratch/control"
  hosting_fixture="$repo_root/tests/cpp/hosting_controller_fixture.py"
  hosting_e2e="$build_dir/mirrorgate_hosting_e2e"
  for hosting_mode in submit wait; do
    cp "$repo_root/runtimes/node/examples/counter.mjs" "$hosting_scratch/source/adapter.mjs"
    "$hosting_e2e" stdio "$hosting_fixture" "$hosting_scratch" \
      "$repo_root/conformance/manifests/counter.json" "$hosting_mode"
    cp "$repo_root/runtimes/node/examples/counter.mjs" "$hosting_scratch/source/adapter.mjs"
    hosting_socket="$hosting_scratch/control/control.sock"
    /usr/bin/python3 "$hosting_fixture" unix "$hosting_scratch" "$hosting_mode" "$hosting_socket" &
    hosting_pid=$!
    for _ in {1..100}; do [[ -S "$hosting_socket" ]] && break; sleep 0.02; done
    [[ -S "$hosting_socket" ]]
    "$hosting_e2e" unix "$hosting_socket" "$hosting_scratch" \
      "$repo_root/conformance/manifests/counter.json" "$hosting_mode"
    kill "$hosting_pid"
    wait "$hosting_pid" || true
    hosting_pid=""
    rm -f "$hosting_socket"
  done
fi
