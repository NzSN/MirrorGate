#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
model="$repo_root/specs/recovery/Recovery.tla"
config="$repo_root/specs/recovery/Recovery.cfg"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/mirrorgate-recovery-model.XXXXXX")"
evidence_dir="${MIRRORGATE_RECOVERY_EVIDENCE_DIR:-}"
trap 'rm -rf "$work_dir"' EXIT

if [[ -n "$evidence_dir" ]]; then
  if [[ "$evidence_dir" != /* || -e "$evidence_dir" ]]; then
    echo "recovery model: evidence directory must be a new absolute path" >&2
    exit 2
  fi
  mkdir -m 0700 "$evidence_dir"
fi

retain_evidence() {
  local exit_status=$?
  if [[ -n "$evidence_dir" ]]; then
    find "$work_dir" -maxdepth 1 -type f -name '*.log' \
      -exec cp '{}' "$evidence_dir/" ';' 2>/dev/null || true
    cp "$repo_root"/specs/recovery/*.cfg "$evidence_dir/" 2>/dev/null || true
    {
      printf 'apalache=%s\n' "${apalache_version:-not-run}"
      printf 'tlc=%s\n' "${expected_tlc:-not-run}"
      printf 'exit_status=%s\n' "$exit_status"
    } >"$evidence_dir/tool-versions.txt"
    sha256sum "$model" "$repo_root"/specs/recovery/*.cfg \
      "$repo_root/scripts/check-recovery-model.sh" \
      >"$evidence_dir/sha256sums.txt" 2>/dev/null || true
  fi
  rm -rf "$work_dir"
  return "$exit_status"
}
trap retain_evidence EXIT

if [[ -n "${TLC_JAR:-}" ]]; then
  tlc=(java -cp "$TLC_JAR" tlc2.TLC)
elif command -v tlc >/dev/null 2>&1; then
  tlc=(tlc)
elif [[ -f "$HOME/.local/lib/tla2tools.jar" ]]; then
  tlc=(java -cp "$HOME/.local/lib/tla2tools.jar" tlc2.TLC)
else
  echo "recovery model: TLC is unavailable (set TLC_JAR or install tlc)" >&2
  exit 2
fi

if [[ -n "${APALACHE_MC:-}" ]]; then
  apalache="$APALACHE_MC"
elif command -v apalache-mc >/dev/null 2>&1; then
  apalache="$(command -v apalache-mc)"
elif [[ -x "$HOME/.apalache/bin/apalache-mc" ]]; then
  apalache="$HOME/.apalache/bin/apalache-mc"
else
  echo "recovery model: Apalache is unavailable (set APALACHE_MC)" >&2
  exit 2
fi

expected_apalache="${MIRRORGATE_RECOVERY_APALACHE_VERSION:-0.61.0}"
expected_tlc="${MIRRORGATE_RECOVERY_TLC_VERSION:-2.19}"
apalache_version="$($apalache version 2>&1 | tail -n 1)"
tlc_banner="$("${tlc[@]}" 2>&1 || true)"
if [[ "$apalache_version" != "$expected_apalache" ]]; then
  echo "recovery model: expected Apalache $expected_apalache, found $apalache_version" >&2
  exit 2
fi
if ! grep -Fq "TLC2 Version $expected_tlc " <<<"$tlc_banner"; then
  echo "recovery model: expected TLC $expected_tlc" >&2
  exit 2
fi

run_tlc() {
  local cfg="$1"
  local log="$2"
  local state_name="$3"
  local state_dir="$work_dir/$state_name.states"
  if [[ ! -r "$cfg" ]]; then
    echo "recovery model: generated TLC config is unreadable: $cfg" >&2
    return 1
  fi
  (trap - EXIT
   "${tlc[@]}" -workers 1 -metadir "$state_dir" \
     -config "$cfg" "$model") >"$log" 2>&1
}

expect_counterexample() {
  local switch="$1"
  local invariant="$2"
  local cfg="$repo_root/specs/recovery/Recovery${switch}.cfg"
  local log="$work_dir/${switch}.log"
  if run_tlc "$cfg" "$log" "$switch"; then
    echo "recovery model: ${switch} unexpectedly satisfied ${invariant}" >&2
    return 1
  fi
  if ! grep -Fq "Invariant ${invariant} is violated" "$log"; then
    echo "recovery model: ${switch} failed without the expected ${invariant} counterexample" >&2
    sed -n '1,160p' "$log" >&2
    return 1
  fi
  echo "recovery model: expected ${invariant} counterexample found (${switch})"
}

if ! (cd "$work_dir"
      "$apalache" typecheck --run-dir="$work_dir/apalache-typecheck" "$model") \
  >"$work_dir/apalache-typecheck.log" 2>&1; then
  sed -n '1,200p' "$work_dir/apalache-typecheck.log" >&2
  exit 1
fi
echo "recovery model: Apalache $apalache_version typecheck passed"
if ! (cd "$work_dir"
      "$apalache" check --config="$config" --inv=Safety --length=8 \
        --run-dir="$work_dir/apalache" "$model") \
  >"$work_dir/apalache-check.log" 2>&1; then
  tail -200 "$work_dir/apalache-check.log" >&2
  exit 1
fi
echo "recovery model: Apalache bounded safety passed through length 8"

run_tlc "$config" "$work_dir/corrected.log" corrected
grep -Fq "Model checking completed. No error has been found." "$work_dir/corrected.log"
echo "recovery model: corrected finite model has no TLC counterexample"
grep -E 'states generated|distinct states|The depth of the complete state graph' \
  "$work_dir/corrected.log" | tail -3

expect_counterexample WeakExclusive ExclusiveOwner
expect_counterexample WeakCrossSession NoCrossSessionReclamation
expect_counterexample WeakEvidence EvidenceMonotonic
