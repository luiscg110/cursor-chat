#!/usr/bin/env node
/**
 * Worker process: run one Cursor agent turn out-of-process so the desktop
 * HTTP server event loop stays responsive (health/SSE).
 *
 * Usage:
 *   node scripts/agent-turn-worker.mjs <<EOF
 *   { "text":"...", "agentId":"", "cloud":false, "cwd":"/path", "apiKey":"..." }
 *   EOF
 *
 * Prints one JSON line to stdout: { ok, text, agentId, error?, ... }
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on("error", reject);
  });
}

function loadDotEnv(cwd) {
  const envPath = resolve(cwd, ".env");
  // also parent cursor-chat .env
  for (const p of [envPath, resolve(process.env.CURSOR_CHAT_ROOT || "", ".env")]) {
    if (!p || !existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}

function appendJournal(cwd, entry) {
  try {
    const dir = resolve(cwd, "logs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "agent-turns.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      { flag: "a" }
    );
  } catch {
    // ignore
  }
}

const input = await readStdin();
const cwd = resolve(input.cwd || process.cwd());
loadDotEnv(cwd);
if (input.apiKey) process.env.CURSOR_API_KEY = input.apiKey;

const apiKey = process.env.CURSOR_API_KEY?.trim();
if (!apiKey) {
  console.log(JSON.stringify({ ok: false, error: "Falta CURSOR_API_KEY" }));
  process.exit(2);
}

const text = String(input.text || "").trim();
if (!text) {
  console.log(JSON.stringify({ ok: false, error: "text required" }));
  process.exit(2);
}

const { Agent } = await import("@cursor/sdk");
const modelId = String(input.model || process.env.CURSOR_MODEL || "composer-2.5").trim();
const options = {
  apiKey,
  model: { id: modelId },
  mode: "agent",
  name: "Cursor Chat Turn",
  local: { cwd },
};

let agent;
let agentId = String(input.agentId || "").trim();
try {
  if (agentId) {
    try {
      agent = await Agent.resume(agentId, options);
    } catch {
      agent = await Agent.create(options);
    }
  } else {
    agent = await Agent.create(options);
  }
  agentId = agent.agentId || agentId;

  const run = await agent.send(text, { mode: "agent" });
  let assistant = "";
  if (typeof run.stream === "function") {
    for await (const event of run.stream()) {
      if (event?.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) assistant += block.text;
        }
      }
    }
  }
  const result = await run.wait();
  if (result?.result && !assistant) assistant = String(result.result);
  const failed = result?.status === "error";
  const out = {
    ok: !failed,
    agentId,
    model: modelId,
    text: assistant,
    status: result?.status || "finished",
    error: failed
      ? result?.error?.message || result?.error || "run error"
      : undefined,
  };
  appendJournal(cwd, {
    agentId,
    promptChars: text.length,
    replyChars: assistant.length,
    status: out.status,
  });
  console.log(JSON.stringify(out));
} catch (err) {
  console.log(
    JSON.stringify({
      ok: false,
      agentId,
      error: err?.message || String(err),
    })
  );
  process.exitCode = 1;
} finally {
  try {
    if (agent?.[Symbol.asyncDispose]) await agent[Symbol.asyncDispose]();
    else if (typeof agent?.close === "function") await agent.close();
  } catch {
    // ignore
  }
}
