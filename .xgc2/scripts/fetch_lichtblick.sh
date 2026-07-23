#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

# shellcheck disable=SC1090
source "${repo_root}/lichtblick.lock"

source_dir="${LICHTBLICK_SOURCE_DIR:-${repo_root}/.work/source}"
max_attempts="${LICHTBLICK_FETCH_ATTEMPTS:-4}"
managed_marker=".git/xgc2-packaging-source"

assert_safe_path() {
  local resolved
  resolved="$(realpath -m -- "$1")"
  case "${resolved}" in
    /|"${HOME:-/__xgc2_no_home__}"|"${repo_root}")
      echo "Refusing unsafe source path: ${resolved}" >&2
      return 1
      ;;
  esac
  if [[ "${resolved}" != /* || ${#resolved} -lt 8 ]]; then
    echo "Refusing unsafe source path: ${resolved}" >&2
    return 1
  fi
}

remove_managed_source() {
  [[ ! -e "${source_dir}" && ! -L "${source_dir}" ]] && return 0
  assert_safe_path "${source_dir}"
  if [[ -L "${source_dir}" || ! -f "${source_dir}/${managed_marker}" ]]; then
    echo "Refusing to remove unmanaged or symlinked source directory: ${source_dir}" >&2
    return 1
  fi
  rm -rf -- "${source_dir}"
}

case "${max_attempts}" in
  ''|*[!0-9]*)
    echo "LICHTBLICK_FETCH_ATTEMPTS must be a positive integer" >&2
    exit 2
    ;;
esac
if (( max_attempts < 1 )); then
  echo "LICHTBLICK_FETCH_ATTEMPTS must be a positive integer" >&2
  exit 2
fi

source_is_ready() {
  [[ -d "${source_dir}/.git" ]] || return 1
  [[ -f "${source_dir}/${managed_marker}" ]] || return 1
  [[ "$(git -C "${source_dir}" remote get-url origin)" == "${LICHTBLICK_REPOSITORY}" ]] || return 1
  [[ "$(git -C "${source_dir}" rev-parse HEAD)" == "${LICHTBLICK_SHA}" ]] || return 1
  git -C "${source_dir}" diff --quiet --ignore-submodules --
  git -C "${source_dir}" diff --cached --quiet --ignore-submodules --
  [[ -z "$(git -C "${source_dir}" ls-files --others --exclude-standard)" ]]
}

upstream_refs=""
attempt=1
while ! upstream_refs="$(git ls-remote \
  --tags \
  "${LICHTBLICK_REPOSITORY}" \
  "refs/tags/${LICHTBLICK_REF}" \
  "refs/tags/${LICHTBLICK_REF}^{}")"; do
  if (( attempt >= max_attempts )); then
    echo "Failed to resolve official Lichtblick tag after ${attempt} attempts." >&2
    exit 1
  fi
  echo "Retrying official Lichtblick tag lookup after attempt ${attempt}/${max_attempts}..." >&2
  sleep $((attempt * 5))
  attempt=$((attempt + 1))
done
upstream_tag_sha="$(awk -v peeled="refs/tags/${LICHTBLICK_REF}^{}" \
  '$2 == peeled { print $1 }' <<< "${upstream_refs}")"
if [[ -z "${upstream_tag_sha}" ]]; then
  upstream_tag_sha="$(awk -v direct="refs/tags/${LICHTBLICK_REF}" \
    '$2 == direct { print $1 }' <<< "${upstream_refs}")"
fi
if [[ ! "${upstream_tag_sha}" =~ ^[0-9a-f]{40}$ ]] ||
   [[ "${upstream_tag_sha}" != "${LICHTBLICK_SHA}" ]]; then
  echo "Official ${LICHTBLICK_REF} is ${upstream_tag_sha:-<missing>}; expected ${LICHTBLICK_SHA}." >&2
  exit 1
fi

# Preserve the large dependency cache when upgrading from the first packaging
# script revision, which placed its marker in the checkout worktree.
if [[ -d "${source_dir}/.git" && -f "${source_dir}/.xgc2-packaging-source" &&
      ! -f "${source_dir}/${managed_marker}" ]]; then
  untracked="$(git -C "${source_dir}" ls-files --others --exclude-standard)"
  if [[ "${untracked}" == .xgc2-packaging-source &&
        "$(git -C "${source_dir}" remote get-url origin)" == "${LICHTBLICK_REPOSITORY}" &&
        "$(git -C "${source_dir}" rev-parse HEAD)" == "${LICHTBLICK_SHA}" ]]; then
    rm -f -- "${source_dir}/.xgc2-packaging-source"
    : > "${source_dir}/${managed_marker}"
  fi
fi

if source_is_ready; then
  echo "Lichtblick source is already pinned at ${LICHTBLICK_SHA}."
  exit 0
fi

assert_safe_path "${source_dir}"
if { [[ -e "${source_dir}" ]] || [[ -L "${source_dir}" ]]; } &&
   [[ ! -f "${source_dir}/${managed_marker}" ]]; then
  echo "Refusing to replace unmanaged source directory: ${source_dir}" >&2
  exit 1
fi

parent_dir="$(dirname "${source_dir}")"
mkdir -p "${parent_dir}"
tmp_dir="${source_dir}.tmp.$$"

cleanup() {
  assert_safe_path "${tmp_dir}"
  rm -rf -- "${tmp_dir}"
}
trap cleanup EXIT

remove_managed_source
assert_safe_path "${tmp_dir}"
rm -rf -- "${tmp_dir}"

attempt=1
while true; do
  assert_safe_path "${tmp_dir}"
  rm -rf -- "${tmp_dir}"
  if git clone \
    --depth 1 \
    --branch "${LICHTBLICK_REF}" \
    --single-branch \
    "${LICHTBLICK_REPOSITORY}" \
    "${tmp_dir}"; then
    actual_sha="$(git -C "${tmp_dir}" rev-parse HEAD)"
    if [[ "${actual_sha}" != "${LICHTBLICK_SHA}" ]]; then
      echo "Lichtblick ref ${LICHTBLICK_REF} resolved to ${actual_sha}; expected ${LICHTBLICK_SHA}." >&2
      exit 1
    fi
    if [[ -f "${tmp_dir}/.gitmodules" ]]; then
      git -C "${tmp_dir}" submodule update --init --recursive --depth 1
    fi
    : > "${tmp_dir}/${managed_marker}"
    mv "${tmp_dir}" "${source_dir}"
    break
  fi

  if (( attempt >= max_attempts )); then
    echo "Failed to clone Lichtblick after ${attempt} attempts." >&2
    exit 1
  fi
  echo "Retrying Lichtblick clone after attempt ${attempt}/${max_attempts}..." >&2
  sleep $((attempt * 5))
  attempt=$((attempt + 1))
done

echo "Fetched ${LICHTBLICK_REPOSITORY}@${LICHTBLICK_REF} (${LICHTBLICK_SHA})."
echo "Verified the tag and SHA against the official Lichtblick repository."
