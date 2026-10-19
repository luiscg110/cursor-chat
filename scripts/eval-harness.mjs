#!/usr/bin/env node
/**
 * Eval harness — smoke + optional live agent checks.
 * Writes results to logs/continuous/eval-latest.json
 *
 *   npm run eval
 *   npm run eval -- --live          # quick agent round-trip (needs CURSOR_API_KEY + idle server)
 *   npm run eval -- --base http://127.0.0.1:3860
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadRecentMetrics } from "./run-metrics.mjs";
import { parsePlaybookBullets, syncDiscoveriesFromPlaybook } from "./discoveries-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outPath = resolve(root, "logs/continuous/eval-latest.json");

function parseArgs(argv) {
  const out = { base: `http://127.0.0.1:${Number(process.env.CURSOR_CHAT_UI_PORT || 3860)}`, live: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--live") out.live = true;
    else if (a === "--base" && n) {
      out.base = n.replace(/\/$/, "");
      i += 1;
    }
  }
  return out;
}

function check(name, fn) {
  const started = Date.now();
  try {
    const detail = fn();
    return { name, ok: true, ms: Date.now() - started, detail };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - started, error: err?.message || String(err) };
  }
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function sseHello(base, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunk = buf.split("\n\n")[0];
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) {
        const msg = JSON.parse(line.slice(6));
        if (msg.type === "hello") {
          controller.abort();
          return msg;
        }
      }
    }
    throw new Error("SSE ended before hello");
  } finally {
    clearTimeout(timer);
  }
}

async function liveAgentEval(base) {
  const health = await fetchJson(`${base}/api/health`);
  if (health?.current?.status === "running") {
    return { skipped: true, reason: "agent busy — retry when idle" };
  }

  const prompt = "Responde solo con la palabra EVAL_OK (sin herramientas).";
  const t0 = Date.now();
  const res = await fetch(`${base}/api/cursor-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: prompt }),
  });
  const started = await res.json();
  if (!res.ok || !started.ok) {
    throw new Error(started.error || `HTTP ${res.status}`);
  }

  const chatId = started.chatId;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const snap = await fetchJson(`${base}/api/cursor-chat`);
    const cur = snap.current;
    if (cur?.id === chatId && cur.status !== "running") {
      const assistant = (cur.messages || [])
        .filter((m) => m.role === "assistant" && !m.kind)
        .map((m) => m.text || "")
        .join("");
      const toolCalls = (cur.messages || []).filter((m) => m.kind === "tool").length;
      return {
        ms: Date.now() - t0,
        status: cur.status,
        toolCalls,
        containsEvalOk: /EVAL_OK/i.test(assistant),
        preview: assistant.replace(/\s+/g, " ").slice(0, 120),
      };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("live agent eval timeout (120s)");
}

/**
 * @param {{ base?: string, live?: boolean, write?: boolean }} opts
 */
