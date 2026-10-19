/**
 * Durable discoveries / playbook for the continuous improvement session.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  unlinkSync,
} from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dir = resolve(root, "logs/continuous");
const discoveriesPath = resolve(dir, "discoveries.json");
const playbookPath = resolve(dir, "playbook.md");
const cyclesPath = resolve(dir, "cycles.jsonl");
const statePath = resolve(dir, "state.json");
const chatSessionPath = resolve(dir, "chat-session.json");

function ensureDir() {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(playbookPath)) {
    writeFileSync(
      playbookPath,
      `# Playbook de mejora continua

Notas que sí funcionaron. No borrar lo útil — solo añadir o refinar.

## Qué está funcionando

(vacío todavía)

## Qué no repetir

(vacío todavía)

## Próximas apuestas

(vacío todavía)
`,
      "utf8"
    );
  }
  if (!existsSync(discoveriesPath)) {
    writeFileSync(
      discoveriesPath,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          best: [],
          items: [],
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

export function continuousPaths() {
  ensureDir();
  return {
    dir,
    discoveriesPath,
    playbookPath,
    cyclesPath,
    statePath,
    chatSessionPath,
    root,
  };
}

export function loadDiscoveries() {
  ensureDir();
  try {
    return JSON.parse(readFileSync(discoveriesPath, "utf8"));
  } catch {
    return { updatedAt: null, best: [], items: [] };
  }
}

function readDiscoveriesRaw() {
  ensureDir();
  try {
    return JSON.parse(readFileSync(discoveriesPath, "utf8"));
  } catch {
    return { updatedAt: null, best: [], items: [] };
  }
}

export function saveDiscoveries(doc) {
  ensureDir();
  doc.updatedAt = new Date().toISOString();
  writeFileSync(discoveriesPath, JSON.stringify(doc, null, 2), "utf8");
  return doc;
}

function readPlaybook() {
  ensureDir();
  return existsSync(playbookPath) ? readFileSync(playbookPath, "utf8") : "";
}

const PLAYBOOK_SECTIONS = [
  {
    re: /## Qué está funcionando\n\n([\s\S]*?)(?=\n## |$)/i,
    score: 2,
    phase: "working",
  },
  {
    re: /## Qué no repetir\n\n([\s\S]*?)(?=\n## |$)/i,
    score: 2,
    phase: "avoid",
  },
  {
    re: /## Próximas apuestas\n\n([\s\S]*?)(?=\n## |$)/i,
    score: 1,
    phase: "next",
  },
];

/** Parse bullet lines from playbook sections into discovery items. */
export function parsePlaybookBullets(text = "") {
  const items = [];
  for (const sec of PLAYBOOK_SECTIONS) {
    const match = String(text || "").match(sec.re);
    if (!match) continue;
    for (const line of match[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("-")) continue;
      const content = trimmed.replace(/^-\s*/, "").trim();
      if (!content || /^\(vacío todavía\)$/i.test(content) || content.length < 8) continue;
      const dash = content.indexOf(" — ");
      const title = (dash > 0 ? content.slice(0, dash) : content).slice(0, 200);
      items.push({
        title,
        detail: content.slice(0, 2000),
        score: sec.score,
        phase: sec.phase,
      });
    }
  }
  return items;
}

/** Import playbook bullets into discoveries.json (idempotent by title). */
export function syncDiscoveriesFromPlaybook() {
  const bullets = parsePlaybookBullets(readPlaybook());
  if (!bullets.length) return { added: 0, total: 0 };
  let before = 0;
  try {
    before = JSON.parse(readFileSync(discoveriesPath, "utf8")).items?.length || 0;
  } catch {
    before = 0;
  }
  upsertDiscoveries(bullets);
  const after = loadDiscoveries().items?.length || 0;
  return { added: Math.max(0, after - before), total: after };
}

