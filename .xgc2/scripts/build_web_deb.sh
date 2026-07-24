#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

# shellcheck disable=SC1090
source "${repo_root}/lichtblick.lock"

package_name="xgc2-lichtblick-web"
package_distribution="${PACKAGE_DISTRIBUTION:-}"
target_arch="${TARGET_ARCH:-${PACKAGE_ARCHITECTURE:-$(dpkg --print-architecture)}}"
source_dir="${LICHTBLICK_SOURCE_DIR:-${repo_root}/.work/source-${package_distribution}-${target_arch}}"
work_dir="${LICHTBLICK_WEB_BUILD_WORK_DIR:-${repo_root}/.work/web-${package_distribution}-${target_arch}}"
output_dir="${OUTPUT_DIR:-${repo_root}/debs}"
maintainer="XGC2 Packaging <lxk36@users.noreply.github.com>"

case "${package_distribution}" in
  focal) bridge_package="ros-noetic-foxglove-bridge" ;;
  jammy) bridge_package="ros-humble-foxglove-bridge" ;;
  noble) bridge_package="ros-jazzy-foxglove-bridge" ;;
  *) echo "PACKAGE_DISTRIBUTION must be one of: focal, jammy, noble" >&2; exit 2 ;;
esac
case "${target_arch}" in
  amd64|arm64) ;;
  *) echo "TARGET_ARCH must be amd64 or arm64" >&2; exit 2 ;;
esac
[[ "$(dpkg --print-architecture)" == "${target_arch}" ]] || {
  echo "Build host architecture does not match TARGET_ARCH=${target_arch}." >&2
  exit 1
}

product_version="$(sed -n 's/^version:[[:space:]]*//p' "${repo_root}/.xgc2/product.yml" | head -n1)"
package_version="${product_version}~${package_distribution}"
source_date_epoch="${SOURCE_DATE_EPOCH:-$(git -C "${source_dir}" show -s --format=%ct HEAD)}"

[[ -d "${source_dir}" ]] || { echo "Lichtblick source is missing: ${source_dir}" >&2; exit 1; }
[[ "$(git -C "${source_dir}" rev-parse HEAD)" == "${LICHTBLICK_SHA}" ]]
[[ "$(node --version)" == "v${LICHTBLICK_NODE_VERSION}" ]]
[[ "$(cd "${source_dir}" && corepack yarn --version)" == "${LICHTBLICK_YARN_VERSION}" ]]

(
  cd "${source_dir}"
  corepack yarn web:build:prod
)

web_root="${source_dir}/web/.webpack"
[[ -f "${web_root}/index.html" ]] || { echo "Web build did not produce index.html." >&2; exit 1; }

rm -rf -- "${work_dir}"
pkg_root="${work_dir}/package-root"
install -d \
  "${pkg_root}/DEBIAN" \
  "${pkg_root}/etc/xgc2" \
  "${pkg_root}/usr/bin" \
  "${pkg_root}/usr/lib/xgc2/lichtblick-web/node/bin" \
  "${pkg_root}/usr/lib/xgc2/lichtblick-web/web" \
  "${pkg_root}/usr/share/doc/${package_name}" \

cp -a "${web_root}/." "${pkg_root}/usr/lib/xgc2/lichtblick-web/web/"
install -m 0755 "$(command -v node)" \
  "${pkg_root}/usr/lib/xgc2/lichtblick-web/node/bin/node"
install -m 0755 "${repo_root}/launcher/xgc2-lichtblick-web" \
  "${pkg_root}/usr/bin/xgc2-lichtblick-web"
install -m 0644 "${repo_root}/launcher/xgc2-lichtblick-web.js" \
  "${pkg_root}/usr/lib/xgc2/lichtblick-web/xgc2-lichtblick-web.js"
python3 - \
  "${pkg_root}/usr/lib/xgc2/lichtblick-web/build-info.json" \
  "${package_version}" \
  "${product_version}" \
  "${package_distribution}" \
  "${target_arch}" \
  "${LICHTBLICK_VERSION}" \
  "${LICHTBLICK_REF}" \
  "${LICHTBLICK_SHA}" <<'PY'
import json
import pathlib
import sys

(
    output,
    package_version,
    product_version,
    distribution,
    architecture,
    upstream_version,
    upstream_ref,
    upstream_sha,
) = sys.argv[1:]
payload = {
    "schema": "xgc2.lichtblick-web.build.v1",
    "package": "xgc2-lichtblick-web",
    "version": package_version,
    "productVersion": product_version,
    "distribution": distribution,
    "architecture": architecture,
    "upstreamVersion": upstream_version,
    "upstreamRef": upstream_ref,
    "upstreamSha": upstream_sha,
}
pathlib.Path(output).write_text(
    json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
install -m 0644 "${repo_root}/launcher/lichtblick-web.env" \
  "${pkg_root}/etc/xgc2/lichtblick-web.env"
install -m 0644 "${repo_root}/README.md" \
  "${pkg_root}/usr/share/doc/${package_name}/README.md"
install -m 0644 "${repo_root}/launcher/reverse-proxy-examples.md" \
  "${pkg_root}/usr/share/doc/${package_name}/reverse-proxy-examples.md"
install -m 0644 "${repo_root}/lichtblick.lock" \
  "${pkg_root}/usr/share/doc/${package_name}/lichtblick.lock"
install -m 0644 "${source_dir}/LICENSE" \
  "${pkg_root}/usr/share/doc/${package_name}/copyright"
if [[ -f /usr/local/LICENSE ]]; then
  install -m 0644 /usr/local/LICENSE \
    "${pkg_root}/usr/share/doc/${package_name}/LICENSE.node"
fi

printf '%s\n' '/etc/xgc2/lichtblick-web.env' > "${pkg_root}/DEBIAN/conffiles"

cat > "${pkg_root}/DEBIAN/control" <<EOF
Package: ${package_name}
Version: ${package_version}
Section: web
Priority: optional
Architecture: ${target_arch}
Maintainer: ${maintainer}
Depends: ca-certificates, libc6, libgcc-s1, libstdc++6
Recommends: ${bridge_package}
Description: XGC2 Lichtblick browser-based robotics visualization
 Serves the pinned Lichtblick web application from a command-line HTTP server,
 auto-connects through a same-origin WebSocket proxy, and leaves initial layout
 ownership to the embedding application.
EOF

find "${pkg_root}" -exec touch -h -d "@${source_date_epoch}" {} +
(
  cd "${pkg_root}"
  find . -path ./DEBIAN -prune -o -type f -print0 \
    | sort -z | xargs -0 md5sum | sed 's#  \./#  #' > DEBIAN/md5sums
)
chmod 0644 \
  "${pkg_root}/DEBIAN/conffiles" \
  "${pkg_root}/DEBIAN/control" \
  "${pkg_root}/DEBIAN/md5sums"

output_deb="${output_dir}/${package_name}_${package_version}_${target_arch}.deb"
mkdir -p "${output_dir}"
rm -f -- "${output_deb}"
SOURCE_DATE_EPOCH="${source_date_epoch}" \
  dpkg-deb --root-owner-group -Zxz -z9 --build "${pkg_root}" "${output_deb}" >/dev/null

dpkg-deb --info "${output_deb}"
sha256sum "${output_deb}"
echo "Web Debian artifact written to ${output_deb}"
