#!/usr/bin/env bash
# Operator setup for the disposable GitHub-hosted Ubuntu runner only.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && -n "${RUNNER_TEMP:-}" ]] || {
  echo 'This host-admission helper is only for disposable GitHub Actions runners.' >&2
  exit 2
}

# Ubuntu's AppArmor namespace restrictions require explicit admission for the
# trusted launcher. Limit the profile to /usr/bin/bwrap; do not disable AppArmor
# or change system-wide namespace sysctls. Gate still disables nested userns,
# drops all worker capabilities and runs all actual isolation-denial tests.
# https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007
if [[ -r /sys/module/apparmor/parameters/enabled ]] &&
    [[ "$(cat /sys/module/apparmor/parameters/enabled)" == Y ]]; then
  gate_ci_profile="$RUNNER_TEMP/mirrorgate-ci-bwrap.apparmor"
  cat > "$gate_ci_profile" <<'PROFILE'
abi <abi/4.0>,
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE
  sudo apparmor_parser -r "$gate_ci_profile"
fi

/usr/bin/bwrap --unshare-user --unshare-pid --unshare-net \
  --disable-userns --assert-userns-disabled --cap-drop ALL \
  --ro-bind / / --proc /proc --dev /dev -- true
sha256sum /usr/bin/bwrap
