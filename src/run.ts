import { createExtractor } from "./extract/index.js";
import { allSources } from "./sources/index.js";
import { mergeThreads, StateStore } from "./state.js";
import type { Activity, Config, Digest, Extractor, Logger, Source, WriteReport } from "./types.js";
import { writeDigest } from "./vault/index.js";

export type RunStatus = "ok" | "skipped" | "locked" | "failed";

export interface RunOptions {
  config: Config;
  log: Logger;
  since?: Date;
  until?: Date;
  dryRun?: boolean;
  ifStale?: boolean;
  /** Whole-run budget. Defaults to 15 minutes. */
  timeoutMs?: number;
  /** Injected clock, for tests. */
  now?: Date;
}

export interface RunDeps {
  sources?: Source[];
  extractor?: Extractor;
}

export interface RunResult {
  status: RunStatus;
  report?: WriteReport;
  digest?: Digest;
  /** Activities collected per enabled source. */
  counts: Record<string, number>;
  window?: { since: string; until: string };
  /** Per-source (or `run`) error messages. */
  errors?: Record<string, string>;
  /** Why the run was skipped or failed, in one line. */
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

/** Smallest gap between consecutive schedule times, wrapping past midnight. */
export function smallestScheduleGapMs(times: string[]): number {
  const mins = [...new Set(times.filter((t) => /^\d{2}:\d{2}$/.test(t)).map(minutesOf))].sort((a, b) => a - b);
  if (mins.length < 2) return DAY_MS;
  let gap = 24 * 60;
  for (let i = 0; i < mins.length; i++) {
    const next = i + 1 < mins.length ? mins[i + 1]! : mins[0]! + 24 * 60;
    gap = Math.min(gap, next - mins[i]!);
  }
  return gap * 60_000;
}

export function staleAfterMs(config: Config): number {
  return smallestScheduleGapMs(config.schedule.times) + 30 * 60_000;
}

class TimeoutError extends Error {}

export async function runOnce(opts: RunOptions, deps: RunDeps = {}): Promise<RunResult> {
  const { config, log } = opts;
  const now = opts.now ?? new Date();
  const counts: Record<string, number> = {};
  const state = new StateStore(config.stateDir);
  const watermark = state.readWatermark();

  if (opts.ifStale && watermark) {
    const age = now.getTime() - new Date(watermark.finishedAt).getTime();
    if (age >= 0 && age < staleAfterMs(config)) {
      log.info("last run is recent, skipping", { finishedAt: watermark.finishedAt });
      return { status: "skipped", counts, reason: `last run finished ${watermark.finishedAt}` };
    }
  }

  const until = opts.until ?? now;
  const since = opts.since ?? (watermark ? new Date(watermark.until) : new Date(now.getTime() - DAY_MS));
  const window = { since: since.toISOString(), until: until.toISOString() };
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    return { status: "failed", counts, window, reason: "invalid window" };
  }
  if (since >= until) {
    return { status: "skipped", counts, window, reason: "empty window" };
  }

  const release = state.acquireLock();
  if (!release) {
    log.warn("another worklog run holds the lock");
    return { status: "locked", counts, window, reason: "another run is in progress" };
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`run exceeded ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });

  const work = async (): Promise<RunResult> => {
    const errors: Record<string, string> = {};
    const sources = (deps.sources ?? allSources).filter((s) => {
      try {
        return s.enabled(config);
      } catch {
        return false;
      }
    });
    const ctx = { since, until, config, log };
    const settled = await Promise.allSettled(sources.map((s) => s.collect(ctx)));
    const byId = new Map<string, Activity>();
    settled.forEach((r, i) => {
      const name = sources[i]!.name;
      if (r.status === "fulfilled") {
        counts[name] = (counts[name] ?? 0) + r.value.length;
        for (const a of r.value) byId.set(a.id, a);
      } else {
        counts[name] = counts[name] ?? 0;
        errors[name] = r.reason instanceof Error ? r.reason.message : String(r.reason);
        log.error(`source ${name} failed`, { error: errors[name] });
      }
    });
    const activities = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
    log.info("collected activity", { total: activities.length, ...counts });
    if (controller.signal.aborted) throw new TimeoutError("timed out after collecting");

    const knownThreads = state.readThreads();
    const extractor = deps.extractor ?? createExtractor(config, log);
    const digest = await extractor.extract(activities, { config, log, window: { since, until }, knownThreads });
    if (controller.signal.aborted) throw new TimeoutError("timed out after extracting");

    const threads = mergeThreads(knownThreads, digest.threads);
    const report = writeDigest(digest, { config, now, threads, dryRun: opts.dryRun });
    const failed = Object.keys(errors).length > 0;
    if (!opts.dryRun) {
      state.writeThreads(threads);
      if (!failed) state.writeWatermark(until, opts.now ?? new Date());
    }
    return {
      status: failed ? "failed" : "ok",
      report,
      digest,
      counts,
      window,
      ...(failed ? { errors, reason: `source failed: ${Object.keys(errors).join(", ")}` } : {}),
    };
  };

  try {
    return await Promise.race([work(), timeout]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("run failed", { error: message });
    return { status: "failed", counts, window, errors: { run: message }, reason: message };
  } finally {
    clearTimeout(timer);
    controller.abort();
    release();
  }
}
