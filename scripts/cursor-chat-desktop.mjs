#!/usr/bin/env node
/**
 * Cursor Chat — standalone desktop app.
 * Talks to Cursor via SDK without opening or focusing the Cursor IDE.
 *
 * Idle: no Agent.resume/create until the first send().
 * Single-instance: if :3860 already healthy, exit 0 (no port fight).
 *
 *   npm start
 *   npm run app
 *
 * Opens http://127.0.0.1:3860
 */
import { createServer } from "http";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "fs";
import { resolve, dirname, join, extname } from "path";
import { fileURLToPath } from "url";
import { spawn, execFileSync } from "child_process";
import { createCursorChatRuntime } from "./cursor-chat-runtime.mjs";
import { createContinuousLoop } from "./continuous-loop.mjs";
import { continuousPaths, loadDiscoveries } from "./discoveries-store.mjs";
import { loadRecentMetrics, metricsPaths } from "./run-metrics.mjs";
import { desktopLog, desktopLogPath, markContinuousInterrupted } from "./desktop-log.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const uiDir = resolve(__dirname, "cursor-chat-ui");
const PORT = Number(process.env.CURSOR_CHAT_UI_PORT || 3860);
const HOST = "127.0.0.1";
const PID_PATH = resolve(root, "logs/continuous/desktop.pid");

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
  if (!sseClients.size) return;
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

function writePid() {
  try {
    mkdirSync(dirname(PID_PATH), { recursive: true });
    writeFileSync(PID_PATH, String(process.pid), "utf8");
  } catch {
    // ignore
  }
}

function clearPid() {
  try {
    if (existsSync(PID_PATH)) {
      const raw = readFileSync(PID_PATH, "utf8").trim();
      if (raw === String(process.pid)) unlinkSync(PID_PATH);
    }
  } catch {
    // ignore
  }
}

