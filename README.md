# xgc2-lichtblick-packaging

Product packaging for the XGC2-supported Lichtblick desktop application. This
repository fetches an immutable Lichtblick source revision, builds native Debian
packages, tests the installed application, and publishes signed APT releases for
Ubuntu 20.04, 22.04, and 24.04 on amd64 and arm64.

## Repository boundary

This repository owns:

- `lichtblick.lock`, including the upstream repository, tag, commit SHA, and
  exact Node, Yarn, and native FPM toolchain inputs;
- the repeatable Debian build, deterministic repackaging, and installed-package
  smoke tests;
- XGC2 package metadata and CI/release workflows;
- promotion of validated packages to the XGC2 APT repository.

It intentionally does not commit a copy of the Lichtblick source tree, develop
XGC2-specific Lichtblick features, hold the APT signing key, or operate the APT
server. Application development and upstream synchronization belong in
[`lxk36/xgc2-lichtblick`](https://github.com/lxk36/xgc2-lichtblick). Repository
signing and index publication remain server-side operations.

The initial product release pins the XGC2 source fork's `v1.25.0` by both tag
and commit SHA. A tag is never accepted on its own: every build verifies that
the fetched checkout still matches the SHA recorded in `lichtblick.lock` and
that the same tag has the same SHA in the canonical Lichtblick repository.

## Package matrix

| Ubuntu | Codename | amd64 | arm64 |
| --- | --- | ---: | ---: |
| 20.04 | focal | yes | yes |
| 22.04 | jammy | yes | yes |
| 24.04 | noble | yes | yes |

The Debian package is named `xgc2-lichtblick`. Its Debian revision comes from
`.xgc2/product.yml`, which lets the parent release orchestrator bump packaging
revisions without changing the immutable source lock. It conflicts with and
replaces the upstream `lichtblick` package so both applications cannot overwrite
the same desktop files and executable. The installed package also carries the
source lock, packaging README, upstream license, and original changelog under
`/usr/share/doc/xgc2-lichtblick/`.

The upstream Electron self-updater is disabled during Debian repackaging. XGC2
workstations must receive Lichtblick upgrades through `apt`; the application
cannot download and replace itself with an upstream `lichtblick` package.

## Local build

A native amd64 or arm64 Docker host is required. The wrapper selects pinned
Node, Yarn, and architecture-matched portable FPM toolchains inside the target
Ubuntu image. FPM archives and checksums are locked in `lichtblick.lock`, so
electron-builder never falls back to its legacy x86-only FPM download on arm64.
The wrapper builds Lichtblick, installs the resulting package on the same native
architecture, runs the smoke test, and checks package removal before it copies a
deb to the output directory.

Lichtblick v1.25.0 uses electron-builder 26. Its app-builder supports the
`USE_SYSTEM_FPM=true` compatibility switch used here to select the pinned
native bundle. This coupling is intentional: if an upstream upgrade moves to
electron-builder 27, migrate the pin to electron-builder's `toolsets.fpm`
mechanism and revalidate both architectures before changing or removing the
compatibility switch.

```bash
./.xgc2/scripts/check_package_compliance.sh

./.xgc2/scripts/build_deb_in_docker.sh \
  --ubuntu-version 24.04 \
  --architecture "$(dpkg --print-architecture)" \
  --work-dir "$PWD/.work/noble-$(dpkg --print-architecture)" \
  --output-dir "$PWD/.ci/debs"
```

Build artifacts are written under `.ci/debs/`; fetched source and intermediate
build state stay under the selected work directory and are not committed.

## Install from XGC2 APT

After the XGC2 signed APT source has been configured on the machine:

```bash
sudo apt update
sudo apt install xgc2-lichtblick
```

The repository publishes distribution-specific versions such as
`1.25.0-2~focal`, `1.25.0-2~jammy`, and `1.25.0-2~noble`.

## CI and release

`ci.yml` runs compliance plus six native build/install/smoke jobs on pushes and
pull requests. Each build uploads the deb and an `xgc2.build-artifact.v1`
manifest for 14 days. CI never writes to APT.

`release.yml` is manual and is normally dispatched by the XGC2 release
orchestrator. It can reuse artifacts from an exact successful push CI run, or
fall back to rebuilding the same six targets. Before publication it validates
every deb and build manifest, combines amd64 and arm64 per distribution, creates
`xgc2.release-artifact.v1`, and invokes one APT writer per distribution.

Publication is restricted to `refs/heads/main` and the protected GitHub
Environment named `xgc2-apt-production`. Create that Environment, allow only the
`main` deployment branch, add a required reviewer, and configure these secrets
on the Environment (not as repository-wide secrets) before enabling
`publish_apt`:

| Secret | Purpose |
| --- | --- |
| `APT_REPO_HOST` | SSH host of the XGC2 APT publisher |
| `APT_REPO_PORT` | SSH port |
| `APT_REPO_USER` | Restricted publishing account |
| `APT_REPO_SSH_KEY` | Private SSH key for that account |
| `APT_REPO_KNOWN_HOSTS` | Pinned SSH host key entry |

The APT GPG private key is not a GitHub secret; it stays on the APT server.
Only the final SSH publish step receives the five Environment secrets.

`update-lichtblick.yml` checks the canonical repository for the highest stable
semantic version tag. It only proceeds after the source fork exposes the same
tag at the same commit; otherwise the scheduled run fails with an explicit fork
sync instruction. When a mirrored newer tag exists, it opens or refreshes a
pull request that updates `lichtblick.lock`, the product version, and all
distribution versions.
It never auto-merges: the full package matrix must pass before a maintainer
accepts the source upgrade. Because branches and pull requests created by the
repository `GITHUB_TOKEN` do not start ordinary push CI, the updater explicitly
dispatches `ci.yml` on the update branch. Repository Actions settings must allow
`GITHUB_TOKEN` to create pull requests; the workflow never approves or merges
them.
