#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
//
// xgc2-lichtblick-web launcher
//
// Serves the static Lichtblick web bundle from /usr/lib/xgc2/lichtblick-web/web
// on a local HTTP port and reverse-proxies WebSocket connections on
// /lichtblick/ws (and /ws as a fallback) to a configurable upstream.
//
// Default upstream: ws://127.0.0.1:8765 (XGC2 Robot Control Plane).
// Override per-launch with --control-plane-url, or per-machine by setting
// CONTROL_PLANE_URL in /etc/xgc2/lichtblick-web.env.
//
// Pure Node stdlib so the package does not need npm dependencies and a
// Debian Depends on `nodejs` is sufficient.

"use strict";

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");
const net = require("node:net");
const tls = require("node:tls");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const DEFAULT_CONTROL_PLANE_URL = "ws://127.0.0.1:8765";
const DEFAULT_PUBLIC_URL_PREFIX = "/";
const DEFAULT_AR_VISIBLE = true;
const DEFAULT_INITIAL_VIEW = "split";
const DEFAULT_GRID_COLOR = "#248eff";
const DEFAULT_GRID_SIZE = 10;
const DEFAULT_GRID_DIVISIONS = 10;
const DEFAULT_GRID_LINE_WIDTH = 1;
const DEFAULT_FRAME_ANCESTORS = "'self' http://127.0.0.1:5173 http://localhost:5173";
const ENV_FILE = process.env.XGC2_LICHTBLICK_WEB_ENV_FILE ?? "/etc/xgc2/lichtblick-web.env";
const DEFAULT_STATIC_ROOT = "/usr/lib/xgc2/lichtblick-web/web";
const DEFAULT_BUILD_INFO_FILE = "/usr/lib/xgc2/lichtblick-web/build-info.json";
const DEFAULT_LAYOUT_FILE =
  process.env.XGC2_LICHTBLICK_WEB_DEFAULT_LAYOUT ??
  "/usr/lib/xgc2/lichtblick-web/default-layout.json";
// STATIC_ROOT is normally the installed-path constant above; it can be
// overridden by the XGC2_LICHTBLICK_WEB_STATIC_ROOT environment variable
// for development/testing without changing the package.
const STATIC_ROOT = process.env.XGC2_LICHTBLICK_WEB_STATIC_ROOT ?? DEFAULT_STATIC_ROOT;
const BUILD_INFO_FILE =
  process.env.XGC2_LICHTBLICK_WEB_BUILD_INFO ?? DEFAULT_BUILD_INFO_FILE;
const LOG_PREFIX = "xgc2-lichtblick-web";

function logLine(level, message) {
  const ts = new Date().toISOString();
  process.stdout.write(`${ts} ${level.padEnd(5)} ${LOG_PREFIX}: ${message}\n`);
}

function logInfo(message) { logLine("info", message); }
function logWarn(message) { logLine("warn", message); }
function logError(message) { logLine("error", message); }

// ---- Argument parsing -------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    host: null,
    port: null,
    controlPlaneUrl: null,
    publicUrlPrefix: null,
    allowedOrigins: [],
    frameAncestors: null,
    initialView: null,
    arVisible: null,
    gridVisible: null,
    gridColor: null,
    gridSize: null,
    gridDivisions: null,
    gridLineWidth: null,
    showHelp: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        opts.showHelp = true;
        break;
      case "--host":
        opts.host = argv[++i];
        break;
      case "--port":
        opts.port = Number.parseInt(argv[++i], 10);
        if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
          throw new Error(`invalid --port value: ${argv[i]}`);
        }
        break;
      case "--control-plane-url":
        opts.controlPlaneUrl = argv[++i];
        break;
      case "--public-url-prefix":
        opts.publicUrlPrefix = argv[++i];
        break;
      case "--allowed-origin":
        opts.allowedOrigins.push(argv[++i]);
        break;
      case "--frame-ancestors":
        opts.frameAncestors = argv[++i];
        break;
      case "--initial-view":
        opts.initialView = parseInitialView(argv[++i]);
        break;
      case "--ar-visible":
        opts.arVisible = parseBooleanOption(arg, argv[++i]);
        break;
      case "--grid-visible":
        opts.gridVisible = parseBooleanOption(arg, argv[++i]);
        break;
      case "--grid-color":
        opts.gridColor = parseGridColor(argv[++i]);
        break;
      case "--grid-size":
        opts.gridSize = parseNumberOption(arg, argv[++i], 0.1, 100000);
        break;
      case "--grid-divisions":
        opts.gridDivisions = parseIntegerOption(arg, argv[++i], 1, 10000);
        break;
      case "--grid-line-width":
        opts.gridLineWidth = parseNumberOption(arg, argv[++i], 0.1, 100);
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`unknown option: ${arg}`);
        }
        throw new Error(`unexpected positional argument: ${arg}`);
    }
  }
  return opts;
}

