#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

# shellcheck disable=SC1090
source "${repo_root}/lichtblick.lock"

package_name="xgc2-lichtblick"
package_distribution="${PACKAGE_DISTRIBUTION:-}"
target_arch="${TARGET_ARCH:-${PACKAGE_ARCHITECTURE:-$(dpkg --print-architecture)}}"
source_dir="${LICHTBLICK_SOURCE_DIR:-${repo_root}/.work/source-${package_distribution}-${target_arch}}"
work_dir="${LICHTBLICK_BUILD_WORK_DIR:-${repo_root}/.work/build-${package_distribution}-${target_arch}}"
output_dir="${OUTPUT_DIR:-${XGC2_LICHTBLICK_DEB_OUTPUT_DIR:-${repo_root}/debs}}"
maintainer="XGC2 Packaging <lxk36@users.noreply.github.com>"

case "${package_distribution}" in
  focal|jammy|noble) ;;
  *)
    echo "PACKAGE_DISTRIBUTION must be one of: focal, jammy, noble" >&2
    exit 2
    ;;
esac
case "${target_arch}" in
  amd64) electron_arch=x64 ;;
  arm64) electron_arch=arm64 ;;
  *)
    echo "TARGET_ARCH must be amd64 or arm64" >&2
    exit 2
    ;;
esac

native_arch="$(dpkg --print-architecture)"
if [[ "${native_arch}" != "${target_arch}" ]]; then
  echo "Build environment architecture ${native_arch} does not match TARGET_ARCH=${target_arch}." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v corepack >/dev/null 2>&1; then
  echo "Node.js and Corepack are required." >&2
  exit 1
fi
node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [[ ! "${node_major}" =~ ^[0-9]+$ ]] || (( node_major < LICHTBLICK_NODE_MAJOR )); then
  echo "Node.js >=${LICHTBLICK_NODE_MAJOR} is required; found $(node --version)." >&2
  exit 1
fi
if [[ "$(node --version)" != "v${LICHTBLICK_NODE_VERSION}" ]]; then
  echo "Node.js v${LICHTBLICK_NODE_VERSION} is pinned; found $(node --version)." >&2
  exit 1
fi
if [[ "${USE_SYSTEM_FPM:-}" != true ]]; then
  echo "USE_SYSTEM_FPM=true is required to prevent electron-builder from selecting an architecture-incompatible FPM bundle." >&2
  exit 1
fi
if ! command -v fpm >/dev/null 2>&1; then
  echo "The pinned FPM toolset is required on PATH." >&2
  exit 1
fi
actual_fpm_version="$(fpm --version)"
if [[ "${actual_fpm_version}" != "${LICHTBLICK_FPM_VERSION}" ]]; then
  echo "FPM ${LICHTBLICK_FPM_VERSION} is pinned; found ${actual_fpm_version}." >&2
  exit 1
fi

product_file="${repo_root}/.xgc2/product.yml"
if [[ ! -f "${product_file}" ]]; then
  echo "Missing product metadata: ${product_file}" >&2
  exit 1
fi
product_version="$(sed -n 's/^version:[[:space:]]*//p' "${product_file}" | head -n 1)"
case "${product_version}" in
  "${LICHTBLICK_VERSION}-"*) package_revision="${product_version#${LICHTBLICK_VERSION}-}" ;;
  *)
    echo "Product version ${product_version} must be ${LICHTBLICK_VERSION}-<revision>." >&2
    exit 1
    ;;
esac
if [[ ! "${package_revision}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid Debian package revision in product version: ${product_version}." >&2
  exit 1
fi
package_version="${product_version}~${package_distribution}"

export LICHTBLICK_SOURCE_DIR="${source_dir}"
"${script_dir}/fetch_lichtblick.sh"

actual_sha="$(git -C "${source_dir}" rev-parse HEAD)"
if [[ "${actual_sha}" != "${LICHTBLICK_SHA}" ]]; then
  echo "Source SHA mismatch: ${actual_sha} != ${LICHTBLICK_SHA}" >&2
  exit 1
fi

upstream_version="$(node -p "require('${source_dir}/package.json').version")"
upstream_package_manager="$(node -p "require('${source_dir}/package.json').packageManager")"
if [[ "${upstream_version}" != "${LICHTBLICK_VERSION}" ]]; then
  echo "Upstream package.json version ${upstream_version} does not match ${LICHTBLICK_VERSION}." >&2
  exit 1
fi
case "${upstream_package_manager}" in
  "yarn@${LICHTBLICK_YARN_VERSION}"|"yarn@${LICHTBLICK_YARN_VERSION}+"*) ;;
  *)
    echo "Upstream packageManager ${upstream_package_manager} does not match yarn@${LICHTBLICK_YARN_VERSION}." >&2
    exit 1
    ;;
