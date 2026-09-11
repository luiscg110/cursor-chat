/**
 * Durable discoveries / playbook for the continuous improvement session.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
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
  return { dir, discoveriesPath, playbookPath, cyclesPath, statePath, root };
}

export function loadDiscoveries() {
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

/** Merge new findings; keep unique by title; promote score into best. */
export function upsertDiscoveries(newItems = []) {
  const doc = loadDiscoveries();
  const items = Array.isArray(doc.items) ? doc.items : [];
  const byTitle = new Map(items.map((i) => [String(i.title || "").toLowerCase(), i]));

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
  }

  doc.items = [...byTitle.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
  doc.best = doc.items.filter((i) => (i.score || 0) >= 2 || (i.hits || 0) >= 2).slice(0, 20);
  return saveDiscoveries(doc);
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
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  return state;
}

export function clearState() {
  ensureDir();
  if (existsSync(statePath)) writeFileSync(statePath, "null", "utf8");
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
      title: `ciclo ${phase}: ${digest.slice(0, 80)}`,
      detail: digest,
      score: 1,
      phase,
    });
  }
  return out.slice(0, 12);
}

export function bestContextBlurb(max = 8) {
  const doc = loadDiscoveries();
  const pool = (doc.best?.length ? doc.best : doc.items || []).slice(0, max);
  if (!pool.length) {
    return "Todavía no hay hallazgos guardados en el playbook.";
  }
  return pool
    .map((i, idx) => `${idx + 1}. ${i.title}${i.detail && i.detail !== i.title ? ` — ${i.detail.slice(0, 120)}` : ""}`)
    .join("\n");
}