function parseBooleanOption(name, value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid ${name} value: ${value}`);
}

function parseInitialView(value) {
  if (value === "split" || value === "3d" || value === "ar") return value;
  throw new Error(`invalid --initial-view value: ${value}`);
}

function parseNumberOption(name, value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`invalid ${name} value: ${value}`);
  }
  return parsed;
}

function parseIntegerOption(name, value, minimum, maximum) {
  const parsed = parseNumberOption(name, value, minimum, maximum);
  if (!Number.isInteger(parsed)) throw new Error(`invalid ${name} value: ${value}`);
  return parsed;
}

function parseGridColor(value) {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`invalid --grid-color value: ${value}`);
  }
  return value.toLowerCase();
}

function printHelp() {
  process.stdout.write(
    [
      `Usage: ${LOG_PREFIX} [options]`,
      "",
      "Serves the pinned Lichtblick web bundle on a local HTTP port and",
      "reverse-proxies WebSocket traffic to a configurable upstream.",
      "",
      "Options:",
      "  --host <ip|hostname>           Bind address. Env: HOST.",
      `                                   Default: ${DEFAULT_HOST}`,
      `  --port <port>                  TCP port. Env: PORT.`,
      `                                   Default: ${DEFAULT_PORT}`,
      `  --control-plane-url <wsurl>    WebSocket upstream. Env: CONTROL_PLANE_URL.`,
      `                                   Default: ${DEFAULT_CONTROL_PLANE_URL}`,
      "  --public-url-prefix <path>     URL prefix the bundle is served under.",
      "                                   Env: PUBLIC_URL_PREFIX.",
      `                                   Default: ${DEFAULT_PUBLIC_URL_PREFIX}`,
      "  --allowed-origin <origin>      Additional WebSocket browser origin.",
      "                                   May be repeated. Env: ALLOWED_ORIGINS (CSV).",
      "  --frame-ancestors <sources>    CSP frame-ancestors source list.",
      "                                   Env: FRAME_ANCESTORS.",
      `                                   Default: ${DEFAULT_FRAME_ANCESTORS}`,
      "  --initial-view <split|3d|ar>   Choose the standalone initial panel layout.",
      `                                   Default: ${DEFAULT_INITIAL_VIEW}`,
      "  --ar-visible <true|false>      Open the camera AR panel in the initial layout.",
      `                                   Default: ${DEFAULT_AR_VISIBLE}`,
      "  --grid-visible <true|false>    Show the initial 3D grid.",
      `                                   Default: true`,
      "  --grid-color <#rrggbb>         Initial 3D grid color.",
      `                                   Default: ${DEFAULT_GRID_COLOR}`,
      "  --grid-size <number>           Initial grid side length.",
      `                                   Default: ${DEFAULT_GRID_SIZE}`,
      "  --grid-divisions <integer>     Initial grid subdivision count.",
      `                                   Default: ${DEFAULT_GRID_DIVISIONS}`,
      "  --grid-line-width <number>     Initial grid line width.",
      `                                   Default: ${DEFAULT_GRID_LINE_WIDTH}`,
      "  -h, --help                     Show this help and exit.",
      "",
      "Environment variables override compiled-in defaults but are themselves",
      `overridden by command-line flags. Settings in ${ENV_FILE} (KEY=VALUE`,
      "lines, one per line, comments with '#') are loaded first.",
      "",
    ].join("\n"),
  );
}

// ---- /etc/xgc2/lichtblick-web.env loader -----------------------------------

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch (err) {
    logWarn(`cannot read ${envPath}: ${err.message}`);
    return;
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      logWarn(`ignoring malformed line in ${envPath}: ${rawLine}`);
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes (single or double).
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // Do not override an already-set process env (so the operator can
    // override the file from the shell).
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// ---- WebSocket reverse proxy (RFC 6455, handcrafted over net.Socket) --------

function parseWsUrl(rawUrl) {
  const parsed = new url.URL(rawUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(
      `control-plane URL must use ws:// or wss://, got ${parsed.protocol}`,
    );
  }
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === "wss:"
        ? 443
        : 80,
    path: `${parsed.pathname || "/"}${parsed.search || ""}`,
  };
}

