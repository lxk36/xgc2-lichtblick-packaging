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
  configureDefaultLayout,
  configureStandalonePanel,
  defaultListenerOrigins,
  endpointMatches,
  isPanelLayout,
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
      initialView: null,
      arVisible: null,
      gridVisible: null,
      gridColor: null,
      gridSize: null,
      gridDivisions: null,
      gridLineWidth: null,
      showHelp: false,
    },
  );
});

test("parses and validates initial grid options", () => {
  const parsed = parseArgs([
    "--initial-view", "ar",
    "--ar-visible", "false",
    "--grid-visible", "false",
    "--grid-color", "#A1B2C3",
    "--grid-size", "24.5",
    "--grid-divisions", "48",
    "--grid-line-width", "2.5",
  ]);
  assert.equal(parsed.initialView, "ar");
  assert.equal(parsed.arVisible, false);
  assert.equal(parsed.gridVisible, false);
  assert.equal(parsed.gridColor, "#a1b2c3");
  assert.equal(parsed.gridSize, 24.5);
  assert.equal(parsed.gridDivisions, 48);
  assert.equal(parsed.gridLineWidth, 2.5);
  assert.throws(() => parseArgs(["--grid-color", "blue"]), /invalid --grid-color/);
  assert.throws(() => parseArgs(["--ar-visible", "yes"]), /invalid --ar-visible/);
  assert.throws(() => parseArgs(["--initial-view", "camera"]), /invalid --initial-view/);
  assert.throws(() => parseArgs(["--grid-divisions", "1.5"]), /invalid --grid-divisions/);
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

test("injects a split panel layout and same-origin auto-connect", () => {
  const source = `<!doctype html><html><head></head><script>
globalThis.LICHTBLICK_SUITE_DEFAULT_LAYOUT = [/*LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER*/][0];
</script><body></body></html>`;
  const layout = {
    configById: { "3D!xgc2": {}, "Image!ar": {} },
    layout: { first: "3D!xgc2", second: "Image!ar", direction: "row", splitPercentage: 45 },
  };
  const transformed = transformIndexHtml(source, layout, "/lichtblick");

  assert.match(transformed, /"direction":"row","splitPercentage":45/);
  assert.doesNotMatch(transformed, /LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER/);
  assert.match(transformed, /foxglove-websocket/);
  assert.match(transformed, /\/lichtblick\/ws/);
});

test("packages a 3D scene beside camera-calibrated augmented reality", () => {
  const layout = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../launcher/default-layout.json"), "utf8"),
  );
  assert.deepEqual(layout.layout, {
    first: "3D!xgc2",
    second: "Image!xgc2-camera-ar",
    direction: "row",
    splitPercentage: 45,
  });
  assert.deepEqual(Object.keys(layout.configById), ["3D!xgc2", "Image!xgc2-camera-ar"]);

  const panel = layout.configById[layout.layout.first];
  assert.deepEqual(Object.keys(panel.topics), ["/xgc/scene"]);
  assert.deepEqual(panel.topics["/xgc/scene"], {
    visible: true,
    showOutlines: false,
  });
  assert.equal(panel.followTf, "world");
  assert.equal(panel.followMode, "follow-pose");
  assert.equal(panel.cameraState.distance, 12);
  assert.equal(panel.scene.meshUpAxis, "z_up");
  assert.deepEqual(panel.scene.transforms, { showLabel: false, axisScale: 0, lineWidth: 0 });

  const ar = layout.configById[layout.layout.second];
  assert.deepEqual(ar.imageMode, {
    imageTopic: "/usb_cam/image_raw",
    calibrationTopic: "/usb_cam/camera_info",
    synchronize: false,
    rotation: 0,
    annotations: {},
  });
  assert.deepEqual(ar.topics["/xgc/scene"], { visible: true, showOutlines: false });
  assert.equal(ar.scene.labelScaleFactor, 1.25);
  assert.equal(ar.scene.meshUpAxis, "z_up");
});

test("accepts nested Lichtblick split layouts and rejects malformed trees", () => {
  assert.equal(isPanelLayout("3D!xgc2"), true);
  assert.equal(isPanelLayout({
    first: "3D!xgc2",
    second: "Image!ar",
    direction: "row",
    splitPercentage: 45,
  }), true);
  assert.equal(isPanelLayout({ first: "3D!xgc2", second: "Image!ar" }), false);
  assert.equal(isPanelLayout({
    first: "3D!xgc2",
    second: "Image!ar",
    direction: "row",
    splitPercentage: 100,
  }), false);
});

test("applies run-scoped grid defaults without mutating the packaged layout", () => {
  const layout = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../launcher/default-layout.json"), "utf8"),
  );
  const configured = configureDefaultLayout(layout, {
    arVisible: true,
    visible: false,
    color: "#112233",
    size: 25,
    divisions: 50,
    lineWidth: 2,
  });
  const layer = configured.configById["3D!xgc2"].layers["xgc2-grid"];
  assert.deepEqual(
    { visible: layer.visible, color: layer.color, size: layer.size, divisions: layer.divisions, lineWidth: layer.lineWidth },
    { visible: false, color: "#112233", size: 25, divisions: 50, lineWidth: 2 },
  );
  assert.equal(layout.configById["3D!xgc2"].layers["xgc2-grid"].color, "#248eff");
});

