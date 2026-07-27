# Archived maintenance boundary

The former rule that packaging was the sole Lichtblick maintenance boundary is
retired. XGC2 now maintains the complete source in
`products/webui/xgc2-lichtblick`.

This archive has no release authority:

- do not run or restore APT publication workflows;
- do not bump `lichtblick.lock` as an XGC2 upgrade mechanism;
- do not add this repository back to `products/`;
- do not treat its `.deb`, FPM, or six-platform matrix as supported output.

Reusable runtime behavior was absorbed into the source product under `xgc2/`.
The remaining files exist only to explain or reproduce historical packages
when diagnosing an old installation.
