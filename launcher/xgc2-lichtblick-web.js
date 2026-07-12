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
const ENV_FILE = process.env.XGC2_LICHTBLICK_WEB_ENV_FILE ?? "/etc/xgc2/lichtblick-web.env";
const DEFAULT_STATIC_ROOT = "/usr/lib/xgc2/lichtblick-web/web";
const DEFAULT_LAYOUT_FILE =
  process.env.XGC2_LICHTBLICK_WEB_DEFAULT_LAYOUT ??
  "/usr/lib/xgc2/lichtblick-web/default-layout.json";
// STATIC_ROOT is normally the installed-path constant above; it can be
// overridden by the XGC2_LICHTBLICK_WEB_STATIC_ROOT environment variable
// for development/testing without changing the package.
const STATIC_ROOT = process.env.XGC2_LICHTBLICK_WEB_STATIC_ROOT ?? DEFAULT_STATIC_ROOT;
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
      default:
        if (arg.startsWith("--")) {
          throw new Error(`unknown option: ${arg}`);
        }
        throw new Error(`unexpected positional argument: ${arg}`);
    }
  }
  return opts;
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

function loadDefaultLayout() {
  const parsed = JSON.parse(fs.readFileSync(DEFAULT_LAYOUT_FILE, "utf8"));
  if (typeof parsed !== "object" || parsed === null || typeof parsed.layout !== "string") {
    throw new Error(`${DEFAULT_LAYOUT_FILE} is not a valid Lichtblick layout`);
  }
  return parsed;
}

function serveIndex(res, transformedIndex) {
  const body = Buffer.from(transformedIndex);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

function serveStatic(req, res, prefix, transformedIndex) {
  const urlPath = req.url.split("?", 1)[0];
  let stripped = urlPath;
  if (prefix !== "/" && urlPath.startsWith(prefix)) {
    stripped = urlPath.slice(prefix.length);
    if (!stripped.startsWith("/")) stripped = `/${stripped}`;
  }
  if (stripped === "/" || stripped === "" || stripped === "/index.html") {
    serveIndex(res, transformedIndex);
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
        serveIndex(res, transformedIndex);
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

function buildRequestListener(targetWs, publicPrefix, transformedIndex) {
  return function requestListener(req, res) {
    if (isWebSocketPath(req.url)) {
      // Hand off to raw socket handling in `upgrade` handler below.
      res.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("upgrade required");
      return;
    }
    // Lightweight health probe (no cache; useful for systemd / k8s).
    if (req.url === "/healthz" || req.url === "/health") {
      const body = JSON.stringify({
        status: "ok",
        upstream: `${targetWs.protocol}//${targetWs.hostname}:${targetWs.port}${targetWs.path}`,
      });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }
    serveStatic(req, res, publicPrefix, transformedIndex);
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
  try {
    const indexSource = fs.readFileSync(path.join(STATIC_ROOT, "index.html"), "utf8");
    transformedIndex = transformIndexHtml(indexSource, loadDefaultLayout(), prefix);
  } catch (err) {
    process.stderr.write(`${LOG_PREFIX}: cannot prepare web entrypoint: ${err.message}\n`);
    process.exit(1);
  }

  const server = http.createServer(buildRequestListener(targetWs, prefix, transformedIndex));

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
    proxyWebSocket(req, clientSocket, head, targetWs);
  });

  server.on("listening", () => {
    const addr = server.address();
    const bound = typeof addr === "object" && addr
      ? `${addr.address}:${addr.port}`
      : "?";
    logInfo(`serving Lichtblick web bundle on http://${bound}${prefix}/`);
    logInfo(
      `WebSocket upstream: ${targetWs.protocol}//${targetWs.hostname}:${targetWs.port}${targetWs.path}`,
    );
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
  parseWsUrl,
  parseArgs,
  safeJoin,
  transformIndexHtml,
};
