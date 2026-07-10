#!/usr/bin/env bash

set -euo pipefail

package_name="xgc2-lichtblick"
binary="/opt/Lichtblick/lichtblick"
launcher="/usr/bin/lichtblick"

status="$(dpkg-query -W -f='${db:Status-Abbrev}' "${package_name}")"
[[ "${status}" == ii* ]]
[[ -x "${binary}" ]]
[[ -L "${launcher}" ]]
[[ "$(readlink -f "${launcher}")" == "${binary}" ]]
[[ -u /opt/Lichtblick/chrome-sandbox ]]
[[ -f /usr/share/applications/lichtblick.desktop ]]
[[ -f /usr/share/mime/packages/lichtblick.xml ]]
[[ -f /opt/Lichtblick/LICENSE.electron.txt ]]
[[ -f /opt/Lichtblick/LICENSES.chromium.html ]]
[[ -f /usr/share/doc/xgc2-lichtblick/README.md ]]
[[ -f /usr/share/doc/xgc2-lichtblick/lichtblick.lock ]]
[[ -f /usr/share/doc/xgc2-lichtblick/LICENSE.upstream ]]
if dpkg-query -L "${package_name}" | grep -q '^/usr/share/doc/lichtblick/'; then
  echo "Legacy upstream documentation directory remains installed." >&2
  exit 1
fi

if [[ -n "${TARGET_ARCH:-}" ]]; then
  [[ "$(dpkg-query -W -f='${Architecture}' "${package_name}")" == "${TARGET_ARCH}" ]]
fi
if [[ -n "${PACKAGE_DISTRIBUTION:-}" ]]; then
  installed_version="$(dpkg-query -W -f='${Version}' "${package_name}")"
  [[ "${installed_version}" == *"~${PACKAGE_DISTRIBUTION}" ]]
fi

ldd_output="$(mktemp)"
smoke_home="$(mktemp -d)"
cleanup() {
  rm -f "${ldd_output}"
  rm -rf "${smoke_home}"
}
trap cleanup EXIT

ldd "${binary}" | tee "${ldd_output}"
if grep -Fq 'not found' "${ldd_output}"; then
  echo "Unresolved shared library dependency detected." >&2
  exit 1
fi

case "$(dpkg-query -W -f='${Architecture}' "${package_name}")" in
  amd64) file "${binary}" | grep -Eq 'x86-64|x86_64' ;;
  arm64) file "${binary}" | grep -Eq 'aarch64|ARM aarch64' ;;
esac

dpkg --verify "${package_name}"

launch_seconds="${LICHTBLICK_SMOKE_LAUNCH_SECONDS:-12}"
set +e
HOME="${smoke_home}" \
  timeout --signal=TERM --kill-after=5 "${launch_seconds}" \
  xvfb-run -a dbus-run-session -- \
  "${launcher}" \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    >"${smoke_home}/lichtblick.log" 2>&1
launch_status=$?
set -e

if [[ "${launch_status}" != 124 ]]; then
  echo "Lichtblick exited before the ${launch_seconds}s headless smoke window (status ${launch_status})." >&2
  sed -n '1,240p' "${smoke_home}/lichtblick.log" >&2
  exit 1
fi

echo "xgc2-lichtblick installed headless smoke test passed."
