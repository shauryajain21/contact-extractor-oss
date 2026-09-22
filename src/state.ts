import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadState } from "./types.js";

/**
 * Everything worklog remembers between runs lives in one directory:
 *   watermark.json  last successful window end
 *   threads.json    open conversations and who owes the next move
 *   lock/           held for the duration of a run
 */

export interface Watermark {
  /** ISO end of the last successful window. */
  until: string;
  finishedAt: string;
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write via rename so a crash never leaves half a file. */
function writeJson(file: string, value: unknown): void {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

export class StateStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  readWatermark(): Watermark | null {
    return readJson<Watermark | null>(join(this.dir, "watermark.json"), null);
  }

  writeWatermark(until: Date, now = new Date()): void {
    writeJson(join(this.dir, "watermark.json"), {
      until: until.toISOString(),
      finishedAt: now.toISOString(),
    } satisfies Watermark);
  }

  readThreads(): Record<string, ThreadState> {
    return readJson<Record<string, ThreadState>>(join(this.dir, "threads.json"), {});
  }

  writeThreads(threads: Record<string, ThreadState>): void {
    writeJson(join(this.dir, "threads.json"), threads);
  }

  /**
   * Take the run lock. Returns a release function, or null if another live
   * process holds it. A lock left by a dead process is reclaimed.
   */
  acquireLock(): (() => void) | null {
    const lock = join(this.dir, "lock");
    const pidFile = join(lock, "pid");
    try {
      mkdirSync(lock);
    } catch {
      const holder = Number(safeRead(pidFile));
      if (holder && isAlive(holder)) return null;
      rmSync(lock, { recursive: true, force: true });
      try {
        mkdirSync(lock);
      } catch {
        return null;
      }
    }
    writeFileSync(pidFile, String(process.pid));
    return () => rmSync(lock, { recursive: true, force: true });
  }
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fold this run's thread states into what we already knew. A thread keeps its
 * original `since` while its waiting side is unchanged, so "waiting 3 days"
 * stays true across runs.
 */
export function mergeThreads(
  known: Record<string, ThreadState>,
  fresh: ThreadState[]
): Record<string, ThreadState> {
  const out = { ...known };
  for (const t of fresh) {
    const prev = out[t.id];
    if (prev && prev.waitingOn === t.waitingOn) {
      out[t.id] = { ...prev, ...t, since: prev.since };
    } else {
      out[t.id] = t;
    }
  }
  return out;
}
