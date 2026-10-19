/**
 * In-app Cursor chat via the SDK. Does not open or focus the Cursor IDE.
 * Cloud runs also appear later in Cursor Agents (Filter → Source → SDK).
 *
 * Idle design: hydrate UI from disk without Agent.resume; attach the SDK
 * agent only for an active send(); release it when the run finishes.
 */
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import { appendRunMetric, saveLatestSummary } from "./run-metrics.mjs";
import {
  loadChatSession,
  saveChatSession,
  clearChatSession,
} from "./discoveries-store.mjs";
import { desktopLog } from "./desktop-log.mjs";

const __runtimeDir = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(__runtimeDir, "agent-turn-worker.mjs");

function loadDotEnv(root) {
  const envPath = resolve(root, ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function githubOrigin(root) {
  try {
    let url = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
      encoding: "utf8",
    }).trim();
    const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
    if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`;
    const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
    if (https) return `https://github.com/${https[1]}/${https[2]}`;
    return url.replace(/\.git$/i, "");
  } catch {
    return "";
  }
}

function githubStartingRef(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    try {
      return execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
      }).trim();
    } catch {
      return "main";
    }
  }
}

function publicChat(chat) {
  return {
    id: chat.id,
    agentId: chat.agentId || "",
    cloud: Boolean(chat.cloud),
    model: chat.model,
    status: chat.status,
    messages: (chat.messages || []).map((m) => ({
      role: m.role,
      text: m.text,
      kind: m.kind || undefined,
      tool: m.tool || undefined,
    })),
  };
}

/** Lightweight snapshot for health / hello — no message bodies. */
function publicChatMeta(chat) {
  return {
    id: chat.id,
    agentId: chat.agentId || "",
    cloud: Boolean(chat.cloud),
    model: chat.model,
    status: chat.status,
    messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
    hasAgent: Boolean(chat.agent),
  };
}

function persistChat(chat) {
  if (!chat) return;
  saveChatSession({
    chatId: chat.id,
    agentId: chat.agentId,
    cloud: chat.cloud,
    model: chat.model,
    messages: chat.messages,
  });
}

function agentCwd(root) {
  return (
    process.env.CURSOR_AGENT_CWD?.trim() ||
    process.env.CURSOR_CHAT_AGENT_CWD?.trim() ||
    root
  );
}

