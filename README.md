# xgc2-lichtblick-packaging

Product packaging for the XGC2-supported Lichtblick browser server and optional
Electron desktop application. This repository fetches an immutable Lichtblick
source revision, builds both Debian packages, tests their installed entrypoints,
and publishes signed APT releases for Ubuntu 20.04, 22.04, and 24.04 on amd64
and arm64.

## Repository boundary

This repository owns:

- `lichtblick.lock`, including the upstream repository, tag, commit SHA, and
  exact Node, Yarn, and native FPM toolchain inputs;
- the repeatable Web and Electron Debian builds, deterministic repackaging, and
  installed-package smoke tests;
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

The default Debian package is `xgc2-lichtblick-web`. It contains the production
Web bundle, a pinned architecture-matched Node runtime, a command-line HTTP and
WebSocket proxy, and a single-3D-panel initial layout. It does not open a window
or register an automatic service. The optional `xgc2-lichtblick` package retains
the Electron desktop application. Its Debian revision comes from
`.xgc2/product.yml`, which lets the parent release orchestrator bump packaging
revisions without changing the immutable source lock.

The Electron package conflicts with and replaces the upstream `lichtblick`
package so both applications cannot overwrite the same desktop files and
executable. Its upstream self-updater remains disabled; upgrades are delivered
through APT.

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

After the XGC2 signed APT source has been configured, install the browser server:

```bash
sudo apt update
sudo apt install xgc2-lichtblick-web
xgc2-lichtblick-web
```

The Web package recommends the Foxglove bridge matching each supported Ubuntu
and ROS release:

| Ubuntu | ROS | Recommended bridge |
| --- | --- | --- |
| 20.04 (focal) | Noetic | `ros-noetic-foxglove-bridge` |
| 22.04 (jammy) | Humble | `ros-humble-foxglove-bridge` |
| 24.04 (noble) | Jazzy | `ros-jazzy-foxglove-bridge` |

With the matching official ROS APT source configured, a normal `apt install`
installs the bridge automatically. It remains a recommendation so the WebUI
can still be installed before a ROS repository is configured or on a machine
that only consumes a bridge running on another execution target.

The command prints its URL, listens on `127.0.0.1:8080` by default, opens with a
3D visualization layout, and automatically connects the browser through its
same-origin WebSocket endpoint to `ws://127.0.0.1:8765`:

```text
http://127.0.0.1:8080/
```

The launcher also serves the validated packaged layout at
`/xgc2-layout.json`. The embedded XGC panel passes that endpoint through
Lichtblick's supported `layoutUrl` deep link, so `/xgc/scene`, the `world`
frame, and the XGC camera settings are applied even when the browser already
has an older saved layout.

The launcher exposes lightweight runtime metadata for XGC Process Supervisor
discovery and diagnostics. The response is generated from immutable metadata
written into the Debian package at build time, rather than from a launcher
constant:

```bash
curl --fail http://127.0.0.1:8080/version
curl --fail http://127.0.0.1:8080/healthz
```

Override the listener or data source without changing files:

```bash
xgc2-lichtblick-web \
  --host 0.0.0.0 \
  --port 8080 \
  --control-plane-url ws://127.0.0.1:8765 \
  --allowed-origin https://xgc.example.com \
  --frame-ancestors "'self' https://xgc.example.com"
```

To embed it in another WebUI, place the server behind the same reverse proxy and
use an iframe. Examples are installed in the package documentation and kept in
`launcher/reverse-proxy-examples.md` in this repository.

WebSocket upgrades are protected by an exact browser Origin allowlist. The
launcher always permits its own `http://127.0.0.1:PORT` and
`http://localhost:PORT` origins. Additional XGC parent origins are configured
with repeated `--allowed-origin` flags or the comma-separated
`ALLOWED_ORIGINS` setting. Origins must be complete `http://` or `https://`
origins without paths, queries, credentials, or wildcards.

HTML responses set a CSP `frame-ancestors` directive without setting the legacy
`X-Frame-Options` header. The default permits same-origin production embedding
and the standard XGC Vite origins. Set `FRAME_ANCESTORS` (or
`--frame-ancestors`) to the exact deployed XGC origin when the parent is on a
different origin. Keep it aligned with `ALLOWED_ORIGINS`.
APT treats `/etc/xgc2/lichtblick-web.env` as a Debian conffile, so locally
configured origins and listener settings are preserved across package upgrades.

The Debian package intentionally installs no systemd unit and starts no daemon.
XGC deployments register `/usr/bin/xgc2-lichtblick-web` as a Process Supervisor
definition, so experiment orchestration owns start, stop, readiness, logs, and
recovery. Standalone users may still launch the command directly.

Install the retained Electron application only when a desktop window is wanted:

```bash
sudo apt install xgc2-lichtblick
lichtblick
```

The repository publishes distribution-specific versions in the form
`<product-version>~focal`, `<product-version>~jammy`, and
`<product-version>~noble`. The authoritative product version and expanded APT
versions are recorded in `.xgc2/product.yml`.

## CI and release

`ci.yml` runs compliance plus six native build/install/smoke jobs on pushes and
pull requests. Each build uploads both debs and an `xgc2.build-artifact.v1`
manifest for 14 days. CI never writes to APT.

`release.yml` is manual and is normally dispatched by the XGC2 release
orchestrator. It rebuilds the locked source for all six targets, optionally
using the release-scoped staging APT overlay, and uploads only trusted
`xgc2.build-artifact.v1` inputs. The central publisher in `xgc2-devops`
validates and promotes those artifacts; this repository has no production APT
credentials and cannot write the repository.

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
