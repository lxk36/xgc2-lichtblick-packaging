#!/usr/bin/env python3
"""Create, verify, and aggregate trusted XGC2 Lichtblick artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


BUILD_SCHEMA = "xgc2.build-artifact.v1"
SUPPORTED_ARCHITECTURES = ("amd64", "arm64")
DEB_FIELDS = ("file", "package", "version", "architecture", "sha256", "size")

HEX64 = re.compile(r"^[0-9a-f]{64}$")
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
PRODUCT = re.compile(r"^[a-z0-9][a-z0-9.+-]{0,127}$")
DISTRIBUTION = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
VERSION = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+:~_-]{0,255}$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_string(
    value: Any,
    name: str,
    pattern: re.Pattern[str] | None = None,
    *,
    empty: bool = False,
) -> str:
    if not isinstance(value, str) or (not empty and not value):
        qualifier = "possibly empty" if empty else "non-empty"
        raise ValueError(f"{name} must be a {qualifier} string")
    if value and pattern is not None and pattern.fullmatch(value) is None:
        raise ValueError(f"invalid {name}: {value!r}")
    return value


def require_architecture(value: str) -> str:
    if value not in SUPPORTED_ARCHITECTURES:
        supported = ", ".join(SUPPORTED_ARCHITECTURES)
        raise ValueError(f"unsupported architecture {value!r}; expected one of: {supported}")
    return value


def validate_requested_identity(args: argparse.Namespace, *, include_version: bool) -> None:
    require_string(args.product, "product", PRODUCT)
    require_string(args.distribution, "distribution", DISTRIBUTION)
    require_string(args.source_sha, "source_sha", SOURCE_SHA)
    require_string(args.upstream_repository, "upstream_repository")
    require_string(args.upstream_ref, "upstream_ref")
    require_string(args.upstream_sha, "upstream_sha", SOURCE_SHA)
    if include_version:
        require_string(args.product_version, "product_version", VERSION)


def deb_metadata(path: Path) -> dict[str, Any]:
    result = subprocess.run(
        [
            "dpkg-deb",
            "--show",
            "--showformat=${Package}\n${Version}\n${Architecture}\n",
            str(path),
        ],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    fields = result.stdout.splitlines()
    if len(fields) != 3 or not all(fields):
        raise ValueError(f"cannot read Package/Version/Architecture from {path}")
    package, version, architecture = fields
    return {
        "file": path.name,
        "package": package,
        "version": version,
        "architecture": architecture,
        "sha256": sha256(path),
        "size": path.stat().st_size,
    }


def reject_symlinks(root: Path) -> None:
    if root.is_symlink() or any(path.is_symlink() for path in root.rglob("*")):
        raise ValueError(f"symbolic links are not allowed below {root}")


def debs_from_dir(deb_dir: Path, architecture: str) -> list[dict[str, Any]]:
    root = deb_dir.resolve(strict=True)
    reject_symlinks(root)
    paths = sorted(path for path in root.rglob("*.deb") if path.is_file())
    if not paths:
        raise ValueError(f"no debs found below {deb_dir}")
    entries = [deb_metadata(path) for path in paths]
    filenames = [str(entry["file"]) for entry in entries]
    if len(filenames) != len(set(filenames)):
        raise ValueError("duplicate deb filenames")
    for entry in entries:
        if entry["architecture"] != architecture:
            raise ValueError(
                f"{entry['file']}: deb architecture {entry['architecture']!r} "
                f"does not match build architecture {architecture!r}"
            )
    return entries


def validate_product_debs(
    entries: list[dict[str, Any]], *, product: str, version: str, distribution: str
) -> None:
    """Enforce this repository's one-product/two-package Debian contract."""

    expected_packages = {product, f"{product}-web"}
    actual_packages = {str(entry.get("package")) for entry in entries}
    if len(entries) != len(expected_packages) or actual_packages != expected_packages:
        raise ValueError(
            f"expected deb packages {sorted(expected_packages)!r} for {product}, "
            f"found {sorted(actual_packages)!r}"
        )
    expected_version = f"{version}~{distribution}"
    for entry in entries:
        if entry.get("version") != expected_version:
            raise ValueError(
                f"deb version {entry.get('version')!r} does not match {expected_version!r}"
            )


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path}: manifest must be a JSON object")
    return value


def local_product_version() -> str:
    path = Path(".xgc2/product.yml")
    text = path.read_text(encoding="utf-8")
    match = re.search(r"^version:\s*([^\s#]+)", text, re.MULTILINE)
    if not match:
        raise ValueError(f"cannot read version from {path}")
    return require_string(match.group(1), "product version", VERSION)