function runTurnInWorker({ root, text, agentId, model, cloud }) {
  return new Promise((resolvePromise) => {
    const payload = {
      text,
      agentId: agentId || "",
      model: model || "",
      cloud: Boolean(cloud),
      cwd: agentCwd(root),
      apiKey: process.env.CURSOR_API_KEY || "",
    };
    desktopLog("worker_spawn", {
      agentId: payload.agentId || null,
      cwd: payload.cwd,
      textChars: String(text || "").length,
    });
    const started = Date.now();
    const child = spawn(process.execPath, [WORKER], {
      cwd: root,
      env: {
        ...process.env,
        CURSOR_CHAT_ROOT: root,
        CURSOR_AGENT_CWD: payload.cwd,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.stderr.on("data", (c) => {
      err += c;
    });
    child.on("close", (code) => {
      const line = out.trim().split("\n").filter(Boolean).pop() || "";
      try {
        const parsed = JSON.parse(line);
        desktopLog("worker_exit", {
          code,
          ok: Boolean(parsed?.ok),
          ms: Date.now() - started,
          error: parsed?.ok ? undefined : String(parsed?.error || "").slice(0, 200),
        });
        resolvePromise(parsed);
      } catch {
        desktopLog("worker_exit", {
          code,
          ok: false,
          ms: Date.now() - started,
          error: (err.trim() || line || `worker exit ${code}`).slice(0, 200),
        });
        resolvePromise({
          ok: false,
          error:
            err.trim().slice(0, 400) ||
            line.slice(0, 400) ||
            `worker exit ${code}`,
        });
      }
    });
    child.on("error", (e) => {
      desktopLog("worker_error", { error: e.message });
      resolvePromise({ ok: false, error: e.message });
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export function createCursorChatRuntime({ root, broadcast, notify }) {
  loadDotEnv(root);

  /** @type {Map<string, any>} */
  const chats = new Map();
  let seq = 0;
  /** Serialize agent attach so resume/create cannot overlap. */
  let attachChain = Promise.resolve();

  function snapshot() {
    const list = [...chats.values()];
    const active = list.find((c) => c.status === "running") || list[list.length - 1] || null;
    return {
      chats: list.map(publicChat),
      current: active ? publicChat(active) : null,
    };
  }

  function lightSnapshot() {
    const list = [...chats.values()];
    const active = list.find((c) => c.status === "running") || list[list.length - 1] || null;
    return {
      chats: list.map(publicChatMeta),
      current: active ? publicChatMeta(active) : null,
    };
  }

  async function releaseAgent(chat) {
    if (!chat?.agent) return;
    const agent = chat.agent;
    chat.agent = null;
    try {
      if (agent?.[Symbol.asyncDispose]) await agent[Symbol.asyncDispose]();
      else if (typeof agent?.close === "function") await agent.close();
    } catch {
      // ignore
    }
  }

  async function disposeChat(chat) {
    if (!chat) return;
    try {
      if (chat.run && typeof chat.run.supports === "function" && chat.run.supports("cancel")) {
        await chat.run.cancel();
      }
    } catch {
      // ignore
    }
    await releaseAgent(chat);
    chats.delete(chat.id);
  }

  async function newChat() {
    const existing = [...chats.values()];
    for (const chat of existing) {
      await disposeChat(chat);
    }
    clearChatSession();
    const payload = { type: "cursor_chat", kind: "reset", ...snapshot() };
    broadcast(payload);
    return { ok: true, ...snapshot() };
  }

  function agentOptions({ cloud, modelId, apiKey }) {
    const options = {
      apiKey,
      model: { id: modelId },
      mode: "agent",
      name: "Cursor Chat",
    };
    const useCloud = Boolean(cloud);
    if (useCloud) {
      const repo = githubOrigin(root);
      options.cloud = repo
        ? { repos: [{ url: repo, startingRef: githubStartingRef(root) }] }
        : { repos: [] };
    } else {
      const agentCwd =
        process.env.CURSOR_AGENT_CWD?.trim() ||
        process.env.CURSOR_CHAT_AGENT_CWD?.trim() ||
        root;
      options.local = { cwd: agentCwd };
    }
    return { options, useCloud };
  }

  function findChat({ chatId, agentId }) {
    if (chatId && chats.has(chatId)) return chats.get(chatId);
    if (agentId) {
      return [...chats.values()].find((c) => c.agentId === agentId) || null;
    }
    return null;
  }

  function makeStubChat({ id, agentId, cloud, model, messages }) {
    seq += 1;
    const chat = {
      id: id || `c${seq}-${randomUUID().slice(0, 6)}`,
      agent: null,
      agentId: agentId || "",
      cloud: Boolean(cloud),
      model: model || String(process.env.CURSOR_MODEL || "composer-2.5").trim(),
      status: "idle",
      messages: Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [],
      run: null,
      resumed: Boolean(agentId),
    };
    chats.set(chat.id, chat);
    return chat;
  }

  /**
   * UI-only restore: load messages from disk, do NOT call Agent.resume.
   * Keeps idle CPU near zero after app reopen / macOS window restore.
   */
  function hydrateUiFromDisk() {
    const session = loadChatSession();
    if (!session?.agentId && !session?.chatId) {
      return { ok: false, ...snapshot() };
    }
    let chat = findChat({
      chatId: session.chatId || "",
      agentId: session.agentId || "",
    });
    if (!chat) {
      chat = makeStubChat({
        id: session.chatId || "",
        agentId: session.agentId || "",
        cloud: session.cloud,
        model: session.model,
        messages: session.messages || [],
      });
    } else if (!chat.messages?.length && session.messages?.length) {
      chat.messages = session.messages.map((m) => ({ ...m }));
    }
    broadcast({
      type: "cursor_chat",
      kind: "restored",
      chatId: chat.id,
      agentId: chat.agentId,
      current: publicChat(chat),
    });
    return { ok: true, ...snapshot() };
  }

  async function attachAgent(chat, { cloud, model } = {}) {
    if (chat.agent) return chat;
    const work = attachChain.then(async () => {
      if (chat.agent) return chat;

      const apiKey = process.env.CURSOR_API_KEY?.trim();
      if (!apiKey) {
        throw new Error(
          "Falta CURSOR_API_KEY en .env — créala en https://cursor.com/dashboard/integrations"
        );
      }

      const { Agent } = await import("@cursor/sdk");
      const modelId = String(
        model || chat.model || process.env.CURSOR_MODEL || "composer-2.5"
      ).trim();
      chat.model = modelId;
      if (cloud !== undefined) chat.cloud = Boolean(cloud);

      const { options, useCloud } = agentOptions({
        cloud: chat.cloud,
        modelId,
        apiKey,
      });
      chat.cloud = useCloud;

      const resumeId = String(chat.agentId || "").trim();
      let agent;
      if (resumeId) {
        try {
          agent = await Agent.resume(resumeId, options);
          chat.resumed = true;
        } catch (err) {
          console.warn(
            "[cursor-chat] Agent.resume failed, creating new:",
            err?.message || err
          );
          agent = await Agent.create(options);
          chat.resumed = false;
        }
      } else {
        agent = await Agent.create(options);
        chat.resumed = false;
      }

      chat.agent = agent;
      chat.agentId = agent.agentId || resumeId || chat.agentId;
      persistChat(chat);
      return chat;
    });
    attachChain = work.catch(() => {});
    return work;
  }

  async function ensureChat({ chatId, agentId, cloud, model }) {
    let chat = findChat({ chatId, agentId });
    if (!chat) {
      const session = loadChatSession();
      const resumeId = String(agentId || session?.agentId || "").trim();
      const keepId =
        (chatId && String(chatId)) ||
        (resumeId && session?.chatId) ||
        "";
      chat = makeStubChat({
        id: keepId,
        agentId: resumeId,
        cloud: cloud ?? session?.cloud,
        model: model || session?.model,
        messages:
          resumeId && session?.agentId === resumeId ? session.messages || [] : [],
      });
    }
    await attachAgent(chat, { cloud, model });
    return chat;
  }

  /** @deprecated alias — kept for desktop boot path */
  async function restoreSession() {
    return hydrateUiFromDisk();
  }

  async function send({ chatId, agentId, text, cloud, model, awaitDone = false }) {
    const prompt = String(text || "").trim();
    if (!prompt) return { ok: false, error: "text is required" };

    const busy = [...chats.values()].find((c) => c.status === "running");
    if (busy && busy.id !== chatId && (!agentId || busy.agentId !== agentId)) {
      return { ok: false, error: "ya hay un chat Cursor corriendo" };
    }

    const session = loadChatSession();
    // Continuous / awaitDone: run SDK in a child process so /api/health stays hot
    const useWorker =
      awaitDone && process.env.CURSOR_CHAT_INLINE_AGENT !== "1";

    let chat = findChat({
      chatId: chatId || session?.chatId || "",
      agentId: agentId || session?.agentId || "",
    });
    if (!chat) {
      chat = makeStubChat({
        id: chatId || session?.chatId || "",
        agentId: agentId || session?.agentId || "",
        cloud: cloud ?? session?.cloud,
        model: model || session?.model,
        messages:
          session?.messages && (agentId || session?.agentId)
            ? session.messages
            : [],
      });
    }
    if (chat.status === "running") {
      return { ok: false, error: "espera a que termine la respuesta" };
    }

    chat.status = "running";
    chat.messages.push({ role: "user", text: prompt });
    chat.messages.push({ role: "assistant", text: "" });
    persistChat(chat);
    broadcast({
      type: "cursor_chat",
      kind: "user",
      chatId: chat.id,
      agentId: chat.agentId,
      cloud: chat.cloud,
      text: prompt,
      current: publicChat(chat),
    });

    if (useWorker) {
      const runStartedAt = Date.now();
      broadcast({
        type: "cursor_chat",
        kind: "status",
        chatId: chat.id,
        text: "agente en proceso aparte (server sigue vivo)…",
      });
      const done = await runTurnInWorker({
        root,
        text: prompt,
        agentId: chat.agentId || agentId || session?.agentId || "",
        model: model || chat.model,
        cloud: cloud ?? chat.cloud,
      });
      const bubble = chat.messages[chat.messages.length - 1];
      if (bubble?.role === "assistant") {
        bubble.text = done.text || (done.error ? `Error: ${done.error}` : "");
      }
      if (done.agentId) chat.agentId = done.agentId;
      chat.status = done.ok ? "idle" : "error";
      chat.run = null;
      persistChat(chat);
      const metric = appendRunMetric({
        chatId: chat.id,
        agentId: chat.agentId,
        cloud: chat.cloud,
        model: chat.model,
        promptChars: prompt.length,
        replyChars: (bubble?.text || "").length,
        durationMs: Date.now() - runStartedAt,
        status: done.ok ? done.status || "finished" : "error",
        error: done.error,
        worker: true,
      });
      saveLatestSummary(metric);
      broadcast({
        type: "cursor_chat",
        kind: done.ok ? "done" : "error",
        chatId: chat.id,
        agentId: chat.agentId,
        text: bubble?.text,
        error: done.error,
        current: publicChat(chat),
      });
      notify(
        done.ok ? "Cursor chat listo" : "Cursor chat error",
        (bubble?.text || done.error || "").replace(/\s+/g, " ").slice(0, 160)
      );
      return {
        ok: Boolean(done.ok),
        chatId: chat.id,
        agentId: chat.agentId,
        cloud: chat.cloud,
        model: chat.model,
        current: publicChat(chat),
        text: bubble?.text || "",
        runStatus: done.status,
        error: done.error,
      };
    }

    const chatReady = await ensureChat({
      chatId: chat.id,
      agentId: chat.agentId,
      cloud: cloud ?? chat.cloud,
      model: model || chat.model,
    });
    // ensureChat may return same stub with agent attached
    Object.assign(chat, chatReady);

    const runLoop = async () => {
      const runStartedAt = Date.now();
      const counters = { toolCalls: 0, thinking: 0, tasks: 0, deltas: 0 };
      try {
        const run = await chat.agent.send(prompt, { mode: "agent" });
        chat.run = run;
        chat.agentId = chat.agent.agentId || chat.agentId;
        persistChat(chat);
        broadcast({
          type: "cursor_chat",
          kind: "started",
          chatId: chat.id,
          agentId: chat.agentId,
          cloud: chat.cloud,
          current: publicChat(chat),
        });

        let assistant = "";
        const lastMsg = () => chat.messages[chat.messages.length - 1];
        const ensureAssistantBubble = () => {
          const last = lastMsg();
          if (last?.role === "assistant" && !last.kind) return last;
          assistant = "";
          const msg = { role: "assistant", text: "" };
          chat.messages.push(msg);
          return msg;
        };
        const pushActivity = (kind, text, extra = {}) => {
          chat.messages.push({
            role: "assistant",
            kind,
            text,
            ...extra,
          });
          broadcast({
            type: "cursor_chat",
            kind,
            chatId: chat.id,
            text,
            ...extra,
            current: publicChat(chat),
          });
        };

        if (typeof run.stream === "function") {
          for await (const event of run.stream()) {
            if (event?.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === "text" && block.text) {
                  assistant += block.text;
                  counters.deltas += 1;
                  const bubble = ensureAssistantBubble();
                  bubble.text = assistant;
                  broadcast({
                    type: "cursor_chat",
                    kind: "delta",
                    chatId: chat.id,
                    text: block.text,
                  });
                }
              }
            } else if (event?.type === "thinking" && event.text) {
              counters.thinking += 1;
              pushActivity(
                "thinking",
                event.text.length > 280 ? `${event.text.slice(0, 280)}…` : event.text
              );
            } else if (event?.type === "tool_call") {
              counters.toolCalls += 1;
              const name = event.name || "tool";
              const st = event.status || "running";
              const label =
                st === "completed"
                  ? `✓ ${name}`
                  : st === "error"
                    ? `✗ ${name}`
                    : `… ${name}`;
              pushActivity("tool", label, {
                tool: { name, status: st, callId: event.call_id },
              });
            } else if (event?.type === "task" && (event.text || event.status)) {
              counters.tasks += 1;
              pushActivity(
                "task",
                event.text || `task ${event.status || ""}`.trim()
              );
            } else if (event?.type === "status" && event.message) {
              broadcast({
                type: "cursor_chat",
                kind: "status",
                chatId: chat.id,
                text: event.message,
                status: event.status,
              });
            } else if (event?.type === "status" && event.status === "ERROR") {
              const msg =
                event.message ||
                event.error?.message ||
                (typeof event.error === "string" ? event.error : "") ||
                "Cursor run error";
              const bubble = ensureAssistantBubble();
              if (!bubble.text) bubble.text = `Error: ${msg}`;
            }
          }
        }

        const result = await run.wait();
        if (result?.status && result.status !== "finished") {
          console.error(
            "[cursor-chat] wait",
            result.status,
            result.error?.message || result.error || result.result || ""
          );
        }
        if (result?.result && !assistant) {
          assistant = String(result.result);
          ensureAssistantBubble().text = assistant;
        }
        const failed = result?.status === "error";
        const bubble = ensureAssistantBubble();
        if (failed && !bubble.text) {
          const errText =
            result?.error?.message ||
            result?.error?.code ||
            result?.result ||
            "El run de Cursor terminó con error";
          bubble.text = `Error: ${errText}`;
        }
        chat.status = failed ? "error" : "idle";
        chat.run = null;
        persistChat(chat);
        // Drop heavy SDK agent while idle — next send() will Agent.resume
        await releaseAgent(chat);
        const metric = appendRunMetric({
          chatId: chat.id,
          agentId: chat.agentId,
          cloud: chat.cloud,
          model: chat.model,
          promptChars: prompt.length,
          replyChars: (bubble.text || "").length,
          durationMs: Date.now() - runStartedAt,
          status: failed ? "error" : result?.status || "finished",
          ...counters,
        });
        saveLatestSummary(metric);
        broadcast({
          type: "cursor_chat",
          kind: failed ? "error" : "done",
          chatId: chat.id,
          agentId: chat.agentId,
          status: result?.status || "finished",
          text: bubble.text,
          error: failed ? result?.error?.message || bubble.text : undefined,
          current: publicChat(chat),
        });
        notify(
          failed ? "Cursor chat error" : "Cursor chat listo",
          (bubble.text || result?.status || "terminó")
            .replace(/\s+/g, " ")
            .slice(0, 160)
        );
        return {
          ok: !failed,
          status: result?.status || "finished",
          text: bubble.text,
        };
      } catch (err) {
        chat.status = "error";
        chat.run = null;
        const message = err?.message || String(err);
        persistChat(chat);
        await releaseAgent(chat);
        const metric = appendRunMetric({
          chatId: chat.id,
          agentId: chat.agentId,
          cloud: chat.cloud,
          model: chat.model,
          promptChars: prompt.length,
          durationMs: Date.now() - runStartedAt,
          status: "error",
          error: message.slice(0, 300),
          ...counters,
        });
        saveLatestSummary(metric);
        console.error("[cursor-chat]", message);
        const last = chat.messages[chat.messages.length - 1];
        if (last?.role === "assistant" && !last.text) {
          last.text = `Error: ${message}`;
        }
        broadcast({
          type: "cursor_chat",
          kind: "error",
          chatId: chat.id,
          error: message,
          current: publicChat(chat),
        });
        notify("Cursor chat error", message.slice(0, 160));
        return { ok: false, error: message, text: last?.text || "" };
      }
    };

    const finished = runLoop();
    chat.lastRunPromise = finished;
    if (awaitDone) {
      const done = await finished;
      return {
        ok: done?.ok !== false,
        chatId: chat.id,
        agentId: chat.agentId,
        cloud: chat.cloud,
        model: chat.model,
        current: publicChat(chat),
        text: done?.text || "",
        runStatus: done?.status,
        error: done?.error,
      };
    }

    return {
      ok: true,
      chatId: chat.id,
      agentId: chat.agentId,
      cloud: chat.cloud,
      model: chat.model,
      current: publicChat(chat),
      done: finished,
    };
  }

  async function stop({ chatId } = {}) {
    const chat =
      (chatId && chats.get(chatId)) ||
      [...chats.values()].find((c) => c.status === "running");
    if (!chat) return { ok: false, error: "no hay chat Cursor corriendo" };
    try {
      if (chat.run && typeof chat.run.supports === "function" && chat.run.supports("cancel")) {
        await chat.run.cancel();
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
    chat.status = "idle";
    chat.run = null;
    persistChat(chat);
    await releaseAgent(chat);
    broadcast({
      type: "cursor_chat",
      kind: "stopped",
      chatId: chat.id,
      current: publicChat(chat),
    });
    return { ok: true, chatId: chat.id, current: publicChat(chat) };
  }

  return {
    send,
    stop,
    newChat,
    snapshot,
    lightSnapshot,
    restoreSession,
    hydrateUiFromDisk,
  };
}
