"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.XGC2_LICHTBLICK_WEB_STATIC_ROOT = "/tmp/unused";
process.env.XGC2_LICHTBLICK_WEB_ENV_FILE = "/tmp/unused.env";

const {
  buildAutoConnectScript,
  parseArgs,
  parseWsUrl,
  safeJoin,
  transformIndexHtml,
} = require("../launcher/xgc2-lichtblick-web.js");

test("parses the browser server command line", () => {
  assert.deepEqual(
    parseArgs([
      "--host", "0.0.0.0",
      "--port", "9090",
      "--control-plane-url", "wss://robot.example/bridge",
      "--public-url-prefix", "/lichtblick",
    ]),
    {
      host: "0.0.0.0",
      port: 9090,
      controlPlaneUrl: "wss://robot.example/bridge",
      publicUrlPrefix: "/lichtblick",
      showHelp: false,
    },
  );
});

test("validates websocket upstream URLs", () => {
  assert.deepEqual(parseWsUrl("wss://robot.example/bridge?token=1"), {
    protocol: "wss:",
    hostname: "robot.example",
    port: 443,
    path: "/bridge?token=1",
  });
  assert.throws(() => parseWsUrl("http://robot.example"), /must use ws:\/\/ or wss:\/\//);
});

test("keeps static paths inside the web root", () => {
  assert.equal(safeJoin("/srv/web", "/assets/app.js"), "/srv/web/assets/app.js");
  assert.equal(safeJoin("/srv/web", "/../etc/passwd"), null);
  assert.equal(safeJoin("/srv/web", "/%2e%2e/etc/passwd"), null);
});

test("injects the single-3D layout and same-origin auto-connect", () => {
  const source = `<!doctype html><html><head></head><script>
globalThis.LICHTBLICK_SUITE_DEFAULT_LAYOUT = [/*LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER*/][0];
</script><body></body></html>`;
  const layout = { configById: { "3D!xgc2": {} }, layout: "3D!xgc2" };
  const transformed = transformIndexHtml(source, layout, "/lichtblick");

  assert.match(transformed, /"layout":"3D!xgc2"/);
  assert.doesNotMatch(transformed, /LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER/);
  assert.match(transformed, /foxglove-websocket/);
  assert.match(transformed, /\/lichtblick\/ws/);
});

test("does not replace an explicit data source", () => {
  const script = buildAutoConnectScript("/");
  assert.match(script, /searchParams\.has\("ds"\)/);
  assert.match(script, /history\.replaceState/);
});
