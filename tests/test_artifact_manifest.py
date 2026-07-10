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
DEVOPS_ROOT = ROOT.parents[2]
APT_VALIDATOR = DEVOPS_ROOT / "platforms/apt-repo/container/bin/xgc2-validate-release-upload"

PRODUCT = "xgc2-lichtblick"
PRODUCT_VERSION = "1.25.0-2"
DEB_VERSION = "1.25.0-2~noble"
DIST = "noble"
SOURCE_SHA = "1" * 40
UPSTREAM_REPOSITORY = "https://github.com/lxk36/xgc2-lichtblick.git"
UPSTREAM_REF = "v1.25.0"
UPSTREAM_SHA = "3fad978b6954a51d750b5b027c529a7c588e7ece"
LOCK_DIGEST = "2" * 64


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

    def release(self, *, expected_returncode: int = 0) -> subprocess.CompletedProcess[str]:
        return self.run_tool(
            "release",
            "--deb-dir",
            str(self.work / "verified/debs"),
            "--build-manifest-dir",
            str(self.work / "verified/build-manifests"),
            "--publish-dir",
            str(self.work / "publish"),
            *self.identity_arguments(),
            "--release-id",
            "release-12345",
            "--release-lock-digest",
            LOCK_DIGEST,
            "--target-architecture",
            "amd64",
            "--target-architecture",
            "arm64",
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
        self.build_deb(artifact, "amd64", version="1.25.0-3~noble")
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

    def test_release_requires_and_aggregates_both_architectures(self) -> None:
        for architecture in ("amd64", "arm64"):
            self.create_build(architecture)
            self.verify_build(architecture)
        self.release()

        publish = self.work / "publish"
        self.assertEqual(len(list(publish.glob("*.deb"))), 2)
        self.assertEqual(len(list((publish / "build-manifests").glob("*.json"))), 2)
        releases = sorted((publish / "manifests").rglob("*.json"))
        self.assertEqual(len(releases), 2)
        for release_path in releases:
            release = json.loads(release_path.read_text(encoding="utf-8"))
            architecture = release["architecture"]
            build = publish / release["build_manifest"]
            self.assertEqual(release["schema"], "xgc2.release-artifact.v1")
            self.assertEqual(release["release_id"], "release-12345")
            self.assertEqual(release["release_lock_digest"], LOCK_DIGEST)
            self.assertEqual(release["source_sha"], SOURCE_SHA)
            self.assertEqual(release["upstream_sha"], UPSTREAM_SHA)
            self.assertEqual(release["build_manifest_digest"], file_sha256(build))
            self.assertEqual(
                release_path.relative_to(publish).as_posix(),
                f"manifests/{PRODUCT}/{DIST}/{architecture}/{PRODUCT}_{DEB_VERSION}.json",
            )

        if APT_VALIDATOR.is_file():
            validation = subprocess.run(
                [
                    "python3",
                    str(APT_VALIDATOR),
                    "--input",
                    str(publish),
                    "--manifest-stage",
                    str(self.work / "manifest-stage"),
                    "--distribution",
                    DIST,
                    "--architectures",
                    "amd64",
                    "arm64",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertEqual(
                validation.returncode,
                0,
                f"stdout:\n{validation.stdout}\nstderr:\n{validation.stderr}",
            )

    def test_release_fails_when_one_architecture_is_missing(self) -> None:
        self.create_build("amd64")
        self.verify_build("amd64")
        result = self.release(expected_returncode=2)
        self.assertIn("missing matching build manifests for: arm64", result.stderr)


if __name__ == "__main__":
    unittest.main()