async function probeLocalHealthHttp(timeoutMs = 400) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`http://${HOST}:${PORT}/api/health`, {
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
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

// NOTE: hydrate + maybeResume run AFTER listen succeeds (see boot()).

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

function continuousRunningOnDisk() {
  try {
    const p = resolve(root, "logs/continuous/state.json");
    if (!existsSync(p)) return false;
    const s = JSON.parse(readFileSync(p, "utf8") || "null");
    if (!s?.running) return false;
    if (s.endsAt && Date.parse(s.endsAt) <= Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

/** True only if continuous claims running AND our desktop pid is still alive. */
function continuousProcessAlive() {
  if (!continuousRunningOnDisk()) return false;
  try {
    if (!existsSync(PID_PATH)) return false;
    const pid = Number(readFileSync(PID_PATH, "utf8").trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPrevious(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    }).trim();
    if (!out) return false;
    if (continuousRunningOnDisk()) {
      // Only block hard-kill when the owning pid is still alive.
      try {
        const alive = out
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .some((pid) => {
            try {
              const cmd = execFileSync("ps", ["-p", pid, "-o", "command="], {
                encoding: "utf8",
              });
              return /cursor-chat-desktop\.mjs/.test(cmd);
            } catch {
              return false;
            }
          });
        if (alive) {
          desktopLog("kill_previous_blocked", {
            reason: "continuous_running",
            pids: out.split("\n").map((s) => s.trim()).filter(Boolean),
          });
          console.log(
            "[cursor:chat] continuous 24h activo — no mato el proceso existente (reusa :3860)"
          );
          return false;
        }
      } catch {
        // fall through to kill
      }
    }
    let killed = false;
    for (const pid of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (Number(pid) === process.pid) continue;
      try {
        const cmd = execFileSync("ps", ["-p", pid, "-o", "command="], {
          encoding: "utf8",
        });
        if (!/cursor-chat-desktop\.mjs/.test(cmd)) continue;
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {
          // ignore
        }
        try {
          execFileSync("sleep", ["0.8"], { stdio: "ignore" });
        } catch {
          // ignore
        }
        try {
          process.kill(Number(pid), 0);
          execFileSync("kill", ["-9", pid], { stdio: "ignore" });
          markContinuousInterrupted("killed_by_new_instance_SIGKILL");
          desktopLog("kill_previous", {
            victimPid: Number(pid),
            signal: "SIGTERM+KILL",
          });
        } catch {
          desktopLog("kill_previous", {
            victimPid: Number(pid),
            signal: "SIGTERM",
          });
        }
        console.log(`[cursor:chat] killed previous desktop pid=${pid}`);
        killed = true;
      } catch {
        // ignore
      }
    }
    return killed;
  } catch {
    return false;
  }
}

function afterListenReady() {
  writePid();
  desktopLog("listen_ok", {
    port: PORT,
    agentCwd: process.env.CURSOR_AGENT_CWD || null,
    log: desktopLogPath(),
  });
  try {
    cursorChat.hydrateUiFromDisk();
    desktopLog("hydrate_ok");
  } catch (err) {
    console.warn("[cursor:chat] hydrate:", err?.message || err);
    desktopLog("hydrate_err", { error: err?.message || String(err) });
  }
  // Defer continuous resume so HTTP/health stay responsive during bind
  setTimeout(() => {
    try {
      continuous.maybeResume();
      desktopLog("maybe_resume_called", {
        autorestart: process.env.CURSOR_CONTINUOUS_AUTORESTART === "1",
      });
    } catch (err) {
      console.warn("[cursor:chat] maybeResume:", err?.message || err);
      desktopLog("maybe_resume_err", { error: err?.message || String(err) });
    }
  }, 1500);
  openDesktopWindow();
}

const server = createServer((req, res) => {
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

  // Sync + tiny — stays responsive even if a chat run is busy
  if (pathname === "/api/health") {
    const light = cursorChat.lightSnapshot();
    sendJson(res, 200, {
      ok: true,
      port: PORT,
      pid: process.pid,
      clients: sseClients.size,
      app: "cursor-chat",
      continuousRunning: Boolean(continuous.lightStatus()?.running),
      ...light,
    });
    return;
  }

  void (async () => {
    try {
      if (pathname === "/api/cursor-chat" && req.method === "GET") {
        sendJson(res, 200, { ok: true, ...cursorChat.snapshot() });
        return;
      }

      if (pathname === "/api/cursor-chat" && req.method === "POST") {
        const body = await readJson(req);
        if (body.agentCwd) {
          process.env.CURSOR_AGENT_CWD = String(body.agentCwd).trim();
        }
        const result = await cursorChat.send({
          chatId: body.chatId || "",
          agentId: body.agentId || "",
          text: body.text || body.prompt || "",
          cloud: Boolean(body.cloud),
          model: body.model || "",
        });
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (pathname === "/api/cursor-chat/stop" && req.method === "POST") {
        const body = await readJson(req).catch(() => ({}));
        const result = await cursorChat.stop({ chatId: body.chatId || "" });
        sendJson(res, result.ok ? 200 : 409, result);
        return;
      }

      if (pathname === "/api/cursor-chat/new" && req.method === "POST") {
        const result = await cursorChat.newChat();
        sendJson(res, 200, result);
        return;
      }

      if (pathname === "/api/metrics" && req.method === "GET") {
        const { latestPath } = metricsPaths();
        let latest = null;
        if (existsSync(latestPath)) {
          try {
            latest = JSON.parse(readFileSync(latestPath, "utf8"));
          } catch {
            latest = null;
          }
        }
        sendJson(res, 200, {
          ok: true,
          latest,
          recent: loadRecentMetrics(20),
          paths: metricsPaths(),
        });
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
        const body = await readJson(req).catch(() => ({}));
        if (body.agentCwd) {
          process.env.CURSOR_AGENT_CWD = String(body.agentCwd).trim();
          console.log(`[cursor:chat] agent cwd → ${process.env.CURSOR_AGENT_CWD}`);
        }
        const result = await continuous.start({
          hours: body.hours ?? 24,
          pauseMs: body.pauseMs,
          focus: body.focus || "",
          cloud: Boolean(body.cloud),
          chatId: body.chatId || "",
          agentId: body.agentId || "",
          fresh: body.fresh !== false && Boolean(body.agentCwd) ? true : Boolean(body.fresh),
        });
        sendJson(res, result.ok ? 200 : 409, { ...result, agentCwd: process.env.CURSOR_AGENT_CWD || null });
        return;
      }

      if (pathname === "/api/continuous/stop" && req.method === "POST") {
        const result = await continuous.stop("user_stop");
        sendJson(res, 200, result);
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
            continuous: continuous.lightStatus(),
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
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: err?.message || String(err) });
      }
    }
  })();
});

function startListening() {
  server.listen(PORT, HOST, () => {
    console.log(`[cursor:chat] http://${HOST}:${PORT} pid=${process.pid}`);
    console.log("[cursor:chat] idle: no SDK agent until first send");
    afterListenReady();
  });
}

async function boot() {
  // If something is listening, prefer reuse when healthy; else hard-kill ours
  let existing = await probeLocalHealthHttp(350);
  if (existing?.ok && existing?.app === "cursor-chat") {
    console.log(
      `[cursor:chat] already healthy on :${PORT} (pid ${existing.pid || "?"}) — exiting to avoid duplicate`
    );
    process.exit(0);
  }
  // Mid-turn / busy: health may fail briefly while continuous is still alive.
  if (continuousProcessAlive()) {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 400));
      existing = await probeLocalHealthHttp(500);
      if (existing?.ok && existing?.app === "cursor-chat") {
        desktopLog("boot_reuse_continuous", { attempt: i + 1 });
        console.log(
          `[cursor:chat] continuous activo y healthy — reusando :${PORT}`
        );
        process.exit(0);
      }
    }
    desktopLog("boot_continuous_unhealthy", {
      msg: "state.running + pid alive but health failed; not killing",
    });
    console.error(
      `[cursor:chat] continuous 24h marcado running pero :${PORT} no responde. No mato el proceso. Revisa logs/continuous/desktop.log`
    );
    process.exit(1);
  }
  if (continuousRunningOnDisk() && !continuousProcessAlive()) {
    desktopLog("stale_continuous_state", {
      msg: "state.running but desktop pid dead — reclaiming port",
    });
    markContinuousInterrupted("stale_pid_on_boot");
  }
  killPrevious(PORT);

  server.on("error", async (err) => {
    if (err.code === "EADDRINUSE") {
      const health = await probeLocalHealthHttp(500);
      if (health?.ok && health?.app === "cursor-chat") {
        console.log(`[cursor:chat] port ${PORT} already serving cursor-chat — exit 0`);
        process.exit(0);
      }
      console.error(`[cursor:chat] port ${PORT} stuck — reclaiming…`);
      killPrevious(PORT);
      setTimeout(() => {
        server.listen(PORT, HOST, () => {
          console.log(`[cursor:chat] http://${HOST}:${PORT} (reclaimed)`);
          afterListenReady();
        });
        server.on("error", (err2) => {
          console.error(`[cursor:chat] still cannot bind: ${err2.message}`);
          process.exit(1);
        });
      }, 1200);
      return;
    }
    console.error(err);
    process.exit(1);
  });

  startListening();
}