function normalizeOrigin(rawOrigin) {
  const value = String(rawOrigin ?? "").trim();
  if (value === "") throw new Error("origin must not be empty");
  const parsed = new url.URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`origin must use http:// or https://, got ${parsed.protocol}`);
  }
  if (parsed.hostname.includes("*")) {
    throw new Error(`origin must not contain a wildcard hostname: ${value}`);
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`origin must not include credentials, path, query, or fragment: ${value}`);
  }
  return parsed.origin;
}

function parseConfiguredOrigins(values) {
  const origins = new Set();
  for (const rawValue of values) {
    for (const item of String(rawValue ?? "").split(",")) {
      if (item.trim() !== "") origins.add(normalizeOrigin(item));
    }
  }
  return origins;
}

function defaultListenerOrigins(port) {
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
}

function validateFrameAncestors(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (value === "") throw new Error("frame-ancestors must not be empty");
  if (/[,;\r\n]/.test(value)) {
    throw new Error("frame-ancestors contains an invalid separator");
  }
  const sources = value.split(/\s+/);
  if (sources.includes("'none'") && sources.length !== 1) {
    throw new Error("frame-ancestors 'none' cannot be combined with other sources");
  }
  const normalized = sources.map((source) => {
    if (source === "'self'" || source === "'none'") return source;
    return normalizeOrigin(source);
  });
  return normalized.join(" ");
}

function websocketOriginAllowed(originHeader, allowedOrigins) {
  if (typeof originHeader !== "string" || originHeader.trim() === "") return false;
  try {
    return allowedOrigins.has(normalizeOrigin(originHeader));
  } catch (_err) {
    return false;
  }
}

function proxyWebSocket(clientReq, clientSocket, clientHead, target) {
  const useTls = target.protocol === "wss:";
  const tlsOptions = useTls
    ? {
        hostname: target.hostname,
        port: target.port,
        servername: target.hostname,
        rejectUnauthorized: true,
      }
    : undefined;

  // Preserve the browser's WebSocket key, protocol, extensions, cookies, and
  // authorization. The browser validates Sec-WebSocket-Accept against its
  // original key, so replacing that key would make every upgrade fail.
  const clientHeaders = { ...clientReq.headers };
  delete clientHeaders.host;
  delete clientHeaders.upgrade;
  delete clientHeaders.connection;

  logInfo(
    `proxying ${clientSocket.remoteAddress}:${clientSocket.remotePort} ` +
      `${clientReq.url} -> ${target.protocol}//${target.hostname}:${target.port}${target.path}`,
  );

  const upstream = useTls
    ? tls.connect(tlsOptions, () => onUpstreamConnect())
    : net.connect(target.port, target.hostname, () => onUpstreamConnect());

  let headWritten = false;
  function onUpstreamConnect() {
    if (headWritten) return;
    headWritten = true;
    // If the client had pending data after the upgrade request, send it.
    const head = clientHead && clientHead.length > 0 ? clientHead : Buffer.alloc(0);

    const headerLines = [`GET ${target.path} HTTP/1.1`];
    headerLines.push(`Host: ${target.hostname}:${target.port}`);
    for (const [name, value] of Object.entries(clientHeaders)) {
      if (Array.isArray(value)) {
        for (const v of value) headerLines.push(`${name}: ${v}`);
      } else if (value !== undefined) {
        headerLines.push(`${name}: ${value}`);
      }
    }
    headerLines.push("Upgrade: websocket");
    headerLines.push("Connection: Upgrade");
    upstream.write(headerLines.join("\r\n") + "\r\n\r\n");
    if (head.length > 0) upstream.write(head);
  }

  let upstreamBuf = Buffer.alloc(0);
  let upgraded = false;
  upstream.on("data", (chunk) => {
    if (!upgraded) {
      upstreamBuf = Buffer.concat([upstreamBuf, chunk]);
      const headerEnd = upstreamBuf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headText = upstreamBuf.slice(0, headerEnd).toString();
      const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})/.exec(headText);
      const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 0;
      if (status !== 101) {
        logWarn(`upstream returned HTTP ${status} for upgrade`);
        try {
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        } catch (_e) { /* ignore */ }
        clientSocket.destroy();
        upstream.destroy();
        return;
      }
      // Forward everything buffered so far (status line + headers, plus any
      // post-header bytes already received) to the client.
      const after = upstreamBuf.slice(headerEnd + 4);
      clientSocket.write(upstreamBuf.slice(0, headerEnd + 4));
      upgraded = true;
      if (after.length > 0) clientSocket.write(after);
      logInfo(`bidirectional WebSocket pipe established for ${clientReq.url}`);
    } else {
      clientSocket.write(chunk);
    }
  });

  function onSocketError(err) {
    logWarn(`socket error during WebSocket proxy: ${err.message}`);
  }
  upstream.on("error", (err) => {
    logError(`upstream connect error: ${err.message}`);
    try {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    } catch (_e) { /* ignore */ }
    clientSocket.destroy();
  });
  clientSocket.on("error", onSocketError);

  // Forward bytes from client to upstream once the upgrade has succeeded.
  clientSocket.on("data", (chunk) => {
    if (upgraded) upstream.write(chunk);
  });

  clientSocket.on("end", () => upstream.end());
  clientSocket.on("close", () => upstream.destroy());
  upstream.on("end", () => clientSocket.end());
  upstream.on("close", () => clientSocket.destroy());
}

