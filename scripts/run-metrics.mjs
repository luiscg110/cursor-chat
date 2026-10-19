/**
 * Append-only run metrics for agent sessions (latency, tools, streaming).
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const metricsPath = resolve(root, "logs/continuous/metrics.jsonl");
const latestPath = resolve(root, "logs/continuous/metrics-latest.json");

function ensureDir() {
  mkdirSync(resolve(root, "logs/continuous"), { recursive: true });
}

/** @param {Record<string, unknown>} entry */
export function appendRunMetric(entry) {
  ensureDir();
  const row = { at: new Date().toISOString(), ...entry };
  appendFileSync(metricsPath, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

export function saveLatestSummary(summary) {
  ensureDir();
  const doc = { updatedAt: new Date().toISOString(), ...summary };
  writeFileSync(latestPath, JSON.stringify(doc, null, 2), "utf8");
  return doc;
}

export function loadRecentMetrics(limit = 50) {
  ensureDir();
  if (!existsSync(metricsPath)) return [];
  const lines = readFileSync(metricsPath, "utf8").trim().split("\n").filter(Boolean);
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function metricsPaths() {
  ensureDir();
  return { metricsPath, latestPath };
}
