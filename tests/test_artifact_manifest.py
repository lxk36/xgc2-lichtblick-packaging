#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / ".xgc2/scripts/xgc2_artifact_manifest.py"


def read_assignment_file(path: Path) -> dict[str, str]:
    assignments: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        assignments[key.strip()] = value
    return assignments


def read_product_field(field: str) -> str:
    prefix = f"{field}:"
    for line in (ROOT / ".xgc2/product.yml").read_text(encoding="utf-8").splitlines():
        if line.startswith(prefix):
            return line[len(prefix) :].strip()
    raise RuntimeError(f"missing top-level product field: {field}")


LOCK = read_assignment_file(ROOT / "lichtblick.lock")
DIST = "noble"
PRODUCT = read_product_field("id")
PRODUCT_VERSION = read_product_field("version")
DEB_VERSION = f"{PRODUCT_VERSION}~{DIST}"
SOURCE_SHA = "1" * 40
UPSTREAM_REPOSITORY = LOCK["LICHTBLICK_REPOSITORY"]
UPSTREAM_REF = LOCK["LICHTBLICK_REF"]
UPSTREAM_SHA = LOCK["LICHTBLICK_SHA"]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class ArtifactManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.work = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_tool(
        self, *arguments: str, expected_returncode: int = 0
    ) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            ["python3", str(TOOL), *arguments],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertEqual(
            result.returncode,
            expected_returncode,
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        return result

    def identity_arguments(self, *, upstream_sha: str = UPSTREAM_SHA) -> list[str]:
        return [
            "--product",
            PRODUCT,
            "--product-version",
            PRODUCT_VERSION,
            "--distribution",
            DIST,
            "--source-sha",
            SOURCE_SHA,
            "--upstream-repository",
            UPSTREAM_REPOSITORY,
            "--upstream-ref",
            UPSTREAM_REF,
            "--upstream-sha",
            upstream_sha,
        ]

    def build_deb(
        self, directory: Path, architecture: str, *, version: str = DEB_VERSION
    ) -> Path:
        package_root = self.work / f"package-{architecture}"
        (package_root / "DEBIAN").mkdir(parents=True)
        (package_root / "usr/share/xgc2-lichtblick").mkdir(parents=True)
        (package_root / "DEBIAN/control").write_text(
            "\n".join(
                [
                    f"Package: {PRODUCT}",
                    f"Version: {version}",
                    "Section: science",
                    "Priority: optional",
                    f"Architecture: {architecture}",
                    "Maintainer: XGC2 Tests <tests@example.com>",
                    "Description: Lichtblick trusted artifact test",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        (package_root / "usr/share/xgc2-lichtblick/architecture").write_text(
            architecture + "\n", encoding="utf-8"
        )
        directory.mkdir(parents=True, exist_ok=True)
        output = directory / f"{PRODUCT}_{version}_{architecture}.deb"
        subprocess.run(
            ["dpkg-deb", "--root-owner-group", "--build", package_root, output],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        return output

    def create_build(self, architecture: str) -> tuple[Path, Path]:
        artifact = self.work / "artifacts" / architecture
        deb = self.build_deb(artifact, architecture)
        self.run_tool(
            "build",
            "--deb-dir",
            str(artifact),
            "--output-dir",
            str(artifact),
            *self.identity_arguments(),
            "--architecture",
            architecture,
            "--ci-run-id",
            "12345",
            "--ci-workflow",
            "CI",
            "--ci-workflow-ref",
            "lxk36/xgc2-lichtblick-packaging/.github/workflows/ci.yml@refs/heads/main",
        )
        manifest = artifact / f"{PRODUCT}_{DIST}_{architecture}.build.json"
        return deb, manifest

    def verify_build(
        self,
        architecture: str,
        *,
        upstream_sha: str = UPSTREAM_SHA,
        expected_returncode: int = 0,
    ) -> subprocess.CompletedProcess[str]:
        return self.run_tool(
            "verify-build",
            "--artifact-dir",
            str(self.work / "artifacts"),
            "--deb-output-dir",
            str(self.work / "verified/debs"),
            "--manifest-output-dir",
            str(self.work / "verified/build-manifests"),
            *self.identity_arguments(upstream_sha=upstream_sha),
            "--architecture",
            architecture,
            "--ci-run-id",
            "12345",
            expected_returncode=expected_returncode,
        )

    def test_build_records_pinned_upstream_and_real_deb_metadata(self) -> None:
        for architecture in ("amd64", "arm64"):
            with self.subTest(architecture=architecture):
                deb, manifest_path = self.create_build(architecture)
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                self.assertEqual(manifest["schema"], "xgc2.build-artifact.v1")
                self.assertEqual(manifest["source_sha"], SOURCE_SHA)
                self.assertEqual(manifest["upstream_repository"], UPSTREAM_REPOSITORY)
                self.assertEqual(manifest["upstream_ref"], UPSTREAM_REF)
                self.assertEqual(manifest["upstream_sha"], UPSTREAM_SHA)
                self.assertEqual(manifest["architecture"], architecture)
                self.assertEqual(
                    manifest["debs"],
                    [
                        {
                            "file": deb.name,
                            "package": PRODUCT,
                            "version": DEB_VERSION,
                            "architecture": architecture,
                            "sha256": file_sha256(deb),
                            "size": deb.stat().st_size,
                        }
                    ],
                )

    def test_build_rejects_deb_for_a_different_architecture(self) -> None:
        artifact = self.work / "wrong-architecture"
        self.build_deb(artifact, "arm64")
        result = self.run_tool(
            "build",
            "--deb-dir",
            str(artifact),
            "--output-dir",
            str(artifact),
            *self.identity_arguments(),
            "--architecture",
            "amd64",
            "--ci-run-id",
            "12345",
            "--ci-workflow",
            "CI",
            "--ci-workflow-ref",
            "repo/.github/workflows/ci.yml@refs/heads/main",
            expected_returncode=2,
        )
        self.assertIn("does not match build architecture", result.stderr)

    def test_build_rejects_deb_version_outside_product_contract(self) -> None:
        artifact = self.work / "wrong-version"
        self.build_deb(
            artifact,
            "amd64",
            version=f"{PRODUCT_VERSION}.mismatch~{DIST}",
        )
        result = self.run_tool(
            "build",
            "--deb-dir",
            str(artifact),
            "--output-dir",
            str(artifact),
            *self.identity_arguments(),
            "--architecture",
            "amd64",
            "--ci-run-id",
            "12345",
            "--ci-workflow",
            "CI",
            "--ci-workflow-ref",
            "repo/.github/workflows/ci.yml@refs/heads/main",
            expected_returncode=2,
        )
        self.assertIn("deb version", result.stderr)

    def test_verify_rechecks_deb_and_stages_only_matching_identity(self) -> None:
        deb, manifest = self.create_build("amd64")
        self.verify_build("amd64")
        copied_deb = self.work / "verified/debs" / deb.name
        copied_manifest = self.work / "verified/build-manifests" / manifest.name
        self.assertEqual(file_sha256(copied_deb), file_sha256(deb))
        self.assertEqual(file_sha256(copied_manifest), file_sha256(manifest))

        result = self.verify_build("amd64", upstream_sha="4" * 40, expected_returncode=2)
        self.assertIn("no matching, valid build manifest", result.stderr)

    def test_verify_rejects_a_deb_modified_after_manifest_creation(self) -> None:
        deb, _manifest = self.create_build("amd64")
        with deb.open("ab") as stream:
            stream.write(b"tampered\n")
        result = self.verify_build("amd64", expected_returncode=2)
        self.assertIn("deb metadata mismatch", result.stderr)
        self.assertFalse((self.work / "verified/debs" / deb.name).exists())

if __name__ == "__main__":
    unittest.main()