// ---- Static file serving ---------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function safeJoin(root, requested) {
  // Decode, normalize, and ensure the result is inside root. Prevents
  // directory traversal (`../`) and absolute-path escapes.
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch (_err) {
    return null;
  }
  // Strip a single leading slash so path.posix.normalize treats the
  // remainder as relative — every URL path starts with `/`, but we
  // always re-anchor against the absolute `root` below.
  const relative = decoded.startsWith("/") ? decoded.slice(1) : decoded;
  const normalized = path.posix.normalize(relative);
  // After normalize, a leading ".." means the caller tried to escape.
  if (normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  const full = path.join(root, normalized);
  const resolvedRoot = path.resolve(root);
  const resolvedFull = path.resolve(full);
  if (
    resolvedFull !== resolvedRoot &&
    !resolvedFull.startsWith(resolvedRoot + path.sep)
  ) {
    return null;
  }
  return resolvedFull;
}

function buildAutoConnectScript(prefix) {
  const websocketPath = `${prefix === "/" ? "" : prefix}/ws`;
  return `<script>(function(){
    var current = new URL(window.location.href);
    if (!current.searchParams.has("ds")) {
      var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      current.searchParams.set("ds", "foxglove-websocket");
      current.searchParams.set("ds.url", protocol + "//" + window.location.host + ${JSON.stringify(websocketPath)});
      window.history.replaceState(null, "", current.href);
    }
  })();</script>`;
}

function transformIndexHtml(source, defaultLayout, prefix) {
  const placeholder = "/*LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER*/";
  if (!source.includes(placeholder)) {
    throw new Error("Lichtblick default-layout placeholder is missing from index.html");
  }
  const withLayout = source.replace(placeholder, JSON.stringify(defaultLayout));
  const autoConnect = buildAutoConnectScript(prefix);
  if (!withLayout.includes("</head>")) {
    throw new Error("Lichtblick index.html has no closing head element");
  }
  return withLayout.replace("</head>", `${autoConnect}</head>`);
}

function isPanelLayout(value) {
  if (typeof value === "string") return value.length > 0;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (value.direction === "row" || value.direction === "column") &&
    Number.isFinite(value.splitPercentage) &&
    value.splitPercentage > 0 && value.splitPercentage < 100 &&
    isPanelLayout(value.first) && isPanelLayout(value.second);
}

