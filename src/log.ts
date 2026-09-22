import type { Logger } from "./types.js";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: Level = (process.env.WORKLOG_LOG_LEVEL as Level) || "info"): Logger {
  const min = ORDER[level] ?? ORDER.info;
  const emit = (l: Level, msg: string, extra?: Record<string, unknown>) => {
    if (ORDER[l] < min) return;
    const tail = extra && Object.keys(extra).length ? " " + JSON.stringify(extra) : "";
    process.stderr.write(`[${new Date().toISOString()}] ${l.padEnd(5)} ${msg}${tail}\n`);
  };
  return {
    debug: (m, e) => emit("debug", m, e),
    info: (m, e) => emit("info", m, e),
    warn: (m, e) => emit("warn", m, e),
    error: (m, e) => emit("error", m, e),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
