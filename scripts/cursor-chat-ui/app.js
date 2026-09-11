const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const cloudEl = document.getElementById("cloud");
const sendBtn = document.getElementById("sendBtn");
const newBtn = document.getElementById("newBtn");
const stopBtn = document.getElementById("stopBtn");
const metaEl = document.getElementById("meta");

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

function renderChat(current) {
  if (!current || !current.messages?.length) {
    chatId = current?.id || "";
    messagesEl.innerHTML =
      '<div class="empty" id="empty">Escribe abajo y pulsa Enviar.<br />Luego puedes irte a otra app — te avisamos cuando termine.</div>';
    metaEl.textContent = "";
    setBusy(current?.status === "running");
    return;
  }

  chatId = current.id || chatId;
  messagesEl.innerHTML = current.messages
    .map((m) => {
      const role = m.role === "user" ? "user" : "assistant";
      const extra = current.status === "error" && role === "assistant" ? " error" : "";
      const text =
        m.text ||
        (role === "assistant" && current.status === "running" ? "…" : "");
      return `<div class="bubble ${role}${extra}">${escapeHtml(text)}</div>`;
    })
    .join("");
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const where = current.cloud
    ? "cloud · también en Cursor Agents"
    : "local · no abre Cursor";
  metaEl.textContent = [
    current.agentId ? `id ${current.agentId}` : "",
    current.model || "",
    where,
    current.status === "running" ? "respondiendo…" : current.status || "",
  ]
    .filter(Boolean)
    .join(" · ");

  setBusy(current.status === "running");
  if (current.status === "running") setStatus("respondiendo…", "wait");
  else if (current.status === "error") setStatus("error", "bad");
  else setStatus("listo", "ok");
}

function appendDelta(text) {
  if (!text) return;
  let last = messagesEl.querySelector(".bubble.assistant:last-of-type");
  if (!last) {
    last = document.createElement("div");
    last.className = "bubble assistant";
    messagesEl.appendChild(last);
  }
  last.textContent += text;
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
    setStatus("respondiendo…", "wait");
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
      else setStatus("conectado", "ok");
    } else if (msg.type === "cursor_chat") {
      if (msg.kind === "delta") appendDelta(msg.text || "");
      else if (msg.current) renderChat(msg.current);
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
