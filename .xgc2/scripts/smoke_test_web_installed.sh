#!/usr/bin/env bash
set -euo pipefail

package_name="xgc2-lichtblick-web"
launcher="/usr/bin/xgc2-lichtblick-web"
node="/usr/lib/xgc2/lichtblick-web/node/bin/node"

[[ "$(dpkg-query -W -f='${db:Status-Abbrev}' "${package_name}")" == ii* ]]
[[ -x "${launcher}" ]]
[[ -x "${node}" ]]
[[ -f /usr/lib/xgc2/lichtblick-web/web/index.html ]]
[[ -f /usr/lib/xgc2/lichtblick-web/default-layout.json ]]
[[ -f /usr/lib/xgc2/lichtblick-web/build-info.json ]]
[[ -f /etc/xgc2/lichtblick-web.env ]]
[[ -f /usr/share/xgc2/process-definitions/xgc2-lichtblick-web.json ]]
python3 -m json.tool /usr/share/xgc2/process-definitions/xgc2-lichtblick-web.json >/dev/null

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
curl --fail --silent --show-error "http://127.0.0.1:${port}/version" \
  > "${smoke_dir}/version.json"
grep -Fq '"schema":"xgc2.lichtblick-web.build.v1"' "${smoke_dir}/version.json"
grep -Fq '"package":"xgc2-lichtblick-web"' "${smoke_dir}/version.json"
grep -Fq '"version":' "${smoke_dir}/version.json"
curl --fail --silent --show-error "http://127.0.0.1:${port}/xgc2-layout.json" \
  > "${smoke_dir}/layout.json"
"${node}" - "${smoke_dir}/layout.json" <<'NODE'
const fs = require("node:fs");

const layout = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const meshUpAxis = layout.configById?.["3D!xgc2"]?.scene?.meshUpAxis;
if (meshUpAxis !== "z_up") {
  throw new Error(`expected XGC2 mesh up axis z_up, got ${String(meshUpAxis)}`);
}
NODE
curl --fail --silent --show-error "http://127.0.0.1:${port}/" \
  > "${smoke_dir}/index.html"
grep -Fq '"layout":"3D!xgc2"' "${smoke_dir}/index.html"
grep -Fq 'foxglove-websocket' "${smoke_dir}/index.html"
grep -Fq '/ws' "${smoke_dir}/index.html"
curl --fail --silent --show-error --dump-header "${smoke_dir}/headers" \
  --output /dev/null "http://127.0.0.1:${port}/"
grep -Fiq "content-security-policy: frame-ancestors 'self'" "${smoke_dir}/headers"
if grep -Fiq 'x-frame-options:' "${smoke_dir}/headers"; then
  echo "X-Frame-Options must not block the supported iframe integration." >&2
  exit 1
fi

echo "xgc2-lichtblick-web installed HTTP smoke test passed on port ${port}."