test("removes the camera AR panel when the Run disables its initial view", () => {
  const layout = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../launcher/default-layout.json"), "utf8"),
  );
  const configured = configureDefaultLayout(layout, {
    arVisible: false,visible: true,color: "#248eff",size: 10,divisions: 10,lineWidth: 1,
  });
  assert.equal(configured.layout, "3D!xgc2");
  assert.equal(configured.configById["Image!xgc2-camera-ar"], undefined);
  assert.notEqual(layout.configById["Image!xgc2-camera-ar"], undefined);
});

test("builds an AR-only initial view for a standalone origin", () => {
  const layout = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../launcher/default-layout.json"), "utf8"),
  );
  const configured = configureDefaultLayout(layout, {
    initialView: "ar",arVisible: true,visible: true,color: "#248eff",size: 10,divisions: 10,lineWidth: 1,
  });
  assert.equal(configured.layout, "Image!xgc2-camera-ar");
  assert.deepEqual(Object.keys(configured.configById), ["Image!xgc2-camera-ar"]);
  assert.notEqual(layout.configById["3D!xgc2"], undefined);
});

test("builds independent 3D and camera AR layouts", () => {
  const layout = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../launcher/default-layout.json"), "utf8"),
  );
  const threeDee = configureStandalonePanel(layout, "3D!xgc2");
  const ar = configureStandalonePanel(layout, "Image!xgc2-camera-ar");

  assert.equal(threeDee.layout, "3D!xgc2");
  assert.deepEqual(Object.keys(threeDee.configById), ["3D!xgc2"]);
  assert.equal(ar.layout, "Image!xgc2-camera-ar");
  assert.deepEqual(Object.keys(ar.configById), ["Image!xgc2-camera-ar"]);
  assert.throws(() => configureStandalonePanel(layout, "Image!missing"), /missing panel/);
  assert.equal(typeof layout.layout, "object");
});

test("exposes bounded grid parameters through the trusted process definition", () => {
  const plugin = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "../process-definitions/xgc2-lichtblick-web.json"),
    "utf8",
  ));
  const definition = plugin.definitions.findLast(
    (candidate) => candidate.id === "lichtblick-web",
  );
  assert.equal(definition.version, "1.5.0");
  assert.deepEqual(
    Object.keys(definition.parameters.properties).sort(),
    ["arVisible", "bridgePort", "gridColor", "gridDivisions", "gridLineWidth", "gridSize", "gridVisible", "port"],
  );
  assert.deepEqual(definition.command.args.slice(-12), [
    "--ar-visible", "${arVisible}",
    "--grid-visible", "${gridVisible}",
    "--grid-color", "${gridColor}",
    "--grid-size", "${gridSize}",
    "--grid-divisions", "${gridDivisions}",
    "--grid-line-width", "${gridLineWidth}",
  ]);
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
    configById: {
      "3D!xgc2": {
        topics: { "/xgc/scene": { visible: true } },
        layers: {
          "xgc2-grid": {
            layerId: "foxglove.Grid",
            visible: true,
            color: "#248eff",
            size: 10,
            divisions: 10,
            lineWidth: 1,
          },
        },
      },
      "Image!xgc2-camera-ar": {
        imageMode: {
          imageTopic: "/usb_cam/image_raw",
          calibrationTopic: "/usb_cam/camera_info",
        },
        topics: { "/xgc/scene": { visible: true } },
      },
    },
    layout: {
      first: "3D!xgc2",
      second: "Image!xgc2-camera-ar",
      direction: "row",
      splitPercentage: 45,
    },
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

  const threeDeeLayout = await getJson(port, "/xgc2-3d-layout.json");
  assert.equal(threeDeeLayout.body.layout, "3D!xgc2");
  assert.deepEqual(Object.keys(threeDeeLayout.body.configById), ["3D!xgc2"]);

  const arLayout = await getJson(port, "/xgc2-ar-layout.json");
  assert.equal(arLayout.body.layout, "Image!xgc2-camera-ar");
  assert.deepEqual(Object.keys(arLayout.body.configById), ["Image!xgc2-camera-ar"]);

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
