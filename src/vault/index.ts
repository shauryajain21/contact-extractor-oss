import { existsSync } from "node:fs";
import type { Config, Digest, ThreadState, WriteReport } from "../types.js";
import { createContext } from "./context.js";
import { writeDashboard } from "./dashboard.js";
import { writeDaily, writeWeekly } from "./daily.js";
import { writeEntities } from "./entities.js";
import { VaultFs } from "./fs.js";

export interface WriteOptions {
  config: Config;
  now: Date;
  /** Merged thread map (previous runs plus this digest); drives the waiting tables. */
  threads: Record<string, ThreadState>;
  dryRun?: boolean;
}

export function writeDigest(digest: Digest, opts: WriteOptions): WriteReport {
  if (!existsSync(opts.config.vault)) {
    throw new Error(`Vault folder not found: ${opts.config.vault}`);
  }
  const fs = new VaultFs(opts.config.vault);
  const ctx = createContext(fs, opts.config, opts.now, opts.threads);
  writeDaily(ctx, digest);
  writeWeekly(ctx, digest);
  writeEntities(ctx, digest);
  writeDashboard(ctx);
  const report = fs.report();
  if (!opts.dryRun) fs.flush();
  return report;
}

export { localDate, isoWeek, isoWeekName } from "./dates.js";
export { sanitizeNoteName } from "./markdown.js";