export async function runEval(opts = {}) {
  const base = (opts.base || `http://127.0.0.1:${Number(process.env.CURSOR_CHAT_UI_PORT || 3860)}`).replace(
    /\/$/,
    ""
  );
  const live = Boolean(opts.live);
  const write = opts.write !== false;

  const checks = [];

  checks.push(
    check("repo:package.json", () => {
      const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
      if (!pkg.scripts?.start) throw new Error("missing start script");
      return { name: pkg.name, version: pkg.version };
    })
  );

  checks.push(
    check("repo:playbook scaffold", () => {
      const p = resolve(root, "logs/continuous/playbook.md");
      if (!existsSync(p)) throw new Error("playbook missing");
      return { bytes: readFileSync(p, "utf8").length };
    })
  );

  checks.push(
    check("repo:playbook→discoveries sync", () => {
      const playbookText = readFileSync(resolve(root, "logs/continuous/playbook.md"), "utf8");
      const bullets = parsePlaybookBullets(playbookText);
      if (!bullets.length) return { bullets: 0, note: "playbook empty" };
      const synced = syncDiscoveriesFromPlaybook();
      if (!synced.total) throw new Error("sync produced no discoveries");
      return { bullets: bullets.length, discoveries: synced.total };
    })
  );

  checks.push(
    check("repo:sdk dependency", () => {
      const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
      if (!pkg.dependencies?.["@cursor/sdk"]) throw new Error("@cursor/sdk missing");
      return { version: pkg.dependencies["@cursor/sdk"] };
    })
  );

  let serverUp = false;
  try {
    const health = await fetchJson(`${base}/api/health`);
    serverUp = Boolean(health.ok);
    checks.push({
      name: "api:health",
      ok: true,
      ms: 0,
      detail: { port: health.port, chats: health.chats?.length || 0, running: health.current?.status },
    });
  } catch (err) {
    checks.push({ name: "api:health", ok: false, ms: 0, error: err.message });
  }

  if (serverUp) {
    checks.push(
      await (async () => {
        const t0 = Date.now();
        try {
          const metrics = await fetchJson(`${base}/api/metrics`);
          return {
            name: "api:metrics",
            ok: true,
            ms: Date.now() - t0,
            detail: {
              runs: metrics.recent?.length || 0,
              lastDurationMs: metrics.latest?.durationMs,
            },
          };
        } catch (err) {
          return { name: "api:metrics", ok: false, ms: Date.now() - t0, error: err.message };
        }
      })()
    );

    checks.push(
      await (async () => {
        const t0 = Date.now();
        try {
          const cont = await fetchJson(`${base}/api/continuous`);
          return {
            name: "api:continuous",
            ok: true,
            ms: Date.now() - t0,
            detail: { running: cont.running, phase: cont.phase, cycle: cont.cycle },
          };
        } catch (err) {
          return { name: "api:continuous", ok: false, ms: Date.now() - t0, error: err.message };
        }
      })()
    );

    checks.push(
      await (async () => {
        const t0 = Date.now();
        try {
          const hello = await sseHello(base);
          return {
            name: "api:sse",
            ok: true,
            ms: Date.now() - t0,
            detail: { hasCursorChat: Boolean(hello.cursorChat), hasContinuous: Boolean(hello.continuous) },
          };
        } catch (err) {
          return { name: "api:sse", ok: false, ms: Date.now() - t0, error: err.message };
        }
      })()
    );
  }

  if (live && serverUp) {
    checks.push(
      await (async () => {
        const t0 = Date.now();
        try {
          const detail = await liveAgentEval(base);
          if (detail.skipped) {
            return { name: "agent:live", ok: true, ms: Date.now() - t0, detail, skipped: true };
          }
          return {
            name: "agent:live",
            ok: detail.containsEvalOk || detail.status === "idle",
            ms: Date.now() - t0,
            detail,
          };
        } catch (err) {
          return { name: "agent:live", ok: false, ms: Date.now() - t0, error: err.message };
        }
      })()
    );
  }

  const recentMetrics = loadRecentMetrics(10);
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).length;
  const report = {
    at: new Date().toISOString(),
    base,
    live,
    summary: { total: checks.length, passed, failed },
    checks,
    recentMetrics: recentMetrics.slice(-5),
  };

  if (write) {
    mkdirSync(resolve(root, "logs/continuous"), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  }

  return report;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage:
  npm run eval
  npm run eval -- --live
  npm run eval -- --base http://127.0.0.1:3860`);
    return;
  }

  const report = await runEval(opts);
  for (const c of report.checks) {
    const mark = c.ok ? "✓" : "✗";
    const extra = c.error ? ` — ${c.error}` : c.detail ? ` — ${JSON.stringify(c.detail)}` : "";
    console.log(`${mark} ${c.name}${extra}`);
  }
  console.log(`\n${report.summary.passed}/${report.summary.total} passed → ${outPath}`);

  if (report.summary.failed > 0) process.exit(1);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