function loadDefaultLayout() {
  const parsed = JSON.parse(fs.readFileSync(DEFAULT_LAYOUT_FILE, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !isPanelLayout(parsed.layout)) {
    throw new Error(`${DEFAULT_LAYOUT_FILE} is not a valid Lichtblick layout`);
  }
  return parsed;
}

function configureDefaultLayout(layout, grid) {
  const configured = structuredClone(layout);
  const panel = configured.configById?.["3D!xgc2"];
  const layer = panel?.layers?.["xgc2-grid"];
  if (!layer || layer.layerId !== "foxglove.Grid") {
    throw new Error(`${DEFAULT_LAYOUT_FILE} is missing the XGC grid layer`);
  }
  layer.visible = grid.visible;
  layer.color = grid.color;
  layer.size = grid.size;
  layer.divisions = grid.divisions;
  layer.lineWidth = grid.lineWidth;
  const initialView = grid.initialView ?? (grid.arVisible === false ? "3d" : DEFAULT_INITIAL_VIEW);
  if (initialView === "3d") {
    delete configured.configById["Image!xgc2-camera-ar"];
    configured.layout = "3D!xgc2";
  } else if (initialView === "ar") {
    delete configured.configById["3D!xgc2"];
    configured.layout = "Image!xgc2-camera-ar";
  }
  return configured;
}

function configureStandalonePanel(layout, panelId) {
  const panel = layout.configById?.[panelId];
  if (typeof panel !== "object" || panel === null || Array.isArray(panel)) {
    throw new Error(`${DEFAULT_LAYOUT_FILE} is missing panel ${panelId}`);
  }
  const configured = structuredClone(layout);
  configured.configById = { [panelId]: configured.configById[panelId] };
  configured.layout = panelId;
  return configured;
}

function loadBuildInfo() {
  const parsed = JSON.parse(fs.readFileSync(BUILD_INFO_FILE, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    parsed.schema !== "xgc2.lichtblick-web.build.v1" ||
    typeof parsed.package !== "string" ||
    typeof parsed.version !== "string" ||
    typeof parsed.upstreamSha !== "string"
  ) {
    throw new Error(`${BUILD_INFO_FILE} is not valid XGC2 Lichtblick build metadata`);
  }
  return parsed;
}

function securityHeaders(frameAncestors) {
  return {
    "Content-Security-Policy":
      `frame-ancestors ${frameAncestors}; base-uri 'self'; object-src 'none'`,
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  };
}

function serveIndex(res, transformedIndex, responseSecurityHeaders) {
  const body = Buffer.from(transformedIndex);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    ...responseSecurityHeaders,
  });
  res.end(body);
}

function serveStatic(req, res, prefix, transformedIndex, responseSecurityHeaders) {
  const urlPath = req.url.split("?", 1)[0];
  let stripped = urlPath;
  if (prefix !== "/" && urlPath.startsWith(prefix)) {
    stripped = urlPath.slice(prefix.length);
    if (!stripped.startsWith("/")) stripped = `/${stripped}`;
  }
  if (stripped === "/" || stripped === "" || stripped === "/index.html") {
    serveIndex(res, transformedIndex, responseSecurityHeaders);
    return;
  }

  const target = safeJoin(STATIC_ROOT, stripped);
  if (target === null) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  fs.stat(target, (statErr, stats) => {
    if (statErr || !stats) {
      // SPA fallback: serve index.html for paths without an extension
      // (client-side router).
      if (!path.extname(target)) {
        serveIndex(res, transformedIndex, responseSecurityHeaders);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    if (stats.isDirectory()) {
      const indexPath = path.join(target, "index.html");
      fs.readFile(indexPath, (readErr, body) => {
        if (readErr) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("not found");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          ...responseSecurityHeaders,
        });
        res.end(body);
      });
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": stats.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      ...responseSecurityHeaders,
    });
    fs.createReadStream(target).pipe(res);
  });
}

// ---- HTTP server wiring ----------------------------------------------------

function isWebSocketUpgrade(req) {
  return (
    req.headers.upgrade &&
    req.headers.upgrade.toLowerCase() === "websocket"
  );
}

function isWebSocketPath(reqUrl) {
  const pathname = reqUrl.split("?", 1)[0];
  return pathname === "/ws" || pathname.endsWith("/ws");
}

