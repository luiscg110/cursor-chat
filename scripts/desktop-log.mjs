/**
 * Append-only diagnostics for desktop / continuous / worker lifecycle.
 * File: logs/continuous/desktop.log
 */
import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const logDir = resolve(root, "logs/continuous");
const logPath = resolve(logDir, "desktop.log");

function ensure() {
  mkdirSync(logDir, { recursive: true });
}

export function desktopLogPath() {
  return logPath;
}

export function desktopLog(event, extra = {}) {
  try {
    ensure();
    const line = JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      event,
      ...extra,
    });
    appendFileSync(logPath, `${line}\n`, "utf8");
  } catch {
    // never throw from logger
  }
  try {
    const msg = extra.msg || extra.error || "";
    console.log(`[cursor:chat] ${event}${msg ? ` — ${msg}` : ""}`);
  } catch {
    // ignore
  }
}

/** Record why the Node process exited without clearing running (allows resume). */
export function markContinuousInterrupted(reason) {
  try {
    ensure();
    const statePath = resolve(logDir, "state.json");
    if (!existsSync(statePath)) return;
    const s = JSON.parse(readFileSync(statePath, "utf8") || "null");
    if (!s || typeof s !== "object") return;
    s.lastProcessExit = {
      at: new Date().toISOString(),
      reason: String(reason || "unknown").slice(0, 200),
      pid: process.pid,
    };
    if (!s.lastError) s.lastError = `process_exit:${reason}`;
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8");
    try {
      renameSync(tmp, statePath);
    } catch {
      writeFileSync(statePath, JSON.stringify(s, null, 2), "utf8");
    }
  } catch {
    // ignore
  }
}
