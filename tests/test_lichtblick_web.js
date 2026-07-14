"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.XGC2_LICHTBLICK_WEB_STATIC_ROOT = "/tmp/unused";
process.env.XGC2_LICHTBLICK_WEB_ENV_FILE = "/tmp/unused.env";

const {
  buildAutoConnectScript,
  defaultListenerOrigins,
  endpointMatches,
  normalizeOrigin,
  parseArgs,
  parseConfiguredOrigins,
  parseWsUrl,
  safeJoin,
  securityHeaders,
  transformIndexHtml,
  validateFrameAncestors,
  websocketOriginAllowed,
} = require("../launcher/xgc2-lichtblick-web.js");

test("parses the browser server command line", () => {
  assert.deepEqual(
    parseArgs([
      "--host", "0.0.0.0",
      "--port", "9090",
      "--control-plane-url", "wss://robot.example/bridge",
      "--public-url-prefix", "/lichtblick",
      "--allowed-origin", "https://xgc.example",
      "--allowed-origin", "http://127.0.0.1:5173",
      "--frame-ancestors", "'self' https://xgc.example",
    ]),
    {
      host: "0.0.0.0",
      port: 9090,
      controlPlaneUrl: "wss://robot.example/bridge",
      publicUrlPrefix: "/lichtblick",
      allowedOrigins: ["https://xgc.example", "http://127.0.0.1:5173"],
      frameAncestors: "'self' https://xgc.example",
      showHelp: false,
    },
  );
});

