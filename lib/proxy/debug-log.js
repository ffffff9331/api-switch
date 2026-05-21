"use strict";

const fs = require("node:fs");
const path = require("node:path");

function enabled() {
  return process.env.API_SWITCH_DEBUG_PROXY === "1" || process.env.CODEX_SWITCH_DEBUG_PROXY === "1";
}

function traceId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function writeDebugLog(baseDir, name, payload) {
  if (!enabled()) return "";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(baseDir, "proxy-logs");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prefix = payload && payload.traceId ? `${payload.traceId}-` : "";
  const file = path.join(dir, `${stamp}-${prefix}${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return file;
}

module.exports = {
  enabled,
  traceId,
  writeDebugLog,
};
