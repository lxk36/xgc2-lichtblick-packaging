#!/usr/bin/env bash

set -euo pipefail

deb_dir="${DEB_DIR:-${PWD}/debs}"
distribution="${APT_REPO_DISTRIBUTION:-}"
apt_host="${APT_REPO_HOST:-}"
apt_port="${APT_REPO_PORT:-22}"
apt_user="${APT_REPO_USER:-aptdeploy}"
apt_ssh_key="${APT_REPO_SSH_KEY:-}"
apt_known_hosts="${APT_REPO_KNOWN_HOSTS:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deb-dir) deb_dir="$2"; shift 2 ;;
    --distribution) distribution="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "${distribution}" in
  focal|jammy|noble) ;;
  *) echo "APT distribution must be focal, jammy, or noble." >&2; exit 2 ;;
esac
case "${apt_port}" in
  ''|*[!0-9]*) echo "APT_REPO_PORT must be numeric." >&2; exit 2 ;;
esac

missing=()
[[ -n "${apt_host}" ]] || missing+=(APT_REPO_HOST)
[[ -n "${apt_ssh_key}" ]] || missing+=(APT_REPO_SSH_KEY)
[[ -n "${apt_known_hosts}" ]] || missing+=(APT_REPO_KNOWN_HOSTS)
if (( ${#missing[@]} > 0 )); then
  echo "Refusing to publish: missing required secret/config: ${missing[*]}" >&2
  exit 1
fi
if [[ ! -d "${deb_dir}" ]]; then
  echo "Deb upload directory does not exist: ${deb_dir}" >&2
  exit 1
fi
if find "${deb_dir}" -type l -print -quit | grep -q .; then
  echo "Upload directory must not contain symbolic links." >&2
  exit 1
fi

mapfile -t debs < <(find "${deb_dir}" -maxdepth 1 -type f -name '*.deb' -print | sort)
if (( ${#debs[@]} == 0 )); then
  echo "No Debs found in ${deb_dir}." >&2
  exit 1
fi

declare -A seen_arch=()
package_version=""
for deb in "${debs[@]}"; do
  package="$(dpkg-deb -f "${deb}" Package)"
  version="$(dpkg-deb -f "${deb}" Version)"
  architecture="$(dpkg-deb -f "${deb}" Architecture)"
  [[ "${package}" == xgc2-lichtblick ]] || { echo "Unexpected package ${package}: ${deb}" >&2; exit 1; }
  [[ "${version}" == *"~${distribution}" ]] || { echo "Version ${version} is not scoped to ${distribution}." >&2; exit 1; }
  [[ "${architecture}" == amd64 || "${architecture}" == arm64 ]] || { echo "Unexpected architecture ${architecture}." >&2; exit 1; }
  [[ -z "${package_version}" || "${version}" == "${package_version}" ]] || { echo "Mixed versions in one publish batch." >&2; exit 1; }
  [[ -z "${seen_arch[${architecture}]:-}" ]] || { echo "Duplicate ${architecture} package in publish batch." >&2; exit 1; }
  package_version="${version}"
  seen_arch["${architecture}"]=1
done
for required_arch in amd64 arm64; do
  [[ -n "${seen_arch[${required_arch}]:-}" ]] || {
    echo "Atomic publish requires both amd64 and arm64; missing ${required_arch}." >&2
    exit 1
  }
done

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

key_file="${tmp_dir}/id_apt_repo"
known_hosts_file="${tmp_dir}/known_hosts"
printf '%s\n' "${apt_ssh_key}" > "${key_file}"
printf '%s\n' "${apt_known_hosts}" > "${known_hosts_file}"
chmod 0600 "${key_file}" "${known_hosts_file}"

known_host_lookup="${apt_host}"
if [[ "${apt_port}" != 22 ]]; then
  known_host_lookup="[${apt_host}]:${apt_port}"
fi
if ! ssh-keygen -F "${known_host_lookup}" -f "${known_hosts_file}" >/dev/null; then
  echo "APT_REPO_KNOWN_HOSTS has no pinned key for ${known_host_lookup}." >&2
  exit 1
fi

ssh_args=(
  -i "${key_file}"
  -p "${apt_port}"
  -o "BatchMode=yes"
  -o "IdentitiesOnly=yes"
  -o "PasswordAuthentication=no"
  -o "KbdInteractiveAuthentication=no"
  -o "StrictHostKeyChecking=yes"
  -o "UserKnownHostsFile=${known_hosts_file}"
)

# Distribution is constrained to a fixed allowlist above.
# shellcheck disable=SC2029
tar -C "${deb_dir}" -cf - . |
  ssh "${ssh_args[@]}" "${apt_user}@${apt_host}" "publish ${distribution}"

echo "Published xgc2-lichtblick ${package_version} for ${distribution} (amd64, arm64)."