function endpointMatches(reqUrl, publicPrefix, endpoint) {
  const pathname = reqUrl.split("?", 1)[0];
  return pathname === `/${endpoint}` ||
    (publicPrefix !== "/" && pathname === `${publicPrefix}/${endpoint}`);
}

function writeJson(res, status, payload, responseSecurityHeaders) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    ...responseSecurityHeaders,
  });
  res.end(body);
}

function buildRequestListener(
  targetWs,
  publicPrefix,
  transformedIndex,
  defaultLayout,
  buildInfo,
  responseSecurityHeaders,
) {
  return function requestListener(req, res) {
    if (isWebSocketPath(req.url)) {
      // Hand off to raw socket handling in `upgrade` handler below.
      res.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("upgrade required");
      return;
    }
    // Lightweight health probe (no cache; useful for Process Supervisor and
    // container readiness checks).
    if (endpointMatches(req.url, publicPrefix, "healthz") ||
        endpointMatches(req.url, publicPrefix, "health")) {
      writeJson(res, 200, {
        status: "ok",
        upstream: `${targetWs.protocol}//${targetWs.hostname}:${targetWs.port}${targetWs.path}`,
      }, responseSecurityHeaders);
      return;
    }
    if (endpointMatches(req.url, publicPrefix, "version")) {
      writeJson(res, 200, buildInfo, responseSecurityHeaders);
      return;
    }
    // Lichtblick's built-in `layoutUrl` deep link imports and selects this
    // layout for an embedded XGC panel. Exposing the same validated layout
    // that is injected as the first-run default also updates browsers which
    // already have an older layout in IndexedDB, without patching Lichtblick.
    if (endpointMatches(req.url, publicPrefix, "xgc2-layout.json")) {
      writeJson(res, 200, defaultLayout, responseSecurityHeaders);
      return;
    }
    if (endpointMatches(req.url, publicPrefix, "xgc2-3d-layout.json")) {
      writeJson(
        res,
        200,
        configureStandalonePanel(defaultLayout, "3D!xgc2"),
        responseSecurityHeaders,
      );
      return;
    }
    if (endpointMatches(req.url, publicPrefix, "xgc2-ar-layout.json")) {
      writeJson(
        res,
        200,
        configureStandalonePanel(defaultLayout, "Image!xgc2-camera-ar"),
        responseSecurityHeaders,
      );
      return;
    }
    serveStatic(req, res, publicPrefix, transformedIndex, responseSecurityHeaders);
  };
}

// ---- Entry point -----------------------------------------------------------