/** Append high-confidence findings to playbook sections (idempotent by title). */
export function syncPlaybookFromItems(items = []) {
  ensureDir();
  let text = readPlaybook();
  const promoted = items.filter((i) => (i.score || 0) >= 2 && (i.title || "").length >= 8);
  if (!promoted.length) return { updated: false, added: 0 };

  let added = 0;
  for (const item of promoted) {
    const line = `- ${item.title}${item.detail && item.detail !== item.title ? ` — ${String(item.detail).slice(0, 160)}` : ""}`;
    if (text.includes(item.title.slice(0, 80))) continue;
    if (/no repetir|qué no/i.test(item.title)) {
      text = text.replace(
        /(## Qué no repetir\n\n)(\(vacío todavía\)|(?:(?!## ).*\n)*)/,
        `$1${line}\n`
      );
    } else {
      text = text.replace(
        /(## Qué está funcionando\n\n)(\(vacío todavía\)|(?:(?!## ).*\n)*)/,
        `$1${line}\n`
      );
    }
    added += 1;
  }
  if (added > 0) {
    writeFileSync(playbookPath, text, "utf8");
  }
  return { updated: added > 0, added };
}

export function loadPlaybookContext(maxChars = 2400) {
  const text = readPlaybook().trim();
  if (!text || text.includes("(vacío todavía)")) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

export function upsertDiscoveries(newItems = []) {
  const doc = readDiscoveriesRaw();
  const items = Array.isArray(doc.items) ? doc.items : [];
  const byTitle = new Map(items.map((i) => [String(i.title || "").toLowerCase(), i]));
  const incoming = [];

  for (const raw of newItems) {
    const title = String(raw.title || raw.text || "").trim();
    if (!title || title.length < 8) continue;
    const key = title.toLowerCase().slice(0, 120);
    const prev = byTitle.get(key);
    const next = {
      title: title.slice(0, 200),
      detail: String(raw.detail || raw.text || "").slice(0, 2000),
      score: Number(raw.score ?? prev?.score ?? 1) || 1,
      phase: raw.phase || prev?.phase || "",
      firstSeenAt: prev?.firstSeenAt || new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      hits: (prev?.hits || 0) + 1,
    };
    byTitle.set(key, next);
    incoming.push(next);
  }

  doc.items = [...byTitle.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
  doc.best = doc.items.filter((i) => (i.score || 0) >= 2 || (i.hits || 0) >= 2).slice(0, 20);
  saveDiscoveries(doc);
  syncPlaybookFromItems(incoming.filter((i) => (i.score || 0) >= 2));
  return doc;
}

export function appendCycle(entry) {
  ensureDir();
  appendFileSync(cyclesPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export function loadState() {
  ensureDir();
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

export function saveState(state) {
  ensureDir();
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  try {
    renameSync(tmp, statePath);
  } catch {
    writeFileSync(statePath, readFileSync(tmp, "utf8"), "utf8");
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  return state;
}

export function clearState() {
  ensureDir();
  if (existsSync(statePath)) writeFileSync(statePath, "null", "utf8");
}

/** Durable chat bridge across app restarts (agentId + UI messages). */
export function loadChatSession() {
  ensureDir();
  if (!existsSync(chatSessionPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(chatSessionPath, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveChatSession(session) {
  ensureDir();
  const payload = {
    updatedAt: new Date().toISOString(),
    chatId: session?.chatId || null,
    agentId: session?.agentId || null,
    cloud: Boolean(session?.cloud),
    model: session?.model || "",
    messages: Array.isArray(session?.messages)
      ? session.messages.slice(-120).map((m) => ({
          role: m.role,
          text: String(m.text || "").slice(0, 8000),
          kind: m.kind || undefined,
          tool: m.tool || undefined,
        }))
      : [],
  };
  const tmp = `${chatSessionPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  try {
    renameSync(tmp, chatSessionPath);
  } catch {
    writeFileSync(chatSessionPath, readFileSync(tmp, "utf8"), "utf8");
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  return payload;
}

export function clearChatSession() {
  ensureDir();
  if (existsSync(chatSessionPath)) writeFileSync(chatSessionPath, "null", "utf8");
}

/** Pull candidate discoveries from freeform agent text. */
export function extractDiscoveriesFromText(text, phase) {
  const out = [];
  const body = String(text || "");
  if (!body.trim()) return out;

  const lines = body.split(/\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (
      /^(✅|✓|works|funcion[oó]|mejor[oó]|learned|aprend|keep|dejar|playbook)/i.test(
        line
      ) ||
      /^[-*]\s+/.test(line)
    ) {
      out.push({
        title: line.replace(/^[-*✅✓]\s*/, "").slice(0, 160),
        detail: line,
        score: 2,
        phase,
      });
    }
  }

  // Always keep a short digest of the turn as low-score memory.
  const digest = body.replace(/\s+/g, " ").trim().slice(0, 240);
  if (digest) {
    out.push({
      title: `${phase}: ${digest.slice(0, 80)}`,
      detail: digest,
      score: 1,
      phase,
    });
  }
  return out.slice(0, 12);
}

export function bestContextBlurb(max = 8) {
  let doc = loadDiscoveries();
  let pool = (doc.best?.length ? doc.best : doc.items || []).slice(0, max);
  if (!pool.length) {
    syncDiscoveriesFromPlaybook();
    doc = loadDiscoveries();
    pool = (doc.best?.length ? doc.best : doc.items || []).slice(0, max);
  }
  if (!pool.length) {
    const bullets = parsePlaybookBullets(readPlaybook()).slice(0, max);
    if (bullets.length) {
      return bullets
        .map(
          (i, idx) =>
            `${idx + 1}. ${i.title}${i.detail && i.detail !== i.title ? ` — ${i.detail.slice(0, 120)}` : ""}`
        )
        .join("\n");
    }
    return "Todavía no hay hallazgos guardados en el playbook.";
  }
  return pool
    .map((i, idx) => `${idx + 1}. ${i.title}${i.detail && i.detail !== i.title ? ` — ${i.detail.slice(0, 120)}` : ""}`)
    .join("\n");
}