process.on("exit", (code) => {
  desktopLog("exit", { code });
  clearPid();
});
process.on("SIGINT", () => {
  desktopLog("signal", { signal: "SIGINT" });
  markContinuousInterrupted("SIGINT");
  clearPid();
  process.exit(0);
});
process.on("SIGTERM", () => {
  desktopLog("signal", { signal: "SIGTERM" });
  markContinuousInterrupted("SIGTERM");
  clearPid();
  process.exit(0);
});
process.on("uncaughtException", (err) => {
  desktopLog("uncaughtException", {
    error: err?.message || String(err),
    stack: String(err?.stack || "").slice(0, 1500),
  });
  markContinuousInterrupted(`uncaughtException:${err?.message || err}`);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason?.message || String(reason);
  desktopLog("unhandledRejection", {
    error: msg,
    stack: String(reason?.stack || "").slice(0, 1500),
  });
  markContinuousInterrupted(`unhandledRejection:${msg}`);
});

desktopLog("boot", {
  port: PORT,
  agentCwd: process.env.CURSOR_AGENT_CWD || null,
  autorestart: process.env.CURSOR_CONTINUOUS_AUTORESTART === "1",
});

boot().catch((err) => {
  desktopLog("boot_err", { error: err?.message || String(err) });
  console.error(err);
  process.exit(1);
});