test("normalizes exact HTTP origins and rejects ambiguous sources", () => {
  assert.equal(normalizeOrigin("https://xgc.example:443"), "https://xgc.example");
  assert.equal(normalizeOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.throws(() => normalizeOrigin("ws://xgc.example"), /must use http:\/\//);
  assert.throws(() => normalizeOrigin("https://xgc.example/path"), /must not include/);
  assert.throws(() => normalizeOrigin("https:\/\/*.example"), /wildcard/);
});

test("builds the WebSocket browser Origin allowlist", () => {
  const origins = new Set([
    ...defaultListenerOrigins(8080),
    ...parseConfiguredOrigins([
      "http://127.0.0.1:5173, http://localhost:5173",
      "https://xgc.example",
    ]),
  ]);
  assert.equal(websocketOriginAllowed("http://127.0.0.1:8080", origins), true);
  assert.equal(websocketOriginAllowed("http://localhost:5173", origins), true);
  assert.equal(websocketOriginAllowed("https://xgc.example", origins), true);
  assert.equal(websocketOriginAllowed("https://evil.example", origins), false);
  assert.equal(websocketOriginAllowed(undefined, origins), false);
});

test("validates an iframe-compatible frame-ancestors policy", () => {
  assert.equal(
    validateFrameAncestors("'self' https://xgc.example:443 http://127.0.0.1:5173"),
    "'self' https://xgc.example http://127.0.0.1:5173",
  );
  assert.equal(validateFrameAncestors("'none'"), "'none'");
  assert.throws(() => validateFrameAncestors("'none' https://xgc.example"), /cannot be combined/);
  assert.throws(() => validateFrameAncestors("'self'; default-src *"), /invalid separator/);
  assert.equal(
    securityHeaders("'self' https://xgc.example")["Content-Security-Policy"],
    "frame-ancestors 'self' https://xgc.example; base-uri 'self'; object-src 'none'",
  );
});

test("matches root and public-prefix runtime endpoints", () => {
  assert.equal(endpointMatches("/version", "/lichtblick", "version"), true);
  assert.equal(endpointMatches("/lichtblick/version?full=1", "/lichtblick", "version"), true);
  assert.equal(endpointMatches("/other/version", "/lichtblick", "version"), false);
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

test("enables the run-time XGC SceneUpdate topic in the packaged 3D layout", () => {
  const layout = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../launcher/default-layout.json"), "utf8"),
  );
  const panel = layout.configById["3D!xgc2"];
  assert.deepEqual(panel.topics["/xgc/scene"], {
    visible: true,
    showOutlines: false,
  });
  assert.equal(panel.followTf, "world");
  assert.equal(panel.followMode, "follow-pose");
  assert.equal(panel.cameraState.distance, 12);
  assert.deepEqual(panel.scene.transforms, { showLabel: false, axisScale: 0, lineWidth: 0 });
});

test("does not replace an explicit data source", () => {
  const script = buildAutoConnectScript("/");
  assert.match(script, /searchParams\.has\("ds"\)/);
  assert.match(script, /history\.replaceState/);
});

test("serves installed metadata, the XGC layout, and enforces WebSocket Origin", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "xgc2-lichtblick-test-"));
  const webRoot = path.join(temporary, "web");
  fs.mkdirSync(webRoot);
  fs.writeFileSync(
    path.join(webRoot, "index.html"),
    "<!doctype html><html><head></head><script>" +
      "globalThis.LICHTBLICK_SUITE_DEFAULT_LAYOUT = " +
      "[/*LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER*/][0];" +
      "</script><body></body></html>",
  );
  const layoutFile = path.join(temporary, "layout.json");
  const defaultLayout = {
    configById: { "3D!xgc2": { topics: { "/xgc/scene": { visible: true } } } },
    layout: "3D!xgc2",
  };
  fs.writeFileSync(layoutFile, JSON.stringify(defaultLayout));
  const buildInfoFile = path.join(temporary, "build-info.json");
  const buildInfo = {
    schema: "xgc2.lichtblick-web.build.v1",
    package: "xgc2-lichtblick-web",
    version: "1.25.0-7~test",
    upstreamSha: "1".repeat(40),
  };
  fs.writeFileSync(buildInfoFile, JSON.stringify(buildInfo));

  const upstream = net.createServer((socket) => {
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString("latin1");
      if (!request.includes("\r\n\r\n")) return;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Accept: integration-test\r\n\r\n",
      );
    });
  });
  await listen(upstream);
  const upstreamPort = upstream.address().port;

  const launcherPath = path.resolve(__dirname, "../launcher/xgc2-lichtblick-web.js");
  const child = childProcess.spawn(
    process.execPath,
    [
      launcherPath,
      "--host", "127.0.0.1",
      "--port", "0",
      "--control-plane-url", `ws://127.0.0.1:${upstreamPort}`,
      "--allowed-origin", "http://127.0.0.1:5173",
      "--frame-ancestors", "'self' http://127.0.0.1:5173",
    ],
    {
      env: {
        ...process.env,
        XGC2_LICHTBLICK_WEB_STATIC_ROOT: webRoot,
        XGC2_LICHTBLICK_WEB_DEFAULT_LAYOUT: layoutFile,
        XGC2_LICHTBLICK_WEB_BUILD_INFO: buildInfoFile,
        XGC2_LICHTBLICK_WEB_ENV_FILE: path.join(temporary, "missing.env"),
        ALLOWED_ORIGINS: "",
        FRAME_ANCESTORS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await waitForExit(child);
    await closeServer(upstream);
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  const port = await waitForListeningPort(child, () => stderr);
  const version = await getJson(port, "/version");
  assert.deepEqual(version.body, buildInfo);
  assert.equal(
    version.headers["content-security-policy"],
    "frame-ancestors 'self' http://127.0.0.1:5173; base-uri 'self'; object-src 'none'",
  );
  assert.equal(version.headers["x-frame-options"], undefined);

  const layout = await getJson(port, "/xgc2-layout.json");
  assert.deepEqual(layout.body, defaultLayout);
  assert.equal(layout.headers["cache-control"], "no-store");

  assert.match(await websocketUpgradeStatus(port, "https://evil.example"), /^HTTP\/1\.1 403/);
  assert.match(await websocketUpgradeStatus(port, `http://127.0.0.1:${port}`), /^HTTP\/1\.1 101/);
  assert.match(await websocketUpgradeStatus(port, "http://127.0.0.1:5173"), /^HTTP\/1\.1 101/);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function waitForListeningPort(child, stderr) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      reject(new Error(`launcher did not listen in time\n${stderr()}`));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = /serving Lichtblick web bundle on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`launcher exited with ${code}\n${stderr()}`));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function getJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: requestPath }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve({ body: JSON.parse(body), headers: response.headers });
        } catch (error) {
          reject(error);
        }
      });
    }).once("error", reject);
  });
}

function websocketUpgradeStatus(port, origin) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for WebSocket upgrade response"));
    }, 3000);
    socket.once("connect", () => {
      socket.write(
        "GET /ws HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          `Origin: ${origin}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      clearTimeout(timeout);
      socket.destroy();
      resolve(response.split("\r\n", 1)[0]);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}