esac
node - "${source_dir}/package.json" "${LICHTBLICK_NODE_VERSION}" <<'NODE'
const packageJson = require(process.argv[2]);
const pinned = process.argv[3].split(".").map(Number);
const engine = String(packageJson.engines?.node ?? "");
const match = /^\s*>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(engine);
if (match == null) {
  throw new Error(`unsupported engines.node constraint: ${JSON.stringify(engine)}`);
}
const minimum = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
for (let index = 0; index < 3; index++) {
  if (pinned[index] > minimum[index]) process.exit(0);
  if (pinned[index] < minimum[index]) {
    throw new Error(`pinned Node ${pinned.join(".")} is below engines.node ${engine}`);
  }
}
NODE

corepack enable yarn
actual_yarn_version="$(cd "${source_dir}" && corepack yarn --version)"
if [[ "${actual_yarn_version}" != "${LICHTBLICK_YARN_VERSION}" ]]; then
  echo "Yarn version ${actual_yarn_version} does not match ${LICHTBLICK_YARN_VERSION}." >&2
  exit 1
fi

export CI=true
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "${source_dir}" show -s --format=%ct HEAD)}"
export YARN_ENABLE_IMMUTABLE_INSTALLS=true

resolved_work_dir="$(realpath -m -- "${work_dir}")"
resolved_source_parent="$(dirname "$(realpath -m -- "${source_dir}")")"
case "${resolved_work_dir}" in
  /|"${HOME:-/__xgc2_no_home__}"|"${repo_root}"|"$(realpath -m -- "${source_dir}")"|"$(realpath -m -- "${output_dir}")")
    echo "Refusing unsafe build work directory: ${resolved_work_dir}" >&2
    exit 1
    ;;
esac
case "${resolved_work_dir}" in
  "${repo_root}/.work/"*|"${resolved_source_parent}/"*) ;;
  *)
    echo "Build work directory must be inside ${repo_root}/.work or ${resolved_source_parent}." >&2
    exit 1
    ;;
esac

rm -rf -- "${source_dir}/dist" "${source_dir}/desktop/.webpack" "${resolved_work_dir}"
work_dir="${resolved_work_dir}"
mkdir -p "${work_dir}" "${output_dir}"

(
  cd "${source_dir}"
  corepack yarn install --immutable
  corepack yarn desktop:build:prod
  corepack yarn package --linux deb "--${electron_arch}"
)

mapfile -t upstream_debs < <(
  find "${source_dir}/dist" -maxdepth 1 -type f -name '*.deb' -print | sort
)
matching_debs=()
for deb in "${upstream_debs[@]}"; do
  if [[ "$(dpkg-deb -f "${deb}" Architecture)" == "${target_arch}" ]]; then
    matching_debs+=("${deb}")
  fi
