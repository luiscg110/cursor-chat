const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const cloudEl = document.getElementById("cloud");
const sendBtn = document.getElementById("sendBtn");
const newBtn = document.getElementById("newBtn");
const stopBtn = document.getElementById("stopBtn");
const metaEl = document.getElementById("meta");
const focusInput = document.getElementById("focusInput");
const agentCwdInput = document.getElementById("agentCwdInput");
const hoursInput = document.getElementById("hoursInput");
const contStartBtn = document.getElementById("contStartBtn");
const contStopBtn = document.getElementById("contStopBtn");
const contMeta = document.getElementById("contMeta");
const contLivePill = document.getElementById("contLivePill");
const contStats = document.getElementById("contStats");
const contPrompt = document.getElementById("contPrompt");

let chatId = "";
let agentId = "";
let busy = false;
let es = null;
let toolCount = 0;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status ${cls || ""}`;
}

function setBusy(isBusy) {
  busy = Boolean(isBusy);
  sendBtn.disabled = busy;
  stopBtn.disabled = !busy;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function bubbleClass(m, current) {
  if (m.kind === "tool") return "bubble tool";
  if (m.kind === "thinking") return "bubble thinking";
  if (m.kind === "task") return "bubble task";
  const role = m.role === "user" ? "user" : "assistant";
  const extra = current?.status === "error" && role === "assistant" ? " error" : "";
  return `bubble ${role}${extra}`;
}

function renderChat(current) {
  if (!current || !current.messages?.length) {
    chatId = current?.id || "";
    agentId = current?.agentId || agentId;
    messagesEl.innerHTML =
      '<div class="empty" id="empty">Escribe una <b>tarea</b> (ej: “añade un README con setup”). Verás herramientas y pasos, no solo texto.<br />Puedes irte a otra app — te avisamos cuando termine.</div>';
    metaEl.textContent = "";
    setBusy(current?.status === "running");
    return;
  }

  chatId = current.id || chatId;
  agentId = current.agentId || agentId;
  const kept = [...messagesEl.querySelectorAll(".bubble.system")]
    .map((el) => el.outerHTML)
    .join("");
  messagesEl.innerHTML =
    kept +
    current.messages
      .map((m) => {
        const text =
          m.text ||
          (m.role === "assistant" && !m.kind && current.status === "running"
            ? "…"
            : "");
        return `<div class="${bubbleClass(m, current)}">${escapeHtml(text)}</div>`;
      })
      .join("");
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const where = current.cloud
    ? "cloud · también en Cursor Agents"
    : "local · modo agent";
  metaEl.textContent = [
    current.agentId ? `id ${current.agentId}` : "",
    current.model || "",
    where,
    current.status === "running" ? "orquestando…" : current.status || "",
  ]
    .filter(Boolean)
    .join(" · ");

  setBusy(current.status === "running");
  if (current.status === "running") setStatus("orquestando…", "wait");
  else if (current.status === "error") setStatus("error", "bad");
  else setStatus("listo", "ok");
}

function appendDelta(text) {
  if (!text) return;
  const nodes = [...messagesEl.querySelectorAll(".bubble.assistant")];
  let last = nodes[nodes.length - 1];
  if (!last) {
    last = document.createElement("div");
    last.className = "bubble assistant";
    messagesEl.appendChild(last);
  }
  last.textContent += text;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendActivity(kind, text) {
  if (!text) return;
  const el = document.createElement("div");
  el.className = `bubble ${kind}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendSystem(text) {
  if (!text || !messagesEl) return;
  const empty = messagesEl.querySelector(".empty");
  if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = "bubble system";
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderContinuous(st) {
  if (!contMeta) return;
  const running = Boolean(st?.running);
  if (contStartBtn) contStartBtn.disabled = running;
  if (contStopBtn) contStopBtn.disabled = !running;

  const best = st?.discoveries?.best?.length || st?.discoveries?.items?.length || 0;
  const phase = st?.phase || "—";
  const cycle = st?.cycle || 0;

  if (contLivePill) {
    contLivePill.textContent = running
      ? `${phase} · ciclo ${cycle}`
      : st?.lastError
        ? "error"
        : "idle";
  }
  if (contStats) {
    contStats.textContent = [
      `Ciclo ${cycle}`,
      `Fase ${phase}`,
      `Tools ${toolCount}`,
      `Hallazgos ${best}`,
      st?.chatId ? `chat ${st.chatId}` : null,
      st?.agentId ? `agent ${String(st.agentId).slice(0, 12)}…` : null,
      st?.nextTurnAt ? `próximo ${String(st.nextTurnAt).slice(11, 19)}` : null,
      st?.endsAt ? `hasta ${String(st.endsAt).slice(0, 16)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (contPrompt && (st?.lastPrompt || st?.prompt)) {
    contPrompt.textContent = st.lastPrompt || st.prompt;
  } else if (contPrompt && !running) {
    contPrompt.textContent =
      "Esperando turnos… Aquí verás el prompt que se envía y el progreso.";
  }

  if (!st) {
    contMeta.textContent = "Idle — hallazgos en logs/continuous/";
    return;
  }
  contMeta.textContent = running
    ? `EN VIVO · ciclo ${cycle} · ${phase}${st.lastError ? ` · err: ${st.lastError}` : ""}`
    : `OFF · ciclos ${cycle} · hallazgos ${best}${st.lastError ? ` · último error: ${st.lastError}` : ""}`;
}

if (contStartBtn) {
  contStartBtn.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/continuous/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hours: Number(hoursInput?.value) || 24,
          pauseMs: 45000,
          focus:
            (focusInput?.value || "").trim() ||
            "Lo último en programación e IA: construir y probar en este repo",
          cloud: Boolean(cloudEl?.checked),
          chatId: chatId || undefined,
          agentId: agentId || undefined,
          agentCwd: (agentCwdInput?.value || "").trim() || undefined,
          fresh: true,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      toolCount = 0;
      if (j.chatId) chatId = j.chatId;
      if (j.agentId) agentId = j.agentId;
      renderContinuous(j);
      appendSystem(
        j.agentId
          ? "▶ Retomamos el mismo chat — historial + agente persistidos"
          : "▶ Sesión larga arrancada — verás cada prompt, tool y respuesta aquí"
      );
      setStatus("mejora continua ON", "wait");
    } catch (err) {
      contMeta.textContent = err.message;
      setStatus("error", "bad");
    }
  });
}

if (contStopBtn) {
  contStopBtn.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/continuous/stop", { method: "POST" });
      const j = await res.json();
      renderContinuous(j);
      setStatus("mejora continua OFF", "ok");
    } catch (err) {
      contMeta.textContent = err.message;
    }
  });
}

async function refreshContinuous() {
  try {
    const res = await fetch("/api/continuous");
    const j = await res.json();
    if (j?.ok) renderContinuous(j);
  } catch {
    // ignore
  }
}

function formatRunMetric(m) {
  if (!m) return "";
  const secs = m.durationMs != null ? `${(m.durationMs / 1000).toFixed(1)}s` : "?";
  const tools = m.toolCalls != null ? `${m.toolCalls} tools` : "";
  const deltas = m.deltas != null ? `${m.deltas} deltas` : "";
  return [secs, tools, deltas].filter(Boolean).join(" · ");
}

async function refreshMetrics() {
  try {
    const res = await fetch("/api/metrics");
    const j = await res.json();
    if (!j?.ok || !j.latest) return;
    const bit = formatRunMetric(j.latest);
    if (bit) metaEl.textContent = [metaEl.textContent, bit].filter(Boolean).join(" · ");
  } catch {
    // ignore
  }
}

async function send() {
  const text = (inputEl.value || "").trim();
  if (!text || busy) {
    if (!text) inputEl.focus();
    return;
  }
  setBusy(true);
  setStatus("enviando…", "wait");
  try {
    const res = await fetch("/api/cursor-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        chatId: chatId || undefined,
        agentId: agentId || undefined,
        cloud: Boolean(cloudEl.checked),
      }),
    });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
    chatId = j.chatId || chatId;
    agentId = j.agentId || agentId;
    inputEl.value = "";
    if (j.current && !messagesEl.querySelector(".bubble")) {
      renderChat(j.current);
    }
    setStatus("orquestando…", "wait");
  } catch (err) {
    setBusy(false);
    setStatus("error", "bad");
    metaEl.textContent = err.message;
  }
}

sendBtn.addEventListener("click", () => send());
inputEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    send();
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/cursor-chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: chatId || undefined }),
    });
    const j = await res.json();
    if (j.current) renderChat(j.current);
    setStatus(j.ok ? "detenido" : "error", j.ok ? "ok" : "bad");
  } catch (err) {
    setStatus("error", "bad");
    metaEl.textContent = err.message;
  }
});

newBtn.addEventListener("click", async () => {
  try {
    await fetch("/api/cursor-chat/new", { method: "POST" });
    chatId = "";
    agentId = "";
    renderChat(null);
    setStatus("nuevo chat", "ok");
  } catch (err) {
    setStatus("error", "bad");
    metaEl.textContent = err.message;
  }
});

function connect() {
  if (es) es.close();
  es = new EventSource("/api/events");
  es.onopen = () => {
    if (!busy) setStatus("conectado", "ok");
  };
  es.onerror = () => setStatus("reconectando…", "bad");
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      if (msg.cursorChat?.current) renderChat(msg.cursorChat.current);
      if (msg.continuous) renderContinuous(msg.continuous);
      else setStatus("conectado", "ok");
      refreshContinuous();
    } else if (msg.type === "continuous") {
      renderContinuous(msg);
      if (msg.kind === "turn_start") {
        const preview = msg.prompt || msg.promptPreview || "";
        appendSystem(
          `▶ Ciclo ${msg.cycle || "?"} · fase ${msg.phase || "?"}\n${preview}`
        );
        if (contPrompt && preview) contPrompt.textContent = preview;
        setStatus(`ciclo ${msg.cycle} · ${msg.phase}`, "wait");
      } else if (msg.kind === "turn_done") {
        appendSystem(
          `✓ Turno listo → siguiente ${msg.nextPhase || "?"} (ciclo ${msg.nextCycle || "?"})`
        );
      } else if (msg.kind === "paused") {
        appendSystem(`⏸ Pausa hasta ${msg.nextTurnAt || "próximo turno"}`);
      } else if (msg.kind === "turn_error") {
        appendSystem(`✗ Error: ${msg.error || msg.lastError || "?"}`);
      } else if (msg.kind === "finished" || msg.kind === "stopped") {
        appendSystem(`■ Mejora continua ${msg.kind}`);
      }
    } else if (msg.type === "cursor_chat") {
      if (msg.kind === "tool") toolCount += 1;
      if (msg.kind === "delta") appendDelta(msg.text || "");
      else if (msg.kind === "tool" || msg.kind === "thinking" || msg.kind === "task") {
        if (msg.current) renderChat(msg.current);
        else appendActivity(msg.kind, msg.text || "");
        if (contStats) {
          // refresh tool count display without full continuous fetch
          const t = contStats.textContent || "";
          contStats.textContent = t.replace(/Tools \d+/, `Tools ${toolCount}`);
        }
      } else if (msg.current) renderChat(msg.current);
      if (msg.kind === "error") {
        setBusy(false);
        setStatus("error", "bad");
        if (msg.error) metaEl.textContent = msg.error;
      } else if (msg.kind === "done") {
        setBusy(false);
        setStatus("listo", "ok");
        refreshMetrics();
      } else if (msg.kind === "reset") {
        chatId = "";
        agentId = "";
        renderChat(null);
      } else if (msg.kind === "restored" && msg.current) {
        renderChat(msg.current);
        setStatus("chat restaurado", "ok");
      } else if (msg.kind === "status" && msg.text) {
        metaEl.textContent = String(msg.text);
      }
    }
  };
}

connect();
refreshContinuous();
