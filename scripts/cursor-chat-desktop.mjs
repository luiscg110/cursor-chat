#!/usr/bin/env node
/**
 * Cursor Chat — standalone desktop app.
 * Talks to Cursor via SDK without opening or focusing the Cursor IDE.
 *
 *   npm run cursor:chat
 *   npm run cursor:chat:app
 *
 * Opens http://127.0.0.1:3860
 */
import { createServer } from "http";
import {
  readFileSync,
  existsSync,
  mkdirSync,
} from "fs";
import { resolve, dirname, join, extname } from "path";
import { fileURLToPath } from "url";
import { spawn, execFileSync } from "child_process";
import { createCursorChatRuntime } from "./cursor-chat-runtime.mjs";
import { createContinuousLoop } from "./continuous-loop.mjs";
import { continuousPaths, loadDiscoveries } from "./discoveries-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const uiDir = resolve(__dirname, "cursor-chat-ui");
const PORT = Number(process.env.CURSOR_CHAT_UI_PORT || 3860);
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** @type {Set<import('http').ServerResponse>} */
const sseClients = new Set();

function notifyMacOS(title, body, { sound = "Glass" } = {}) {
  if (process.platform !== "darwin") return;
  if (process.env.CURSOR_CHAT_NO_NOTIFY === "1") return;
  const t = String(title || "Cursor Chat").slice(0, 80);
  const b = String(body || "").replace(/\s+/g, " ").trim().slice(0, 180);
  if (!b) return;
  try {
    spawn(
      "osascript",
      [
        "-e",
        `display notification ${JSON.stringify(b)} with title ${JSON.stringify(t)} sound name ${JSON.stringify(sound)}`,
      ],
      { detached: true, stdio: "ignore" }
    ).unref();
  } catch {
    // ignore
  }
}

function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

const cursorChat = createCursorChatRuntime({
  root,
  broadcast,
  notify: (title, body) => notifyMacOS(title, body),
});

const continuous = createContinuousLoop({
  send: (args) => cursorChat.send(args),
  snapshot: () => cursorChat.snapshot(),
  broadcast,
  notify: (title, body) => notifyMacOS(title, body),
});
continuous.maybeResume();

function readJson(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolvePromise(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function serveStatic(req, res) {
  let pathName = new URL(req.url || "/", `http://${HOST}`).pathname;
  if (pathName === "/") pathName = "/index.html";
  const filePath = join(uiDir, pathName.replace(/^\/+/, ""));
  if (!filePath.startsWith(uiDir) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  res.end(readFileSync(filePath));
}

function openDesktopWindow() {
  if (
    process.env.CURSOR_CHAT_SKIP_WINDOW === "1" ||
    process.env.CURSOR_CHAT_APP_BUNDLE === "1"
  ) {
    console.log("[cursor:chat] skipping Chrome window (native app UI)");
    return;
  }
  const url = `http://${HOST}:${PORT}/`;
  const chrome =
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "google-chrome";
  const profile = resolve(root, "logs/cursor-chat/ui-chrome-profile");
  mkdirSync(profile, { recursive: true });
  if (existsSync(chrome) || process.platform !== "darwin") {
    spawn(
      chrome,
      [
        `--user-data-dir=${profile}`,
        `--app=${url}`,
        "--new-window",
        "--no-first-run",
        "--no-default-browser-check",
      ],
      { detached: true, stdio: "ignore" }
    ).unref();
    return;
  }
  spawn("open", ["-a", "Google Chrome", url], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

function killPrevious(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    }).trim();
    if (!out) return false;
    let killed = false;
    for (const pid of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
      try {
        const cmd = execFileSync("ps", ["-p", pid, "-o", "command="], {
          encoding: "utf8",
        });
        if (/cursor-chat-desktop\.mjs/.test(cmd)) {
          process.kill(Number(pid), "SIGTERM");
          console.log(`[cursor:chat] stopped previous desktop pid=${pid}`);
          killed = true;
        }
      } catch {
        // ignore
      }
    }
    return killed;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}`);
  const { pathname } = url;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (pathname === "/api/health") {
    const snap = cursorChat.snapshot();
    sendJson(res, 200, {
      ok: true,
      port: PORT,
      clients: sseClients.size,
      app: "cursor-chat",
      ...snap,
    });
    return;
  }

  if (pathname === "/api/cursor-chat" && req.method === "GET") {
    sendJson(res, 200, { ok: true, ...cursorChat.snapshot() });
    return;
  }

  if (pathname === "/api/cursor-chat" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const result = await cursorChat.send({
        chatId: body.chatId || "",
        text: body.text || body.prompt || "",
        cloud: Boolean(body.cloud),
        model: body.model || "",
      });
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (pathname === "/api/cursor-chat/stop" && req.method === "POST") {
    try {
      const body = await readJson(req).catch(() => ({}));
      const result = await cursorChat.stop({ chatId: body.chatId || "" });
      sendJson(res, result.ok ? 200 : 409, result);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (pathname === "/api/cursor-chat/new" && req.method === "POST") {
    try {
      const result = await cursorChat.newChat();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (pathname === "/api/continuous" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      ...continuous.status(),
      discoveries: loadDiscoveries(),
      paths: continuousPaths(),
    });
    return;
  }

  if (pathname === "/api/continuous/start" && req.method === "POST") {
    try {
      const body = await readJson(req).catch(() => ({}));
      const result = await continuous.start({
        hours: body.hours ?? 24,
        pauseMs: body.pauseMs,
        focus: body.focus || "",
        cloud: Boolean(body.cloud),
        chatId: body.chatId || "",
      });
      sendJson(res, result.ok ? 200 : 409, result);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (pathname === "/api/continuous/stop" && req.method === "POST") {
    try {
      const result = await continuous.stop("user_stop");
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(
      `data: ${JSON.stringify({
        type: "hello",
        text: "Cursor Chat listo — puedes trabajar en otra app",
        cursorChat: cursorChat.snapshot(),
        continuous: continuous.status(),
      })}\n\n`
    );
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

function startListening() {
  server.listen(PORT, HOST, () => {
    console.log(`[cursor:chat] http://${HOST}:${PORT}`);
    console.log("[cursor:chat] no opens Cursor IDE — keep working elsewhere");
    openDesktopWindow();
  });
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[cursor:chat] port ${PORT} in use — reclaiming if ours…`);
    killPrevious(PORT);
    setTimeout(() => {
      server.listen(PORT, HOST, () => {
        console.log(`[cursor:chat] http://${HOST}:${PORT} (reclaimed)`);
        openDesktopWindow();
      });
      server.on("error", (err2) => {
        console.error(`[cursor:chat] still cannot bind: ${err2.message}`);
        process.exit(1);
      });
    }, 600);
    return;
  }
  console.error(err);
  process.exit(1);
});

startListening();
