/**
 * Continuous improvement driver.
 * Sends naturalistic follow-ups (sounds like a human) through the agent loop:
 * implement → test → measure → optimize → capture discoveries → repeat.
 * Default duration: 24 hours.
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
} from "./discoveries-store.mjs";

const PHASES = ["implement", "test", "measure", "optimize", "capture"];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function humanMessage({ phase, cycle, focus, discoveriesBlurb }) {
  const playbook = "logs/continuous/playbook.md";
  const focusBit = focus
    ? ` Estoy priorizando: ${focus}.`
    : "";

  const openers = {
    implement: [
      `Ey, retomemos.${focusBit} Mira el repo y el playbook en ${playbook}. Quiero un cambio concreto de alto impacto ahora — implementa, no te quedes solo en la idea. Si algo ya salió bien antes, reutilízalo:`,
      `Hola — sigo aquí contigo.${focusBit} Siguiente paso: implementa una mejora real usando lo mejor que ya descubrimos. Playbook: ${playbook}. Contexto:`,
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
      `Ok, midamos.${focusBit} Compara contra el estado anterior y dime si esto entra al playbook o lo revertimos.`,
    ],
    optimize: [
      `Con lo que vimos, optimiza.${focusBit} Dobla apuesta en lo que funcionó; corta o arregla lo flojo. Usa el playbook (${playbook}) como base.`,
      `Siguiente: exprimir resultados.${focusBit} Refina lo que sí dio, y no pierdas tiempo en callejones sin salida. Hallazgos previos:`,
      `Vamos a optimizar con lo aprendido.${focusBit} Mejora concreta ahora. Recuerda lo que ya sirvió:`,
    ],
    capture: [
      `Antes de seguir, captura aprendizaje.${focusBit} Actualiza ${playbook} con lo nuevo que SÍ funcionó (y lo que no hay que repetir). Sé breve y accionable. Luego propón el próximo foco.`,
      `Documenta para no perderlo.${focusBit} Añade a ${playbook} solo hallazgos útiles. Si ya estaba, refínalo. Cierra con la siguiente apuesta.`,
      `Deja el playbook al día (${playbook}).${focusBit} Nada de relleno — solo lo que mañana nos ahorraría tiempo. Después, siguiente objetivo.`,
    ],
  };

  const tail =
    phase === "implement" || phase === "optimize"
      ? `\n\nHallazgos que ya valen la pena:\n${discoveriesBlurb}`
      : phase === "capture"
        ? `\n\nCiclo #${cycle}. Si no hay nada nuevo, dilo explícitamente.`
        : `\n\n(Ciclo #${cycle}, fase ${phase}.)`;

  return `${pick(openers[phase] || openers.implement)}${tail}`;
}

function kickoffMessage({ focus, discoveriesBlurb }) {
  const playbook = "logs/continuous/playbook.md";
  const focusBit = focus ? ` Mi prioridad hoy: ${focus}.` : "";
  return pick([
    `Hey — quiero trabajar contigo un rato largo en mejora continua de este repo.${focusBit} Ciclo simple: implementar → probar → mirar resultados → optimizar → guardar lo que sirvió en ${playbook}. Empieza inspeccionando el estado actual y haz el primer cambio concreto de alto impacto. Si ya hay notas útiles, respétalas:\n\n${discoveriesBlurb}`,
    `Hola, vamos a iterar en serio.${focusBit} No me des solo un plan: ejecuta. Arranca con el mejor siguiente paso, valida, y ve dejando lo bueno en ${playbook}. Contexto previo:\n\n${discoveriesBlurb}`,
  ]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {object} opts
 * @param {(args: {text:string, chatId?:string, cloud?:boolean, awaitDone?:boolean}) => Promise<any>} opts.send
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

  function publicStatus() {
    const s = state || loadState();
    return {
      running: Boolean(running && s?.running),
      phase: s?.phase || null,
      cycle: s?.cycle || 0,
      chatId: s?.chatId || null,
      startedAt: s?.startedAt || null,
      endsAt: s?.endsAt || null,
      focus: s?.focus || "",
      lastError: s?.lastError || null,
      discoveries: loadDiscoveries(),
      paths: continuousPaths(),
    };
  }

  function emit(kind, extra = {}) {
    broadcast?.({
      type: "continuous",
      kind,
      ...publicStatus(),
      ...extra,
    });
  }

  async function oneTurn(text) {
    const result = await send({
      text,
      chatId: state.chatId || "",
      cloud: Boolean(state.cloud),
      awaitDone: true,
    });
    if (!result?.ok) throw new Error(result?.error || "send failed");
    state.chatId = result.chatId || state.chatId;
    const snap = snapshot?.();
    const current = snap?.current;
    const assistantTexts = (current?.messages || [])
      .filter((m) => m.role === "assistant" && !m.kind)
      .map((m) => m.text || "");
    const lastText = assistantTexts[assistantTexts.length - 1] || result.text || "";
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
      notify?.("Mejora continua", "Terminaron las 24h — hallazgos quedan en el playbook");
      emit("finished");
      return;
    }

    const phase = state.phase || "implement";
    const cycle = state.cycle || 1;
    const discoveriesBlurb = bestContextBlurb();

    const text =
      state.needsKickoff
        ? kickoffMessage({ focus: state.focus, discoveriesBlurb })
        : humanMessage({
            phase,
            cycle,
            focus: state.focus,
            discoveriesBlurb,
          });

    state.needsKickoff = false;
    state.lastPromptAt = new Date().toISOString();
    state.lastPrompt = text;
    saveState(state);
    emit("turn_start", { promptPreview: text.slice(0, 160) });

    try {
      const { lastText } = await oneTurn(text);
      const found = extractDiscoveriesFromText(lastText, phase);
      upsertDiscoveries(found);
      appendCycle({
        at: new Date().toISOString(),
        cycle,
        phase,
        chatId: state.chatId,
        prompt: text.slice(0, 500),
        reply: String(lastText || "").slice(0, 4000),
        discoveriesAdded: found.length,
      });

      // advance phase
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
      notify?.("Mejora continua — error", state.lastError.slice(0, 160));
    }

    if (!state.running || stopFlag) {
      running = false;
      emit("stopped");
      return;
    }

    const pauseMs = Math.max(15_000, Number(state.pauseMs) || 90_000);
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
    const pauseMs = Math.max(15_000, Number(opts.pauseMs) || 90_000);
    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + hours * 3600_000);

    state = {
      running: true,
      startedAt: startedAt.toISOString(),
      endsAt: endsAt.toISOString(),
      hours,
      pauseMs,
      cycle: 1,
      phase: "implement",
      needsKickoff: true,
      focus: String(opts.focus || "").trim(),
      cloud: Boolean(opts.cloud),
      chatId: opts.chatId || null,
      lastError: null,
    };
    saveState(state);
    stopFlag = false;
    running = true;
    continuousPaths(); // ensure playbook exists
    notify?.(
      "Mejora continua",
      `Arrancó por ~${hours}h — puedes seguir en otra app`
    );
    emit("started");
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
    notify?.("Mejora continua", "Detenida — el playbook se conserva");
    emit("stopped", { reason });
    return { ok: true, ...publicStatus() };
  }

  // Resume if process restarted mid-run and endsAt still in future
  function maybeResume() {
    const s = loadState();
    if (!s?.running || !s.endsAt) return;
    if (Date.parse(s.endsAt) <= Date.now()) {
      s.running = false;
      s.stoppedReason = "duration_elapsed";
      saveState(s);
      return;
    }
    state = s;
    running = true;
    stopFlag = false;
    emit("resumed");
    timer = setTimeout(() => {
      tick().catch((e) => console.error("[continuous]", e));
    }, 5_000);
  }

  return {
    start,
    stop,
    status: publicStatus,
    maybeResume,
    clearState,
  };
}