def manifest_identity_matches(
    manifest: dict[str, Any],
    args: argparse.Namespace,
    *,
    version: str,
    architecture: str | None,
) -> bool:
    expected = {
        "product": args.product,
        "version": version,
        "distribution": args.distribution,
        "source_sha": args.source_sha,
        "upstream_repository": args.upstream_repository,
        "upstream_ref": args.upstream_ref,
        "upstream_sha": args.upstream_sha,
    }
    if architecture is not None:
        expected["architecture"] = architecture
    return all(manifest.get(key) == value for key, value in expected.items())


def validate_manifest_identity(
    manifest: dict[str, Any],
    path: Path,
    args: argparse.Namespace,
    *,
    schema: str,
    version: str,
    architecture: str,
) -> None:
    if manifest.get("schema") != schema:
        raise ValueError(f"{path}: expected schema {schema}")
    expected = {
        "product": args.product,
        "version": version,
        "distribution": args.distribution,
        "architecture": architecture,
        "source_sha": args.source_sha,
        "upstream_repository": args.upstream_repository,
        "upstream_ref": args.upstream_ref,
        "upstream_sha": args.upstream_sha,
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            raise ValueError(
                f"{path}: {key} mismatch: manifest={manifest.get(key)!r} expected={value!r}"
            )


def validate_ci(manifest: dict[str, Any], path: Path) -> None:
    ci = manifest.get("ci")
    if not isinstance(ci, dict):
        raise ValueError(f"{path}: ci must be an object")
    for key in ("run_id", "workflow", "workflow_ref"):
        value = ci.get(key)
        if not isinstance(value, (str, int)) or isinstance(value, bool) or str(value) == "":
            raise ValueError(f"{path}: ci.{key} must be non-empty")


def find_deb(root: Path, filename: str, *, near: Path | None = None) -> Path:
    if not filename or Path(filename).name != filename or filename in (".", ".."):
        raise ValueError(f"unsafe deb filename: {filename!r}")
    resolved_root = root.resolve(strict=True)
    if near is not None:
        scope = near.resolve().parent
        if scope == resolved_root or resolved_root in scope.parents:
            while True:
                matches = sorted(
                    path
                    for path in scope.rglob(filename)
                    if path.is_file() and not path.is_symlink()
                )
                if len(matches) == 1:
                    return matches[0]
                if len(matches) > 1:
                    raise ValueError(f"expected one {filename} below {scope}, found {len(matches)}")
                if scope == resolved_root:
                    break
                scope = scope.parent
    matches = sorted(
        path for path in resolved_root.rglob(filename) if path.is_file() and not path.is_symlink()
    )
    if len(matches) != 1:
        raise ValueError(f"expected one {filename} below {resolved_root}, found {len(matches)}")
    return matches[0]


def validate_debs(
    manifest: dict[str, Any],
    manifest_path: Path,
    deb_root: Path,
    architecture: str,
    *,
    near: bool,
) -> list[tuple[dict[str, Any], Path]]:
    entries = manifest.get("debs")
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"{manifest_path}: debs must be a non-empty list")
    resolved: list[tuple[dict[str, Any], Path]] = []
    seen: set[str] = set()
    for index, declared in enumerate(entries):
        if not isinstance(declared, dict):
            raise ValueError(f"{manifest_path}: debs[{index}] must be an object")
        if set(declared) != set(DEB_FIELDS):
            raise ValueError(
                f"{manifest_path}: debs[{index}] must contain exactly {list(DEB_FIELDS)}"
            )
        filename = declared.get("file")
        if not isinstance(filename, str) or filename in seen:
            raise ValueError(f"{manifest_path}: duplicate or invalid deb filename {filename!r}")
        seen.add(filename)
        deb = find_deb(deb_root, filename, near=manifest_path if near else None)
        actual = deb_metadata(deb)
        if actual != declared:
            mismatches = [key for key in DEB_FIELDS if declared.get(key) != actual.get(key)]
            raise ValueError(f"{deb}: deb metadata mismatch for {', '.join(mismatches)}")
        if actual["architecture"] != architecture:
            raise ValueError(
                f"{deb}: architecture {actual['architecture']!r} does not match {architecture!r}"
            )
        resolved.append((declared, deb))
    return resolved


