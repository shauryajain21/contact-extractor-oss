import { readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Activity, CollectContext, Config, Source } from "../types.js";
import {
  buildChatActivity,
  type ChatCandidate,
  dropAutomatedChats,
  isDir,
  mapLimit,
  readJsonl,
  recentJsonl,
  selectInWindow,
  textBlocks,
  TurnLog,
} from "./local-util.js";

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const TS_RE =
  /^(?:[A-Za-z]+,\s*)?([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*(\((?:UTC|GMT)\s*(?:([+-])(\d{1,2})(?::?(\d{2}))?)?\))?/;

/** Parses `Friday, Sep 4, 2026, 12:26 PM (UTC-4)`. Without a zone suffix the time is taken as local. */
export function parseCursorTimestamp(value: string): Date | undefined {
  const s = value.trim();
  const m = TS_RE.exec(s);
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : new Date(t);
  }
  const [, mon, day, year, hh, mm, ss, ampm, zone, sign, offH, offM] = m;
  const month = MONTHS[(mon ?? "").slice(0, 3).toLowerCase()];
  if (month === undefined) return undefined;
  let hour = Number(hh);
  if (ampm) {
    const pm = ampm.toLowerCase() === "pm";
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  const parts = [Number(year), month, Number(day), hour, Number(mm), Number(ss ?? 0)] as const;
  if (!zone) return new Date(...parts);
  const offsetMin = sign ? (sign === "-" ? -1 : 1) * (Number(offH) * 60 + Number(offM ?? 0)) : 0;
  return new Date(Date.UTC(...parts) - offsetMin * 60_000);
}

const WRAPPER_TAGS = [
  "timestamp",
  "attached_files",
  "system_reminder",
  "system-reminder",
  "image_files",
  "side_chat_boundary",
  "user_info",
  "rules",
  "agent_skills",
  "open_and_recently_viewed_files",
  "git_status",
  "manually_added_selection",
  "cursor_commands",
  "additional_data",
  "user_query",
];
const TAG_ALT = WRAPPER_TAGS.map((t) => t.replace(/-/g, "\\-")).join("|");
const PAIRED_RE = new RegExp(`<(${TAG_ALT})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`, "g");
const LONE_RE = new RegExp(`</?(?:${TAG_ALT})(?:\\s[^>]*)?/?>`, "g");
const BOUNDARY_RE = /<\/?side_chat_boundary\s*\/?>/g;

export function extractUserQuery(raw: string): string {
  const open = raw.indexOf("<user_query>");
  const close = raw.lastIndexOf("</user_query>");
  let body = open >= 0 && close > open ? raw.slice(open + "<user_query>".length, close) : raw;
  if (open < 0) body = body.replace(PAIRED_RE, "").replace(LONE_RE, "");
  else body = body.replace(PAIRED_RE, (block, tag: string) => (tag === "user_query" ? block : "")).replace(BOUNDARY_RE, "");
  return body.replace(/\n{3,}/g, "\n\n").trim();
}

function timestampOf(raw: string): Date | undefined {
  const m = /<timestamp>([^<]*)<\/timestamp>/.exec(raw);
  return m?.[1] ? parseCursorTimestamp(m[1]) : undefined;
}

const CONTAINER_DIRS = new Set([
  "projects", "project", "code", "src", "dev", "repos", "repo", "git", "github", "work", "workspace",
  "workspaces", "documents", "desktop", "tmp", "sandbox", "archive", "downloads", "sites",
]);

const normalize = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Cursor slugs are absolute paths with every non-alphanumeric run replaced by `-`, so resolve them against disk. */
function resolveSlugOnDisk(slug: string, fsRoot: string): string | undefined {
  let budget = 200;
  const walk = (dir: string, rest: string): string | undefined => {
    if (budget-- <= 0) return undefined;
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => d.name)
        .sort((a, b) => b.length - a.length);
    } catch {
      return undefined;
    }
    for (const name of names) {
      const n = normalize(name);
      if (!n) continue;
      if (rest === n) {
        const full = join(dir, name);
        try {
          if (statSync(full).isDirectory()) return full;
        } catch {
          continue;
        }
      }
      if (rest.startsWith(n + "-")) {
        const found = walk(join(dir, name), rest.slice(n.length + 1));
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(fsRoot, slug);
}

const slugCache = new Map<string, string | undefined>();

export function projectFromSlug(slug: string, home: string = homedir(), fsRoot = "/"): string | undefined {
  const key = `${fsRoot}\0${home}\0${slug}`;
  if (slugCache.has(key)) return slugCache.get(key);
  const result = computeProject(slug, home, fsRoot);
  slugCache.set(key, result);
  return result;
}

function computeProject(slug: string, home: string, fsRoot: string): string | undefined {
  const rest = slug.replace(/^-+/, "");
  if (!rest || rest === "empty-window") return undefined;
  const homeSlug = normalize(home.startsWith(fsRoot) ? home.slice(fsRoot.length) : home);
  if (rest === homeSlug) return undefined;

  const onDisk = resolveSlugOnDisk(rest, fsRoot);
  if (onDisk) {
    const homeOnDisk = join(fsRoot, home.startsWith(fsRoot) ? home.slice(fsRoot.length) : home);
    return onDisk === homeOnDisk ? undefined : basename(onDisk);
  }

  let tail = homeSlug && rest.startsWith(homeSlug + "-") ? rest.slice(homeSlug.length + 1) : rest;
  if (tail === rest) {
    const foreignHome = /^(?:Users|home)-[^-]+(?:-(.*))?$/.exec(rest);
    if (foreignHome) {
      if (!foreignHome[1]) return undefined;
      tail = foreignHome[1];
    }
  }
  const segs = tail.split("-");
  if (segs.length > 1 && CONTAINER_DIRS.has((segs[0] ?? "").toLowerCase())) tail = segs.slice(1).join("-");
  return tail || undefined;
}

interface TranscriptFile {
  file: string;
  slug: string;
  chatId: string;
  mtime: Date;
}

async function findTranscripts(root: string, since: Date, ctx: CollectContext): Promise<TranscriptFile[]> {
  const out: TranscriptFile[] = [];
  let slugs: string[];
  try {
    slugs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    ctx.log.warn("cursor: cannot read projects dir", { root, error: String(err) });
    return out;
  }
  for (const slug of slugs) {
    const dir = join(root, slug, "agent-transcripts");
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      let file: string;
      let chatId: string;
      if (e.isDirectory()) {
        chatId = e.name;
        file = join(dir, e.name, `${e.name}.jsonl`);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        chatId = e.name.slice(0, -".jsonl".length);
        file = join(dir, e.name);
      } else continue;
      try {
        const st = await stat(file);
        if (st.isFile() && st.mtime.getTime() >= since.getTime()) out.push({ file, slug, chatId, mtime: st.mtime });
      } catch {
        // chat folder without a transcript yet
      }
    }
  }
  return out;
}

function cursorUserText(rec: Record<string, unknown>): string | undefined {
  if (rec.role !== "user") return undefined;
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  return extractUserQuery(textBlocks(content).join("\n")) || undefined;
}

export async function parseCursorTranscript(
  t: TranscriptFile,
  since: Date,
  until: Date,
  config: Config,
): Promise<Activity | undefined> {
  const turns = new TurnLog(config.limits.maxActivityChars);
  await readJsonl(t.file, (rec) => {
    const content = (rec.message as { content?: unknown } | undefined)?.content;
    if (rec.role === "user") {
      const raw = textBlocks(content).join("\n");
      const text = extractUserQuery(raw);
      if (text) turns.user(text, timestampOf(raw));
    } else if (rec.role === "assistant") {
      const text = textBlocks(content).join("\n").trim();
      if (text) turns.assistant(text);
    }
  });
  const inWindow = selectInWindow(turns.turns, since, until, t.mtime);
  return buildChatActivity({
    source: "cursor",
    sessionId: t.chatId,
    project: projectFromSlug(t.slug),
    turns: inWindow,
    config,
  });
}

export const cursorSource: Source = {
  name: "cursor",
  enabled(config) {
    return config.sources.cursor.enabled && isDir(config.sources.cursor.path);
  },
  async collect(ctx) {
    const root = ctx.config.sources.cursor.path;
    if (!isDir(root)) return [];
    const files = await findTranscripts(root, ctx.since, ctx);
    const results = await mapLimit(files, 8, async (t): Promise<ChatCandidate | undefined> => {
      try {
        const activity = await parseCursorTranscript(t, ctx.since, ctx.until, ctx.config);
        return activity && { activity, file: t.file, group: join(root, t.slug, "agent-transcripts") };
      } catch (err) {
        ctx.log.warn("cursor: skipping unreadable transcript", { file: t.file, error: String(err) });
        return undefined;
      }
    });
    const { kept, dropped } = await dropAutomatedChats({
      candidates: results.filter((c): c is ChatCandidate => c !== undefined),
      siblings: (dir) => recentJsonl(dir, 14, ctx.until),
      pick: cursorUserText,
      ignorePatterns: ctx.config.sources.cursor.ignorePatterns ?? [],
    });
    if (dropped) ctx.log.info("cursor: skipped scheduled or ignored chats", { dropped });
    return kept;
  },
};
