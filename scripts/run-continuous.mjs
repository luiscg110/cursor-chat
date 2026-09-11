#!/usr/bin/env node
/**
 * CLI helper: start 24h continuous improvement against a running Cursor Chat server.
 *
 *   npm run improve:24h
 *   npm run improve -- --hours 24 --focus "tests and playbook"
 *
 * Requires the desktop app/server on CURSOR_CHAT_UI_PORT (default 3860).
 */
const PORT = Number(process.env.CURSOR_CHAT_UI_PORT || 3860);
const BASE = `http://127.0.0.1:${PORT}`;

function parseArgs(argv) {
  const out = { hours: 24, focus: "", cloud: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--hours" && n) {
      out.hours = Number(n);
      i += 1;
    } else if (a === "--focus" && n) {
      out.focus = n;
      i += 1;
    } else if (a === "--cloud") out.cloud = true;
    else if (a === "--stop") out.stop = true;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage:
  npm run improve:24h
  npm run improve -- --hours 12 --focus "performance"
  npm run improve -- --stop`);
    return;
  }

  if (opts.stop) {
    const res = await fetch(`${BASE}/api/continuous/stop`, { method: "POST" });
    console.log(await res.json());
    return;
  }

  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) {
    console.error(
      `Cursor Chat no está corriendo en ${BASE}.\nAbre la app primero: npm run app`
    );
    process.exit(1);
  }

  const res = await fetch(`${BASE}/api/continuous/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hours: opts.hours,
      focus: opts.focus,
      cloud: opts.cloud,
    }),
  });
  const j = await res.json();
  console.log(j);
  if (!j.ok) process.exit(1);
  console.log(
    `Mejora continua ON ~${opts.hours}h. Hallazgos: logs/continuous/\nPuedes cerrar esta terminal; la app sigue.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
