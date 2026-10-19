/**
 * Continuous improvement driver.
 * Sends naturalistic follow-ups (sounds like a human) through the agent loop:
 * implement → test → measure → optimize → capture discoveries → repeat.
 * Default duration: 24 hours.
 *
 * Phase/cycle are internal only — prompts must feel like a normal ongoing chat.
 */
import {
  continuousPaths,
  loadDiscoveries,
  upsertDiscoveries,
  extractDiscoveriesFromText,
  appendCycle,
  loadState,
  saveState,
  clearState,
  bestContextBlurb,
  loadPlaybookContext,
  syncDiscoveriesFromPlaybook,
  loadChatSession,
} from "./discoveries-store.mjs";
import { runEval } from "./eval-harness.mjs";
import { desktopLog } from "./desktop-log.mjs";

const PHASES = ["implement", "test", "measure", "optimize", "capture"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function humanMessage({ phase, focus, discoveriesBlurb }) {
  const playbook = "logs/continuous/playbook.md";
  const focusBit = focus ? ` Estoy priorizando: ${focus}.` : "";

  const openers = {
    implement: [
      `Ey, retomemos.${focusBit} Mira el repo y las notas en ${playbook}. Quiero un cambio concreto de alto impacto ahora — implementa, no te quedes solo en la idea. Si algo ya salió bien antes, reutilízalo:`,
      `Hola — sigo aquí contigo.${focusBit} Siguiente paso: implementa una mejora real usando lo mejor que ya vimos. Notas: ${playbook}. Contexto:`,
      `Ok, manos a la obra.${focusBit} Elige el cuello de botella más claro, aplica el fix, y deja el código listo. No reinventes lo que ya funciona:`,
    ],
    test: [
      `Listo, ahora quiero evidencia.${focusBit} Corre pruebas / validaciones de lo que tocamos. Dime qué pasó (pass/fail) con detalle. Si algo rompe, no lo dejes a medias.`,
      `Probemos en serio.${focusBit} Ejecuta lo necesario para verificar el último cambio y resume resultados claros. Si falla, aísla la causa.`,
      `Antes de seguir, validación:${focusBit} corre checks/tests relevantes y dime números o errores concretos.`,
    ],
    measure: [
      `Con esos resultados, sé directo:${focusBit} ¿qué mejoró, qué empeoró, qué se quedó igual? Quédate con métricas o señales observables.`,
      `Ayúdame a leer el resultado.${focusBit} Resume el delta vs antes. Quiero saber si vale la pena conservar el cambio.`,
      `Ok, midamos.${focusBit} Compara contra el estado anterior y dime si esto vale la pena dejarlo o lo revertimos.`,
    ],
    optimize: [
      `Con lo que vimos, optimiza.${focusBit} Dobla apuesta en lo que funcionó; corta o arregla lo flojo. Usa ${playbook} como base.`,
      `Siguiente: exprimir resultados.${focusBit} Refina lo que sí dio, y no pierdas tiempo en callejones sin salida. Hallazgos previos:`,
      `Vamos a optimizar con lo aprendido.${focusBit} Mejora concreta ahora. Recuerda lo que ya sirvió:`,
    ],
    capture: [
      `Antes de seguir, captura lo aprendido.${focusBit} Actualiza ${playbook} con lo nuevo que SÍ funcionó (y lo que no hay que repetir). Sé breve y accionable. Luego propón el próximo foco.`,
      `Documenta para no perderlo.${focusBit} Añade a ${playbook} solo hallazgos útiles. Si ya estaba, refínalo. Cierra con la siguiente apuesta.`,
      `Deja ${playbook} al día.${focusBit} Nada de relleno — solo lo que mañana nos ahorraría tiempo. Después, siguiente objetivo.`,
    ],
  };

  const tail =
    phase === "implement" || phase === "optimize"
      ? `\n\nCosas que ya valen la pena:\n${discoveriesBlurb}`
      : phase === "capture"
        ? `\n\nSi no hay nada nuevo, dilo explícitamente.`
        : "";

  return `${pick(openers[phase] || openers.implement)}${tail}`;
}

function kickoffMessage({ focus, discoveriesBlurb }) {
  const playbook = "logs/continuous/playbook.md";
  const focusBit = focus ? ` Mi prioridad hoy: ${focus}.` : "";
  return pick([
    `Hey — quiero seguir trabajando en este repo un rato.${focusBit} No me des solo un plan: ejecuta. Empieza inspeccionando el estado actual y haz el primer cambio concreto de alto impacto. Si ya hay notas en ${playbook}, respétalas:\n\n${discoveriesBlurb}`,
    `Hola, vamos a iterar en serio.${focusBit} Arranca con el mejor siguiente paso, valida, y ve dejando lo bueno en ${playbook}. Contexto previo:\n\n${discoveriesBlurb}`,
  ]);
}

/** After an app restart mid-session — sounds like the human came back to the same chat. */
function resumeMessage({ focus, discoveriesBlurb }) {
  const focusBit = focus ? ` Seguimos con: ${focus}.` : "";
  return pick([
    `Ey, volví.${focusBit} Retomemos exactamente donde lo dejamos — no empieces de cero. Siguiente paso concreto:`,
    `Aquí estoy de nuevo.${focusBit} Continúa la conversación; usa el contexto que ya tienes y avanza con el próximo cambio útil.`,
    `Ok, reabrí el chat.${focusBit} Sigamos. Si te quedaste a medias, termina eso; si no, el siguiente movimiento de alto impacto:`,
  ]) + `\n\nRecordatorio rápido de lo útil:\n${discoveriesBlurb}`;
}

function formatEvalBlock(report) {
  if (!report?.checks?.length) return "";
  const lines = report.checks.map((c) => {
    const mark = c.ok ? "✓" : "✗";
    const extra = c.error ? ` — ${c.error}` : "";
    return `${mark} ${c.name}${extra}`;
  });
  return `\n\nAcabo de correr los checks del repo:\n${lines.join("\n")}\n`;
}

async function autoEvalBlock() {
  const port = Number(process.env.CURSOR_CHAT_UI_PORT || 3860);
  try {
    const report = await runEval({
      base: `http://127.0.0.1:${port}`,
      write: true,
    });
    return formatEvalBlock(report);
  } catch (err) {
    return `\n\nIntenté correr los checks del repo y falló: ${err?.message || String(err)}\n`;
  }
}

/**
 * @param {object} opts
 * @param {(args: {text:string, chatId?:string, agentId?:string, cloud?:boolean, awaitDone?:boolean}) => Promise<any>} opts.send
 * @param {() => any} opts.snapshot
 * @param {(obj:any) => void} [opts.broadcast]
 * @param {(title:string, body:string) => void} [opts.notify]
 */
export function createContinuousLoop({ send, snapshot, broadcast, notify }) {
  /** @type {any} */
  let state = loadState();
  let timer = null;
  let running = false;
  let stopFlag = false;

  function publicStatus({ includeDiscoveries = true } = {}) {
    const s = state || loadState();
    const session = loadChatSession();
    const base = {
      running: Boolean(running && s?.running),
      phase: s?.phase || null,
      cycle: s?.cycle || 0,
      chatId: s?.chatId || session?.chatId || null,
      agentId: s?.agentId || session?.agentId || null,
      startedAt: s?.startedAt || null,
      endsAt: s?.endsAt || null,
      nextTurnAt: s?.nextTurnAt || null,
      pauseMs: s?.pauseMs || null,
      focus: s?.focus || "",
      lastError: s?.lastError || null,
      lastPromptAt: s?.lastPromptAt || null,
      lastReplyAt: s?.lastReplyAt || null,
      paths: continuousPaths(),
    };
    if (includeDiscoveries) {
      base.lastPrompt = s?.lastPrompt || null;
      base.discoveries = loadDiscoveries();
    }
    return base;
  }

  function emit(kind, extra = {}) {
    broadcast?.({
      type: "continuous",
      kind,
      ...publicStatus({ includeDiscoveries: false }),
      ...extra,
    });
  }

  function assistantReplyText(result, current) {
    const fromResult = String(result?.text || "").trim();
    if (fromResult) return fromResult;
    return (current?.messages || [])
      .filter((m) => m.role === "assistant" && !m.kind)
      .map((m) => m.text || "")
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  async function oneTurn(text) {
    const session = loadChatSession();
    const result = await send({
      text,
      chatId: state.chatId || session?.chatId || "",
      agentId: state.agentId || session?.agentId || "",
      cloud: Boolean(state.cloud),
      awaitDone: true,
    });
    if (!result?.ok) throw new Error(result?.error || "send failed");
    let dirty = false;
    if (result.chatId && result.chatId !== state.chatId) {
      state.chatId = result.chatId;
      dirty = true;
    }
    if (result.agentId && result.agentId !== state.agentId) {
      state.agentId = result.agentId;
      dirty = true;
    }
    if (dirty) saveState(state);
    const snap = snapshot?.();
    const current = result.current || snap?.current;
    const lastText = assistantReplyText(result, current);
    return { result, lastText };
  }

  async function tick() {
    if (!state?.running || stopFlag) return;

    const now = Date.now();
    if (state.endsAt && now >= Date.parse(state.endsAt)) {
      state.running = false;
      state.stoppedReason = "duration_elapsed";
      saveState(state);
      running = false;
      notify?.("Cursor Chat", "Sesión larga terminada — el historial y el playbook quedan guardados");
      emit("finished");
      return;
    }

    const phase = state.phase || "implement";
    const cycle = state.cycle || 1;
    const discoveriesBlurb = bestContextBlurb();

    const playbookCtx = loadPlaybookContext();
    const playbookBlock = playbookCtx
      ? `\n\nNotas del playbook (por si te sirven):\n${playbookCtx}\n`
      : "";

    let evalBlock = "";
    if (phase === "test") {
      evalBlock = await autoEvalBlock();
    }

    let body;
    if (state.needsKickoff) {
      body = kickoffMessage({ focus: state.focus, discoveriesBlurb });
    } else if (state.needsResumeNudge) {
      body = resumeMessage({ focus: state.focus, discoveriesBlurb });
    } else {
      body = humanMessage({
        phase,
        focus: state.focus,
        discoveriesBlurb,
      });
    }

    const text = body + playbookBlock + evalBlock;

    state.needsKickoff = false;
    state.needsResumeNudge = false;
    state.lastPromptAt = new Date().toISOString();
    state.lastPrompt = text;
    saveState(state);
    emit("turn_start", { prompt: text, promptPreview: text.slice(0, 240) });
    desktopLog("turn_start", {
      cycle,
      phase,
      chatId: state.chatId,
      agentId: state.agentId,
      promptChars: text.length,
    });

    try {
      const { lastText } = await oneTurn(text);
      desktopLog("turn_done", {
        cycle,
        phase,
        chatId: state.chatId,
        agentId: state.agentId,
        replyChars: String(lastText || "").length,
      });
      const found = extractDiscoveriesFromText(lastText, phase);
      upsertDiscoveries(found);
      if (phase === "capture") {
        syncDiscoveriesFromPlaybook();
      }
      appendCycle({
        at: new Date().toISOString(),
        cycle,
        phase,
        chatId: state.chatId,
        agentId: state.agentId,
        prompt: text.slice(0, 500),
        reply: String(lastText || "").slice(0, 4000),
        discoveriesAdded: found.length,
      });

      // advance phase (internal — never told to the agent)
      const idx = PHASES.indexOf(phase);
      let nextPhase;
      let nextCycle = cycle;
      if (idx < 0 || idx >= PHASES.length - 1) {
        nextPhase = "implement";
        nextCycle = cycle + 1;
      } else {
        nextPhase = PHASES[idx + 1];
      }
      state.phase = nextPhase;
      state.cycle = nextCycle;
      state.lastError = null;
      state.lastReplyAt = new Date().toISOString();
      saveState(state);
      emit("turn_done", { nextPhase, nextCycle });
    } catch (err) {
      state.lastError = err?.message || String(err);
      saveState(state);
      emit("turn_error", { error: state.lastError });
      desktopLog("turn_error", { error: state.lastError, cycle, phase });
      notify?.("Cursor Chat — error", state.lastError.slice(0, 160));
    }

    if (!state.running || stopFlag) {
      running = false;
      emit("stopped");
      return;
    }

    const pauseMs = Math.max(10_000, Number(state.pauseMs) || 45_000);
    // jitter so pacing feels less robotic
    const wait = pauseMs + Math.floor(Math.random() * Math.min(60_000, pauseMs / 2));
    state.nextTurnAt = new Date(Date.now() + wait).toISOString();
    saveState(state);
    emit("paused", { nextTurnAt: state.nextTurnAt, waitMs: wait });
    timer = setTimeout(() => {
      tick().catch((e) => console.error("[continuous]", e));
    }, wait);
  }

  async function start(opts = {}) {
    if (running) return { ok: false, error: "already running", ...publicStatus() };

    const hours = Math.max(0.1, Number(opts.hours ?? 24) || 24);
    const pauseMs = Math.max(10_000, Number(opts.pauseMs) || 45_000);
    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + hours * 3600_000);

    const session = loadChatSession();
    const prev = loadState();
    const reuseAgent =
      opts.fresh !== true &&
      (opts.agentId ||
        opts.chatId ||
        session?.agentId ||
        prev?.agentId);

    state = {
      running: true,
      startedAt: startedAt.toISOString(),
      endsAt: endsAt.toISOString(),
      hours,
      pauseMs,
      cycle: reuseAgent && prev?.cycle ? prev.cycle : 1,
      phase: reuseAgent && prev?.phase ? prev.phase : "implement",
      needsKickoff: !reuseAgent,
      needsResumeNudge: Boolean(reuseAgent),
      focus: String(opts.focus || prev?.focus || "").trim(),
      cloud: Boolean(opts.cloud ?? prev?.cloud ?? session?.cloud),
      chatId: opts.chatId || session?.chatId || prev?.chatId || null,
      agentId: opts.agentId || session?.agentId || prev?.agentId || null,
      lastError: null,
    };
    saveState(state);
    stopFlag = false;
    running = true;
    continuousPaths(); // ensure playbook exists
    notify?.(
      "Cursor Chat",
      reuseAgent
        ? `Retomamos el chat (~${hours}h) — puedes seguir en otra app`
        : `Arrancó por ~${hours}h — puedes seguir en otra app`
    );
    emit("started");
    desktopLog("continuous_start", {
      hours,
      focus: state.focus?.slice(0, 120),
      reuseAgent: Boolean(reuseAgent),
      chatId: state.chatId,
      agentId: state.agentId,
    });
    tick().catch((e) => console.error("[continuous]", e));
    return { ok: true, ...publicStatus() };
  }

  async function stop(reason = "user_stop") {
    stopFlag = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (state) {
      state.running = false;
      state.stoppedReason = reason;
      state.stoppedAt = new Date().toISOString();
      saveState(state);
    }
    running = false;
    notify?.("Cursor Chat", "Pausada — el historial se conserva para retomar");
    emit("stopped", { reason });
    return { ok: true, ...publicStatus() };
  }

  // Resume if process restarted mid-run and endsAt still in future.
  // Opt-in: SDK agent work can peg a CPU core; require explicit env so macOS
  // window-restore doesn't auto-spawn a hot loop. UI "Arrancar" still works.
  function maybeResume() {
    if (process.env.CURSOR_CONTINUOUS_AUTORESTART !== "1") {
      const s = loadState();
      if (s?.running) {
        console.log(
          "[continuous] state.running=true but AUTORESTART off — usa Arrancar 24h en la UI"
        );
        desktopLog("maybe_resume_skipped", {
          reason: "AUTORESTART_off",
          running: true,
          endsAt: s.endsAt,
        });
      }
      return;
    }
    const s = loadState();
    if (!s?.running || !s.endsAt) return;
    if (Date.parse(s.endsAt) <= Date.now()) {
      s.running = false;
      s.stoppedReason = "duration_elapsed";
      saveState(s);
      return;
    }
    const session = loadChatSession();
    if (session?.agentId && !s.agentId) s.agentId = session.agentId;
    if (session?.chatId && !s.chatId) s.chatId = session.chatId;
    s.needsResumeNudge = Boolean(s.agentId || session?.agentId);
    s.needsKickoff = false;
    saveState(s);
    state = s;
    running = true;
    stopFlag = false;
    emit("resumed");
    desktopLog("continuous_resumed", {
      cycle: s.cycle,
      phase: s.phase,
      endsAt: s.endsAt,
      chatId: s.chatId,
    });
    timer = setTimeout(() => {
      tick().catch((e) => console.error("[continuous]", e));
    }, 8_000);
  }

  return {
    start,
    stop,
    status: publicStatus,
    lightStatus: () => publicStatus({ includeDiscoveries: false }),
    maybeResume,
    clearState,
  };
}
