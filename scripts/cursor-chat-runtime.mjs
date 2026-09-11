/**
 * In-app Cursor chat via the SDK. Does not open or focus the Cursor IDE.
 * Cloud runs also appear later in Cursor Agents (Filter → Source → SDK).
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";

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
    // Normalize to https://github.com/owner/repo (no .git) for cloud agents.
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
  // Prefer commit SHA — cloud branch verification can fail even when main exists.
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
    messages: chat.messages.map((m) => ({
      role: m.role,
      text: m.text,
      kind: m.kind || undefined,
      tool: m.tool || undefined,
    })),
  };
}

export function createCursorChatRuntime({ root, broadcast, notify }) {
  loadDotEnv(root);

  /** @type {Map<string, any>} */
  const chats = new Map();
  let seq = 0;

  function snapshot() {
    const list = [...chats.values()];
    const active = list.find((c) => c.status === "running") || list[list.length - 1] || null;
    return {
      chats: list.map(publicChat),
      current: active ? publicChat(active) : null,
    };
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
    try {
      if (chat.agent?.[Symbol.asyncDispose]) await chat.agent[Symbol.asyncDispose]();
      else if (typeof chat.agent?.close === "function") await chat.agent.close();
    } catch {
      // ignore
    }
    chats.delete(chat.id);
  }

  async function newChat() {
    const existing = [...chats.values()];
    for (const chat of existing) {
      await disposeChat(chat);
    }
    const payload = { type: "cursor_chat", kind: "reset", ...snapshot() };
    broadcast(payload);
    return { ok: true, ...snapshot() };
  }

  async function ensureChat({ chatId, cloud, model }) {
    if (chatId && chats.has(chatId)) return chats.get(chatId);

    const apiKey = process.env.CURSOR_API_KEY?.trim();
    if (!apiKey) {
      throw new Error(
        "Falta CURSOR_API_KEY en .env — créala en https://cursor.com/dashboard/integrations"
      );
    }

    const { Agent } = await import("@cursor/sdk");
    const modelId = String(model || process.env.CURSOR_MODEL || "composer-2.5").trim();
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
      options.local = { cwd: root };
    }

    const agent = await Agent.create(options);
    seq += 1;
    const chat = {
      id: `c${seq}-${randomUUID().slice(0, 6)}`,
      agent,
      agentId: agent.agentId || "",
      cloud: useCloud,
      model: modelId,
      status: "idle",
      messages: [],
      run: null,
    };
    chats.set(chat.id, chat);
    return chat;
  }

  async function send({ chatId, text, cloud, model, awaitDone = false }) {
    const prompt = String(text || "").trim();
    if (!prompt) return { ok: false, error: "text is required" };

    const busy = [...chats.values()].find((c) => c.status === "running");
    if (busy && busy.id !== chatId) {
      return { ok: false, error: "ya hay un chat Cursor corriendo" };
    }

    const chat = await ensureChat({ chatId, cloud, model });
    if (chat.status === "running") {
      return { ok: false, error: "espera a que termine la respuesta" };
    }

    chat.status = "running";
    chat.messages.push({ role: "user", text: prompt });
    chat.messages.push({ role: "assistant", text: "" });
    broadcast({
      type: "cursor_chat",
      kind: "user",
      chatId: chat.id,
      agentId: chat.agentId,
      cloud: chat.cloud,
      text: prompt,
      current: publicChat(chat),
    });

    const runLoop = async () => {
      try {
        const run = await chat.agent.send(prompt, { mode: "agent" });
        chat.run = run;
        chat.agentId = chat.agent.agentId || chat.agentId;
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
              pushActivity(
                "thinking",
                event.text.length > 280 ? `${event.text.slice(0, 280)}…` : event.text
              );
            } else if (event?.type === "tool_call") {
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
    broadcast({
      type: "cursor_chat",
      kind: "stopped",
      chatId: chat.id,
      current: publicChat(chat),
    });
    return { ok: true, chatId: chat.id, current: publicChat(chat) };
  }

  return { send, stop, newChat, snapshot };
}