done
if (( ${#matching_debs[@]} != 1 )); then
  echo "Expected exactly one upstream ${target_arch} Deb; found ${#matching_debs[@]}." >&2
  printf '%s\n' "${upstream_debs[@]}" >&2
  exit 1
fi

upstream_deb="${matching_debs[0]}"
if [[ "$(dpkg-deb -f "${upstream_deb}" Package)" != "lichtblick" ]]; then
  echo "Unexpected upstream package name in ${upstream_deb}." >&2
  exit 1
fi
if [[ "$(dpkg-deb -f "${upstream_deb}" Version)" != "${LICHTBLICK_VERSION}" ]]; then
  echo "Unexpected upstream package version in ${upstream_deb}." >&2
  exit 1
fi

pkg_root="${work_dir}/package-root"
dpkg-deb --raw-extract "${upstream_deb}" "${pkg_root}"

# XGC2 distributes this Deb exclusively through APT. Electron's DebUpdater
# otherwise bypasses the signed repository and installs GitHub release assets.
for updater_file in \
  "${pkg_root}/opt/Lichtblick/resources/package-type" \
  "${pkg_root}/opt/Lichtblick/resources/app-update.yml"; do
  if [[ ! -f "${updater_file}" ]]; then
    echo "Expected upstream updater marker is missing: ${updater_file}" >&2
    exit 1
  fi
  rm -f -- "${updater_file}"
done

for maintainer_script in postinst postrm; do
  if [[ ! -x "${pkg_root}/DEBIAN/${maintainer_script}" ]]; then
    echo "Upstream ${maintainer_script} is missing or not executable." >&2
    exit 1
  fi
done
cp -a "${pkg_root}/DEBIAN/postrm" "${work_dir}/postrm.upstream"
find "${pkg_root}/DEBIAN" -maxdepth 1 -type f \
  ! -name control ! -name md5sums ! -name postrm -print0 \
  | sort -z \
  | xargs -0 sha256sum > "${work_dir}/maintainer-scripts.before.sha256"

original_maintainer="$(dpkg-deb -f "${upstream_deb}" Maintainer)"
awk \
  -v package_name="${package_name}" \
  -v package_version="${package_version}" \
  -v maintainer="${maintainer}" \
  -v original_maintainer="${original_maintainer}" '
    BEGIN {
      provides_seen = conflicts_seen = replaces_seen = original_seen = 0
    }
    /^Package:/ { print "Package: " package_name; next }
    /^Version:/ { print "Version: " package_version; next }
    /^Maintainer:/ {
      print "Maintainer: " maintainer
      if (!original_seen) {
        print "Original-Maintainer: " original_maintainer
        original_seen = 1
      }
      next
    }
    /^Original-Maintainer:/ {
      if (!original_seen) {
        print "Original-Maintainer: " original_maintainer
        original_seen = 1
      }
      next
    }
    /^Provides:/ { print "Provides: lichtblick"; provides_seen = 1; next }
    /^Conflicts:/ { print "Conflicts: lichtblick"; conflicts_seen = 1; next }
    /^Replaces:/ { print "Replaces: lichtblick"; replaces_seen = 1; next }
    /^Depends:/ {
      depends_value = $0
      sub(/^Depends:[[:space:]]*/, "", depends_value)
      dependency_count = split(depends_value, dependencies, /,[[:space:]]*/)
      rewritten_depends = "Depends:"
      alsa_seen = 0
      for (dep_index = 1; dep_index <= dependency_count; dep_index++) {
        dependency = dependencies[dep_index]
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", dependency)
        if (dependency ~ /^libasound2([[:space:]]*\([^)]*\))?$/) {
          # Noble exposes libasound2 as a virtual package also provided by an
          # incompatible, unversioned OSS shim. The real ALSA packages provide
          # a version on every supported Ubuntu release, including the t64
          # package on Noble, so this relation excludes the shim.
          dependency = "libasound2"
          alsa_seen = 1
        }
        rewritten_depends = rewritten_depends (dep_index == 1 ? " " : ", ") dependency
      }
      if (!alsa_seen) {
        rewritten_depends = rewritten_depends (dependency_count ? ", " : " ") "libasound2"
      }
      print rewritten_depends
      next
    }
    /^Description:/ {
      if (!provides_seen) print "Provides: lichtblick"
      if (!conflicts_seen) print "Conflicts: lichtblick"
      if (!replaces_seen) print "Replaces: lichtblick"
      print
      next
    }
    { print }
  ' "${pkg_root}/DEBIAN/control" > "${pkg_root}/DEBIAN/control.new"
mv "${pkg_root}/DEBIAN/control.new" "${pkg_root}/DEBIAN/control"
chmod 0644 "${pkg_root}/DEBIAN/control"

printf '%s\n' \
  '' \
  '# XGC2 packaging: remove the launcher created manually by upstream postinst.' \
  'rm -f /usr/bin/lichtblick' >> "${pkg_root}/DEBIAN/postrm"
cp -a "${work_dir}/postrm.upstream" "${work_dir}/postrm.expected"
printf '%s\n' \
  '' \
  '# XGC2 packaging: remove the launcher created manually by upstream postinst.' \
  'rm -f /usr/bin/lichtblick' >> "${work_dir}/postrm.expected"
if ! cmp -s "${pkg_root}/DEBIAN/postrm" "${work_dir}/postrm.expected"; then
  echo "postrm differs from the audited upstream-plus-cleanup form." >&2
  exit 1
fi

doc_dir="${pkg_root}/usr/share/doc/${package_name}"
mkdir -p "${doc_dir}"
if [[ -d "${pkg_root}/usr/share/doc/lichtblick" ]]; then
  cp -a "${pkg_root}/usr/share/doc/lichtblick/." "${doc_dir}/"
  rm -rf "${pkg_root}/usr/share/doc/lichtblick"
fi
install -m 0644 "${repo_root}/README.md" "${doc_dir}/README.md"
install -m 0644 "${repo_root}/lichtblick.lock" "${doc_dir}/lichtblick.lock"
install -m 0644 "${source_dir}/LICENSE" "${doc_dir}/LICENSE.upstream"
install -m 0644 "${source_dir}/LICENSE" "${doc_dir}/copyright"

(
  cd "${pkg_root}"
  find . -path ./DEBIAN -prune -o -type f -print0 \
    | sort -z \
    | xargs -0 md5sum \
    | sed 's#  \./#  #' > DEBIAN/md5sums
)
chmod 0644 "${pkg_root}/DEBIAN/md5sums"

find "${pkg_root}/DEBIAN" -maxdepth 1 -type f \
  ! -name control ! -name md5sums ! -name postrm -print0 \
  | sort -z \
  | xargs -0 sha256sum > "${work_dir}/maintainer-scripts.after.sha256"
if ! cmp -s \
  "${work_dir}/maintainer-scripts.before.sha256" \
  "${work_dir}/maintainer-scripts.after.sha256"; then
  echo "A maintainer script changed while repackaging the upstream Deb." >&2
  exit 1
fi

if [[ ! -f "${pkg_root}/opt/Lichtblick/LICENSE.electron.txt" ]] ||
   [[ ! -f "${pkg_root}/opt/Lichtblick/LICENSES.chromium.html" ]]; then
  echo "Upstream Electron/Chromium license files are missing from the package." >&2
  exit 1
fi
for doc_file in README.md lichtblick.lock LICENSE.upstream copyright; do
  if [[ ! -f "${doc_dir}/${doc_file}" ]]; then
    echo "Required package documentation is missing: ${doc_file}" >&2
    exit 1
  fi
done

find "${pkg_root}" -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

output_deb="${output_dir}/${package_name}_${package_version}_${target_arch}.deb"
rm -f -- "${output_deb}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH}" \
  dpkg-deb --root-owner-group -Zxz -z9 --build "${pkg_root}" "${output_deb}" >/dev/null

[[ "$(dpkg-deb -f "${output_deb}" Package)" == "${package_name}" ]]
[[ "$(dpkg-deb -f "${output_deb}" Version)" == "${package_version}" ]]
[[ "$(dpkg-deb -f "${output_deb}" Architecture)" == "${target_arch}" ]]
[[ "$(dpkg-deb -f "${output_deb}" Maintainer)" == "${maintainer}" ]]
for relation in Provides Conflicts Replaces; do
  [[ "$(dpkg-deb -f "${output_deb}" "${relation}")" == "lichtblick" ]]
done
package_depends="$(dpkg-deb -f "${output_deb}" Depends)"
if [[ ",${package_depends// /}," != *",libasound2(>=1.0.16),"* ]]; then
  echo "Debian artifact must require a versioned, real ALSA libasound2 provider." >&2
  exit 1
fi
dpkg-deb --info "${output_deb}"
sha256sum "${output_deb}"
echo "Debian artifact written to ${output_deb}"
