const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const cloudEl = document.getElementById("cloud");
const sendBtn = document.getElementById("sendBtn");
const newBtn = document.getElementById("newBtn");
const stopBtn = document.getElementById("stopBtn");
const metaEl = document.getElementById("meta");
const focusInput = document.getElementById("focusInput");
const hoursInput = document.getElementById("hoursInput");
const contStartBtn = document.getElementById("contStartBtn");
const contStopBtn = document.getElementById("contStopBtn");
const contMeta = document.getElementById("contMeta");

let chatId = "";
let busy = false;
let es = null;

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
    messagesEl.innerHTML =
      '<div class="empty" id="empty">Escribe una <b>tarea</b> (ej: “añade un README con setup”). Verás herramientas y pasos, no solo texto.<br />Puedes irte a otra app — te avisamos cuando termine.</div>';
    metaEl.textContent = "";
    setBusy(current?.status === "running");
    return;
  }

  chatId = current.id || chatId;
  messagesEl.innerHTML = current.messages
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

function renderContinuous(st) {
  if (!contMeta) return;
  const running = Boolean(st?.running);
  if (contStartBtn) contStartBtn.disabled = running;
  if (contStopBtn) contStopBtn.disabled = !running;
  if (!st) {
    contMeta.textContent = "Idle — hallazgos en logs/continuous/";
    return;
  }
  const best = st.discoveries?.best?.length || st.discoveries?.items?.length || 0;
  contMeta.textContent = running
    ? `ON · ciclo ${st.cycle || 0} · fase ${st.phase || "?"} · hasta ${st.endsAt || "?"} · hallazgos ${best}`
    : `OFF · ciclos hechos ${st.cycle || 0} · hallazgos ${best} · playbook en logs/continuous/`;
}

if (contStartBtn) {
  contStartBtn.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/continuous/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hours: Number(hoursInput?.value) || 24,
          focus: (focusInput?.value || "").trim(),
          cloud: Boolean(cloudEl?.checked),
          chatId: chatId || undefined,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      renderContinuous(j);
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
        cloud: Boolean(cloudEl.checked),
      }),
    });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
    chatId = j.chatId || chatId;
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
    } else if (msg.type === "cursor_chat") {
      if (msg.kind === "delta") appendDelta(msg.text || "");
      else if (msg.kind === "tool" || msg.kind === "thinking" || msg.kind === "task") {
        if (msg.current) renderChat(msg.current);
        else appendActivity(msg.kind, msg.text || "");
      } else if (msg.current) renderChat(msg.current);
      if (msg.kind === "error") {
        setBusy(false);
        setStatus("error", "bad");
        if (msg.error) metaEl.textContent = msg.error;
      } else if (msg.kind === "done") {
        setBusy(false);
        setStatus("listo", "ok");
      } else if (msg.kind === "reset") {
        chatId = "";
        renderChat(null);
      } else if (msg.kind === "status" && msg.text) {
        metaEl.textContent = String(msg.text);
      }
    }
  };
}

connect();
refreshContinuous();