def copy_unique(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if not destination.is_file() or sha256(source) != sha256(destination):
            raise ValueError(f"refusing to overwrite different artifact: {destination}")
        return
    shutil.copy2(source, destination)


def create_build(args: argparse.Namespace) -> None:
    validate_requested_identity(args, include_version=True)
    architecture = require_architecture(args.architecture)
    entries = debs_from_dir(Path(args.deb_dir), architecture)
    validate_product_debs(
        entries,
        product=args.product,
        version=args.product_version,
        distribution=args.distribution,
    )
    ci = {
        "run_id": str(require_string(str(args.ci_run_id), "ci_run_id")),
        "workflow": require_string(args.ci_workflow, "ci_workflow"),
        "workflow_ref": require_string(args.ci_workflow_ref, "ci_workflow_ref"),
    }
    payload = {
        "schema": BUILD_SCHEMA,
        "product": args.product,
        "version": args.product_version,
        "distribution": args.distribution,
        "architecture": architecture,
        "source_sha": args.source_sha,
        "upstream_repository": args.upstream_repository,
        "upstream_ref": args.upstream_ref,
        "upstream_sha": args.upstream_sha,
        "ci": ci,
        "created_at": utc_now(),
        "debs": entries,
    }
    output = Path(args.output_dir)
    name = f"{args.product}_{args.distribution}_{architecture}.build.json"
    write_json(output / name, payload)


def verify_build(args: argparse.Namespace) -> None:
    validate_requested_identity(args, include_version=False)
    architecture = require_architecture(args.architecture)
    version = args.product_version or local_product_version()
    require_string(version, "product_version", VERSION)
    root = Path(args.artifact_dir).resolve(strict=True)
    reject_symlinks(root)

    candidates: list[tuple[Path, dict[str, Any], list[tuple[dict[str, Any], Path]]]] = []
    for manifest_path in sorted(root.rglob("*.json")):
        try:
            manifest = read_json(manifest_path)
        except (json.JSONDecodeError, OSError, UnicodeDecodeError, ValueError):
            continue
        if manifest.get("schema") != BUILD_SCHEMA:
            continue
        if not manifest_identity_matches(
            manifest, args, version=version, architecture=architecture
        ):
            continue
        validate_manifest_identity(
            manifest,
            manifest_path,
            args,
            schema=BUILD_SCHEMA,
            version=version,
            architecture=architecture,
        )
        validate_ci(manifest, manifest_path)
        if args.ci_run_id and str(manifest["ci"]["run_id"]) != str(args.ci_run_id):
            continue
        debs = validate_debs(manifest, manifest_path, root, architecture, near=True)
        validate_product_debs(
            [declared for declared, _deb in debs],
            product=args.product,
            version=version,
            distribution=args.distribution,
        )
        candidates.append((manifest_path, manifest, debs))

    if not candidates:
        raise ValueError("trusted run has no matching, valid build manifest")
    if len(candidates) != 1:
        paths = ", ".join(str(item[0]) for item in candidates)
        raise ValueError(f"trusted run has multiple matching build manifests: {paths}")

    manifest_path, _manifest, debs = candidates[0]
    deb_output = Path(args.deb_output_dir)
    manifest_output = Path(args.manifest_output_dir)
    for _declared, deb in debs:
        copy_unique(deb, deb_output / deb.name)
    copy_unique(manifest_path, manifest_output / manifest_path.name)


def add_upstream_arguments(command: argparse.ArgumentParser) -> None:
    command.add_argument("--upstream-repository", required=True)
    command.add_argument("--upstream-ref", required=True)
    command.add_argument("--upstream-sha", required=True)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    sub = result.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help=f"create {BUILD_SCHEMA}")
    build.add_argument("--deb-dir", required=True)
    build.add_argument("--output-dir", required=True)
    build.add_argument("--product", required=True)
    build.add_argument("--product-version", required=True)
    build.add_argument("--distribution", required=True)
    build.add_argument("--architecture", required=True)
    build.add_argument("--source-sha", required=True)
    add_upstream_arguments(build)
    build.add_argument("--ci-run-id", required=True)
    build.add_argument("--ci-workflow", required=True)
    build.add_argument("--ci-workflow-ref", required=True)
    build.set_defaults(func=create_build)

    verify = sub.add_parser("verify-build", help="verify and stage a trusted build")
    verify.add_argument("--artifact-dir", required=True)
    verify.add_argument("--deb-output-dir", required=True)
    verify.add_argument("--manifest-output-dir", required=True)
    verify.add_argument("--product", required=True)
    verify.add_argument("--product-version")
    verify.add_argument("--distribution", required=True)
    verify.add_argument("--architecture", required=True)
    verify.add_argument("--source-sha", required=True)
    add_upstream_arguments(verify)
    verify.add_argument("--ci-run-id")
    verify.set_defaults(func=verify_build)

    return result


def main() -> int:
    command_parser = parser()
    args = command_parser.parse_args()
    try:
        args.func(args)
    except (OSError, ValueError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        command_parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