function main() {
  loadEnvFile(ENV_FILE);

  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${LOG_PREFIX}: ${err.message}\n`);
    process.stderr.write(`Try '${LOG_PREFIX} --help' for usage.\n`);
    process.exit(2);
  }
  if (opts.showHelp) {
    printHelp();
    return;
  }

  const host = opts.host ?? process.env.HOST ?? DEFAULT_HOST;
  const port =
    opts.port ??
    (Number.parseInt(process.env.PORT ?? "", 10) || DEFAULT_PORT);
  const controlPlaneUrl =
    opts.controlPlaneUrl ??
    process.env.CONTROL_PLANE_URL ??
    DEFAULT_CONTROL_PLANE_URL;
  const publicUrlPrefix =
    opts.publicUrlPrefix ??
    process.env.PUBLIC_URL_PREFIX ??
    DEFAULT_PUBLIC_URL_PREFIX;
  const configuredOriginValues = [
    process.env.ALLOWED_ORIGINS ?? "",
    ...opts.allowedOrigins,
  ];
  const frameAncestorsValue =
    opts.frameAncestors ??
    process.env.FRAME_ANCESTORS ??
    DEFAULT_FRAME_ANCESTORS;
  const grid = {
    initialView: opts.initialView ?? DEFAULT_INITIAL_VIEW,
    arVisible: opts.arVisible ?? DEFAULT_AR_VISIBLE,
    visible: opts.gridVisible ?? true,
    color: opts.gridColor ?? DEFAULT_GRID_COLOR,
    size: opts.gridSize ?? DEFAULT_GRID_SIZE,
    divisions: opts.gridDivisions ?? DEFAULT_GRID_DIVISIONS,
    lineWidth: opts.gridLineWidth ?? DEFAULT_GRID_LINE_WIDTH,
  };

  let targetWs;
  try {
    targetWs = parseWsUrl(controlPlaneUrl);
  } catch (err) {
    process.stderr.write(`${LOG_PREFIX}: ${err.message}\n`);
    process.exit(2);
  }

  // Normalize prefix to always start with "/" and not end with "/" unless
  // it IS "/".
  let prefix = publicUrlPrefix;
  if (!prefix.startsWith("/")) prefix = `/${prefix}`;
  if (prefix.length > 1 && prefix.endsWith("/")) prefix = prefix.slice(0, -1);

  let transformedIndex;
  let defaultLayout;
  let buildInfo;
  let validatedFrameAncestors;
  let configuredOrigins;
  try {
    const indexSource = fs.readFileSync(path.join(STATIC_ROOT, "index.html"), "utf8");
    defaultLayout = configureDefaultLayout(loadDefaultLayout(), grid);
    transformedIndex = transformIndexHtml(indexSource, defaultLayout, prefix);
    buildInfo = loadBuildInfo();
    validatedFrameAncestors = validateFrameAncestors(frameAncestorsValue);
    configuredOrigins = parseConfiguredOrigins(configuredOriginValues);
  } catch (err) {
    process.stderr.write(`${LOG_PREFIX}: cannot prepare web entrypoint: ${err.message}\n`);
    process.exit(1);
  }

  const responseSecurityHeaders = securityHeaders(validatedFrameAncestors);
  const server = http.createServer(buildRequestListener(
    targetWs,
    prefix,
    transformedIndex,
    defaultLayout,
    buildInfo,
    responseSecurityHeaders,
  ));
  let allowedOrigins = configuredOrigins;

  server.on("upgrade", (req, clientSocket, head) => {
    if (!isWebSocketUpgrade(req)) {
      clientSocket.destroy();
      return;
    }
    if (!isWebSocketPath(req.url)) {
      clientSocket.write(
        "HTTP/1.1 404 Not Found\r\n" +
          "Connection: close\r\n" +
          "Content-Length: 0\r\n" +
          "\r\n",
      );
      clientSocket.destroy();
      return;
    }
    if (!websocketOriginAllowed(req.headers.origin, allowedOrigins)) {
      logWarn(`rejecting WebSocket origin: ${String(req.headers.origin ?? "<missing>")}`);
      clientSocket.write(
        "HTTP/1.1 403 Forbidden\r\n" +
          "Connection: close\r\n" +
          "Content-Length: 0\r\n" +
          "\r\n",
      );
      clientSocket.destroy();
      return;
    }
    proxyWebSocket(req, clientSocket, head, targetWs);
  });

  server.on("listening", () => {
    const addr = server.address();
    const bound = typeof addr === "object" && addr
      ? `${addr.address}:${addr.port}`
      : "?";
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    allowedOrigins = new Set([
      ...defaultListenerOrigins(actualPort),
      ...configuredOrigins,
    ]);
    logInfo(`serving Lichtblick web bundle on http://${bound}${prefix}/`);
    logInfo(
      `WebSocket upstream: ${targetWs.protocol}//${targetWs.hostname}:${targetWs.port}${targetWs.path}`,
    );
    logInfo(`allowed WebSocket origins: ${[...allowedOrigins].join(", ")}`);
    logInfo("open the URL above in a browser, or embed behind a reverse proxy");
  });

  server.on("error", (err) => {
    logError(`server error: ${err.message}`);
    process.exit(1);
  });

  const shutdown = (signal) => {
    logInfo(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    // Force-exit if close hangs on lingering keep-alive sockets.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(port, host);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildAutoConnectScript,
  configureDefaultLayout,
  configureStandalonePanel,
  defaultListenerOrigins,
  endpointMatches,
  isPanelLayout,
  loadBuildInfo,
  normalizeOrigin,
  parseWsUrl,
  parseArgs,
  parseConfiguredOrigins,
  safeJoin,
  securityHeaders,
  transformIndexHtml,
  validateFrameAncestors,
  websocketOriginAllowed,
};
