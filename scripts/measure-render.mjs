#!/usr/bin/env node
// Render-latency harness. Zero dependencies.
//
//   node scripts/measure-render.mjs [--timeout <seconds>] [--open-cmd '<cmd>']
//
// Serves an instrumentation page on http://127.0.0.1:7391/ whose workload is a
// fixed 600 requestAnimationFrame frames driving scrollTop down a 20 000 px
// document, with a background-color repaint every 10th frame. The page records
// the frame deltas, POSTs them to /stats and sets document.title to
// "render-stats-sent".
//
// The page also POSTs /hit as soon as it loads, before any frame runs, and the
// server prints `HIT <user-agent>`. A run only counts as "in the browser" when
// that user agent contains WebKit — curl and node hits are reported as such.
//
// `--open-cmd` launches a browser for you; `{url}` is replaced with the harness
// URL (appended when the placeholder is absent). The browser's process group is
// killed when the harness exits.
//
// The server prints `RESULT <json>` on one line, replies 200 and exits. A hard
// timeout (120 s by default) exits non-zero.
//
// The /hit and /stats endpoints accept any request, so the harness can be
// self-tested without a browser.

import { spawn } from "node:child_process";
import { createServer } from "node:http";

const PORT = 7391;
const HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_S = 120;
const FRAMES = 600;
const PAGE_URL = `http://${HOST}:${PORT}/`;

function usageError(message) {
  process.stderr.write(`measure-render: ${message}\n`);
  process.stderr.write(
    "usage: measure-render.mjs [--timeout <seconds>] [--open-cmd '<command with {url}>']\n",
  );
  process.exit(2);
}

let timeoutSeconds = DEFAULT_TIMEOUT_S;
let openCommand = null;
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  const value = argv[index + 1];
  if (flag === "--timeout") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) usageError(`invalid --timeout ${value}`);
    timeoutSeconds = parsed;
    index += 1;
  } else if (flag === "--open-cmd") {
    if (!value) usageError("--open-cmd needs a command");
    openCommand = value;
    index += 1;
  } else if (flag === "--help" || flag === "-h") {
    usageError("help requested");
  } else {
    usageError(`unknown argument ${flag}`);
  }
}

const PAGE = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8"><title>render-harness</title>',
  "<style>",
  "html,body{margin:0;padding:0}",
  "body{height:20000px;background:#101010;color:#eee;font:14px/1.4 monospace}",
  "#marker{position:absolute;top:0;left:0;width:100%;height:64px;",
  "background:#161616;border-bottom:1px solid #303030}",
  "</style></head><body>",
  '<div id="marker">render harness</div>',
  "<script>",
  "(() => {",
  `  const TOTAL = ${FRAMES};`,
  "  const deltas = [];",
  "  let last = 0;",
  "  let frame = 0;",
  "  const root = document.documentElement;",
  "  const body = document.body;",
  "  const maxScroll = () => Math.max(0, root.scrollHeight - window.innerHeight);",
  "  fetch('/hit', { method: 'POST' }).catch(() => {});",
  "  function step(now) {",
  "    if (last !== 0) deltas.push(now - last);",
  "    last = now;",
  "    frame += 1;",
  "    root.scrollTop = Math.round((frame / TOTAL) * maxScroll());",
  "    if (frame % 10 === 0) body.style.backgroundColor = frame % 20 === 0 ? '#101010' : '#181818';",
  "    if (frame < TOTAL) { requestAnimationFrame(step); return; }",
  "    fetch('/stats', { method: 'POST', body: JSON.stringify({ deltas }) })",
  "      .then(() => { document.title = 'render-stats-sent'; })",
  "      .catch((error) => { document.title = 'render-stats-failed:' + error.message; });",
  "  }",
  "  requestAnimationFrame(step);",
  "})();",
  "</script></body></html>",
].join("\n");

/** Nearest-rank percentile on an ascending array. */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index];
}

const round = (value) => (value === null ? null : Math.round(value * 1000) / 1000);

function summarise(deltas) {
  const clean = deltas
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const sorted = [...clean].sort((a, b) => a - b);
  return {
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: sorted.length > 0 ? round(sorted.at(-1)) : null,
    framesOver16_7: clean.filter((value) => value > 16.7).length,
    framesOver33_3: clean.filter((value) => value > 33.3).length,
    frames: clean.length,
  };
}

/* -------------------------------------------------------------- lifecycle */

let finished = false;
let timer = null;
let browser = null;
const hits = [];

function finish(code, payload) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (payload) process.stdout.write(`RESULT ${JSON.stringify(payload)}\n`);
  const webkitHits = hits.filter((hit) => hit.webkit).length;
  process.stdout.write(
    `measure-render: hits=${hits.length} webkit=${webkitHits} ` +
      `other=${hits.length - webkitHits} ` +
      `inBrowser=${webkitHits > 0 ? "yes" : "NO"}\n`,
  );
  if (browser) {
    try {
      process.kill(-browser.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  server.close(() => process.exit(code));
  // Nothing should hold the loop open, but a lingering socket must not win.
  setTimeout(() => process.exit(code), 500).unref();
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", PAGE_URL);
  const userAgent = req.headers["user-agent"] ?? "";

  if (req.method === "POST" && url.pathname === "/hit") {
    const webkit = /webkit/i.test(userAgent);
    hits.push({ userAgent, webkit });
    process.stdout.write(`HIT ${userAgent}\n`);
    process.stderr.write(`measure-render: page load hit (${webkit ? "WebKit" : "non-WebKit"})\n`);
    req.resume();
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(PAGE);
    return;
  }

  if (req.method === "POST" && url.pathname === "/stats") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let deltas = [];
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (Array.isArray(parsed.deltas)) deltas = parsed.deltas;
      } catch (error) {
        process.stderr.write(`measure-render: bad /stats body: ${error.message}\n`);
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad json\n");
        return;
      }
      const summary = summarise(deltas);
      if (!/webkit/i.test(userAgent)) {
        process.stderr.write(
          `measure-render: WARNING stats came from a non-WebKit agent (${userAgent || "none"})\n`,
        );
      }
      process.stdout.write(`RESULT ${JSON.stringify(summary)}\n`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`${JSON.stringify(summary)}\n`, () => finish(0));
    });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
});

server.on("error", (error) => {
  process.stderr.write(
    `measure-render: cannot serve ${HOST}:${PORT}: ${error.message}\n` +
      (error.code === "EADDRINUSE"
        ? "measure-render: port already in use; stop the other harness\n"
        : ""),
  );
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`measure-render: open ${PAGE_URL}\n`);
  process.stdout.write(
    `measure-render: waiting for exactly one POST /stats result ` +
      `(hard timeout ${timeoutSeconds}s, ${FRAMES} frames)\n`,
  );
  if (openCommand) {
    const command = openCommand.includes("{url}")
      ? openCommand.replaceAll("{url}", PAGE_URL)
      : `${openCommand} ${PAGE_URL}`;
    process.stdout.write(`measure-render: launching: ${command}\n`);
    browser = spawn(command, {
      shell: true,
      detached: true,
      stdio: ["ignore", "ignore", "inherit"],
    });
    browser.on("error", (error) => {
      process.stderr.write(`measure-render: --open-cmd failed: ${error.message}\n`);
    });
  }
  timer = setTimeout(() => {
    process.stderr.write(
      `measure-render: TIMEOUT no /stats result within ${timeoutSeconds}s — ` +
        "was the page loaded, visible and focused in the browser?\n",
    );
    finish(1);
  }, timeoutSeconds * 1000);
});
