import { createReadStream, existsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { clean, redact, truncate } from "../redact.js";
import type { Activity, Config, SourceName } from "../types.js";

export const ASSISTANT_CAP = 1500;
export const TITLE_CAP = 100;

export function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Streams a JSONL file, skipping blank and malformed lines. Returns the number of bad lines. */
export async function readJsonl(file: string, onRecord: (rec: Record<string, unknown>) => void): Promise<number> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let bad = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    if (rec && typeof rec === "object" && !Array.isArray(rec)) onRecord(rec as Record<string, unknown>);
  }
  return bad;
}

/** First user text in a JSONL transcript; stops reading once found. */
export async function firstUserText(
  file: string,
  pick: (rec: Record<string, unknown>) => string | undefined,
): Promise<string | undefined> {
  const input = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
      const text = pick(rec as Record<string, unknown>);
      if (text) return text;
    }
    return undefined;
  } finally {
    rl.close();
    input.destroy();
  }
}

const MIN_TEMPLATE_CHARS = 200;

/** Normalised opening of a prompt, or undefined when it's too short to be a reusable template. */
export function promptFingerprint(text: string): string | undefined {
  const norm = text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  return norm.length >= MIN_TEMPLATE_CHARS ? norm.slice(0, 400) : undefined;
}

export interface ChatCandidate {
  activity: Activity;
  file: string;
  /** Folder whose other transcripts are compared against this one. */
  group: string;
}

/**
 * Drop chats started by a scheduled agent rather than a person. Such jobs send
 * the same long prompt every run, so a chat whose opening matches another
 * transcript in the same folder is treated as automated.
 */
export async function dropAutomatedChats(opts: {
  candidates: ChatCandidate[];
  siblings: (group: string) => Promise<string[]>;
  pick: (rec: Record<string, unknown>) => string | undefined;
  ignorePatterns: string[];
}): Promise<{ kept: Activity[]; dropped: number }> {
  const patterns = opts.ignorePatterns.map((p) => new RegExp(p, "i"));
  const openings = new Map<string, string | undefined>();
  const openingOf = async (file: string) => {
    if (!openings.has(file)) openings.set(file, await firstUserText(file, opts.pick).catch(() => undefined));
    return openings.get(file);
  };

  const counts = new Map<string, Map<string, number>>();
  const countsFor = async (group: string) => {
    let c = counts.get(group);
    if (c) return c;
    c = new Map();
    const files = await opts.siblings(group);
    const prints = await mapLimit(files, 16, async (f) => promptFingerprint((await openingOf(f)) ?? ""));
    for (const p of prints) if (p) c.set(p, (c.get(p) ?? 0) + 1);
    counts.set(group, c);
    return c;
  };

  const kept: Activity[] = [];
  let dropped = 0;
  for (const cand of opts.candidates) {
    const opening = (await openingOf(cand.file)) ?? "";
    if (patterns.some((re) => re.test(opening))) {
      dropped++;
      continue;
    }
    const print = promptFingerprint(opening);
    if (print && ((await countsFor(cand.group)).get(print) ?? 0) >= 2) {
      dropped++;
      continue;
    }
    kept.push(cand.activity);
  }
  return { kept, dropped };
}

/** Files in `dir` ending in `.jsonl` (or `<name>/<name>.jsonl`), newest first, modified within `days` before `end`. */
export async function recentJsonl(dir: string, days: number, end: Date, cap = 300): Promise<string[]> {
  const cutoff = end.getTime() - days * 86_400_000;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: Array<{ file: string; mtime: number }> = [];
  for (const e of entries) {
    const file = e.isDirectory() ? join(dir, e.name, `${e.name}.jsonl`) : e.name.endsWith(".jsonl") ? join(dir, e.name) : "";
    if (!file) continue;
    try {
      const st = await stat(file);
      if (st.isFile() && st.mtimeMs >= cutoff) found.push({ file, mtime: st.mtimeMs });
    } catch {
      // folder without a transcript
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, cap).map((f) => f.file);
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Text blocks from a message `content` that is either a string or an array of `{type, text}` blocks. */
export function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string") out.push(t);
    }
  }
  return out;
}

export function oneLine(text: string, max = TITLE_CAP): string {
  const line = redact(text).replace(/\s+/g, " ").trim();
  return line.length <= max ? line : line.slice(0, max - 1).trimEnd() + "…";
}

export interface Turn {
  at?: Date;
  user: string;
  /** Last assistant text reply that followed this user turn. */
  assistant?: string;
}

/**
 * Collects user turns and the assistant replies that follow them. Stored text is
 * capped on the way in so a huge transcript can't blow up memory.
 */
export class TurnLog {
  readonly turns: Turn[] = [];
  constructor(private readonly userCap: number) {}

  user(text: string, at?: Date): void {
    this.turns.push({ user: truncate(text, this.userCap), at });
  }

  assistant(text: string): void {
    const last = this.turns[this.turns.length - 1];
    if (last && text.trim()) last.assistant = truncate(text.trim(), ASSISTANT_CAP * 2);
  }
}

/**
 * Turns without a timestamp inherit the previous turn's; leading ones take the first
 * known timestamp. With no timestamps at all, every turn gets `fallback`.
 */
export function selectInWindow(turns: Turn[], since: Date, until: Date, fallback: Date): Array<Turn & { at: Date }> {
  const firstKnown = turns.find((t) => t.at)?.at;
  let prev = firstKnown ?? fallback;
  const dated = turns.map((t) => {
    const at = t.at ?? prev;
    prev = at;
    return { ...t, at };
  });
  return dated.filter((t) => t.at.getTime() >= since.getTime() && t.at.getTime() < until.getTime());
}

export function buildChatActivity(opts: {
  source: SourceName;
  sessionId: string;
  project?: string;
  turns: Array<Turn & { at: Date }>;
  config: Config;
}): Activity | undefined {
  const { turns, config } = opts;
  const last = turns[turns.length - 1];
  const first = turns[0];
  if (!first || !last) return undefined;
  const max = config.limits.maxActivityChars;

  const reply = [...turns].reverse().find((t) => t.assistant)?.assistant;
  const assistantPart = reply ? `ASSISTANT: ${truncate(redact(reply), ASSISTANT_CAP)}` : "";
  const userPart = turns.map((t) => `USER: ${t.user}`).join("\n\n");
  const userBudget = Math.max(200, max - assistantPart.length - 40);
  const body = [truncate(userPart, userBudget), assistantPart].filter(Boolean).join("\n\n");

  const iso = last.at.toISOString();
  return {
    id: `${opts.source}:${opts.sessionId}:${iso}`,
    source: opts.source,
    kind: "chat",
    at: iso,
    title: oneLine(first.user),
    text: clean(body, max),
    project: opts.project,
    threadId: opts.sessionId,
    participants: [],
    fromMe: true,
    meta: { userTurns: turns.length },
  };
}
