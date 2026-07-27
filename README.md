# xgc2-lichtblick-packaging (archived)

This repository is retained under `external/dev` only as historical reference
for the former Lichtblick Debian/FPM build. It is not an XGC2 product and must
not publish packages or update the XGC2 APT repository.

The active product is the full source fork at
`products/webui/xgc2-lichtblick`, based on official Lichtblick v1.27.0. The
source product now owns:

- upstream baseline and toolchain locking;
- Web production builds;
- the XGC2 HTTP/WebSocket launcher, security headers, health and version
  endpoints;
- integration tests and XGC2-specific visualization performance changes.

All GitHub build, scheduled-update, and release workflows were removed here.
The remaining Debian scripts, FPM locks, and artifact-manifest tests are
historical material only and are intentionally not copied into the source
product.
