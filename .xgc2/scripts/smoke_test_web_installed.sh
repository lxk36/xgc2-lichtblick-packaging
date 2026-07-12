#!/usr/bin/env bash
set -euo pipefail

package_name="xgc2-lichtblick-web"
launcher="/usr/bin/xgc2-lichtblick-web"

[[ "$(dpkg-query -W -f='${db:Status-Abbrev}' "${package_name}")" == ii* ]]
[[ -x "${launcher}" ]]
[[ -x /usr/lib/xgc2/lichtblick-web/node/bin/node ]]
[[ -f /usr/lib/xgc2/lichtblick-web/web/index.html ]]
[[ -f /usr/lib/xgc2/lichtblick-web/default-layout.json ]]
[[ -f /etc/xgc2/lichtblick-web.env ]]

smoke_dir="$(mktemp -d)"
server_pid=""
cleanup() {
  if [[ -n "${server_pid}" ]]; then
    kill "${server_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
  fi
  rm -rf "${smoke_dir}"
}
trap cleanup EXIT

"${launcher}" --host 127.0.0.1 --port 0 >"${smoke_dir}/server.log" 2>&1 &
server_pid=$!

port=""
for _ in $(seq 1 100); do
  port="$(sed -nE 's|.*http://127\.0\.0\.1:([0-9]+)/.*|\1|p' "${smoke_dir}/server.log" | tail -n1)"
  [[ -n "${port}" ]] && break
  kill -0 "${server_pid}" 2>/dev/null || {
    cat "${smoke_dir}/server.log" >&2
    exit 1
  }
  sleep 0.1
done
[[ -n "${port}" ]] || { cat "${smoke_dir}/server.log" >&2; exit 1; }

curl --fail --silent --show-error "http://127.0.0.1:${port}/healthz" \
  | grep -Fq '"status":"ok"'
curl --fail --silent --show-error "http://127.0.0.1:${port}/" \
  > "${smoke_dir}/index.html"
grep -Fq '"layout":"3D!xgc2"' "${smoke_dir}/index.html"
grep -Fq 'foxglove-websocket' "${smoke_dir}/index.html"
grep -Fq '/ws' "${smoke_dir}/index.html"

echo "xgc2-lichtblick-web installed HTTP smoke test passed on port ${port}."
