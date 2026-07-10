#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

ubuntu_version="${UBUNTU_VERSION:-20.04}"
architecture="${TARGET_ARCH:-$(dpkg --print-architecture)}"
docker_image=""
docker_network="${DOCKER_NETWORK:-}"
work_dir="${WORK_DIR:-${repo_root}/.work/docker-${ubuntu_version}-${architecture}}"
output_dir="${OUTPUT_DIR:-${repo_root}/debs}"

usage() {
  cat <<'EOF'
usage: build_deb_in_docker.sh [options]

  --ubuntu-version <20.04|22.04|24.04>
  --architecture <amd64|arm64>
  --image <container-image>
  --network <docker-network>
  --work-dir <path>
  --output-dir <path>
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ubuntu-version) ubuntu_version="$2"; shift 2 ;;
    --architecture) architecture="$2"; shift 2 ;;
    --image) docker_image="$2"; shift 2 ;;
    --network) docker_network="$2"; shift 2 ;;
    --work-dir) work_dir="$2"; shift 2 ;;
    --output-dir) output_dir="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "${ubuntu_version}" in
  20.04) distribution=focal ;;
  22.04) distribution=jammy ;;
  24.04) distribution=noble ;;
  *) echo "Unsupported Ubuntu version: ${ubuntu_version}" >&2; exit 2 ;;
esac
case "${architecture}" in
  amd64) docker_platform=linux/amd64 ;;
  arm64) docker_platform=linux/arm64 ;;
  *) echo "Unsupported architecture: ${architecture}" >&2; exit 2 ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required." >&2
  exit 1
fi

docker_image="${docker_image:-ubuntu:${ubuntu_version}}"
mkdir -p "${work_dir}" "${output_dir}"
work_dir="$(cd "${work_dir}" && pwd -P)"
output_dir="$(cd "${output_dir}" && pwd -P)"

docker pull --platform "${docker_platform}" "${docker_image}"
docker_run_args=(--rm --platform "${docker_platform}")
if [[ -n "${docker_network}" ]]; then
  docker_run_args+=(--network "${docker_network}")
fi
if [[ "${docker_network}" == host ]]; then
  proxy_forwarded=false
  for proxy_variable in \
    HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY \
    http_proxy https_proxy all_proxy no_proxy; do
    if [[ -n "${!proxy_variable:-}" ]]; then
      docker_run_args+=(-e "${proxy_variable}")
      case "${proxy_variable}" in
        HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy)
          proxy_forwarded=true
          ;;
      esac
    fi
  done
  if [[ "${proxy_forwarded}" == true ]]; then
    docker_run_args+=(-e "ELECTRON_GET_USE_PROXY=1")
  fi
fi
# The final argument is a script intentionally passed as a single string to
# `bash -lc`; its continuations are interpreted inside the container.
# shellcheck disable=SC1004
docker run "${docker_run_args[@]}" \
  -e DEBIAN_FRONTEND=noninteractive \
  -e PACKAGE_DISTRIBUTION="${distribution}" \
  -e TARGET_ARCH="${architecture}" \
  -e LICHTBLICK_SOURCE_DIR=/workspace/work/source \
  -e LICHTBLICK_BUILD_WORK_DIR=/workspace/work/repack \
  -e OUTPUT_DIR=/workspace/out \
  -v "${repo_root}:/workspace/packaging:ro" \
  -v "${work_dir}:/workspace/work" \
  -v "${output_dir}:/workspace/out" \
  "${docker_image}" \
  bash -lc '
    set -euo pipefail

    apt-get -o Acquire::Retries=5 update
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      dbus-x11 \
      desktop-file-utils \
      dpkg-dev \
      fakeroot \
      file \
      git \
      libarchive-tools \
      python3 \
      shared-mime-info \
      xauth \
      xvfb \
      xz-utils

    # shellcheck disable=SC1091
    source /workspace/packaging/lichtblick.lock
    case "${TARGET_ARCH}" in
      amd64)
        node_arch=x64
        node_sha256="${LICHTBLICK_NODE_X64_SHA256}"
        ;;
      arm64)
        node_arch=arm64
        node_sha256="${LICHTBLICK_NODE_ARM64_SHA256}"
        ;;
    esac
    node_archive="node-v${LICHTBLICK_NODE_VERSION}-linux-${node_arch}.tar.xz"
    curl --fail --location --retry 5 --retry-connrefused --retry-delay 2 \
      --output "/tmp/${node_archive}" \
      "https://nodejs.org/dist/v${LICHTBLICK_NODE_VERSION}/${node_archive}"
    printf "%s  %s\n" "${node_sha256}" "/tmp/${node_archive}" | sha256sum --check --strict
    tar -xJf "/tmp/${node_archive}" -C /usr/local --strip-components=1
    rm -f "/tmp/${node_archive}"
    corepack enable yarn

    if [[ "$(dpkg --print-architecture)" != "${TARGET_ARCH}" ]]; then
      echo "Container architecture does not match ${TARGET_ARCH}." >&2
      exit 1
    fi

    /workspace/packaging/.xgc2/scripts/build_deb.sh

    product_version="$(sed -n "s/^version:[[:space:]]*//p" /workspace/packaging/.xgc2/product.yml | head -n 1)"
    built_deb="/workspace/out/xgc2-lichtblick_${product_version}~${PACKAGE_DISTRIBUTION}_${TARGET_ARCH}.deb"
    if [[ ! -f "${built_deb}" ]]; then
      echo "Expected exact package is missing: ${built_deb}" >&2
      exit 1
    fi
    apt-get install -y --no-install-recommends "${built_deb}"
    /workspace/packaging/.xgc2/scripts/smoke_test_installed.sh
    apt-get purge -y xgc2-lichtblick
    if dpkg-query -W -f="\${db:Status-Abbrev}" xgc2-lichtblick 2>/dev/null | grep -q "^ii"; then
      echo "xgc2-lichtblick is still installed after purge." >&2
      exit 1
    fi
    test ! -e /usr/bin/lichtblick
    test ! -L /usr/bin/lichtblick
    test ! -e /opt/Lichtblick
  '

echo "Validated Debian artifact(s):"
find "${output_dir}" -maxdepth 1 -type f -name '*.deb' -print | sort
