import type { Category, Config, Ref, ThreadState } from "../types.js";
import { daysBetween, isoWeekName, localDate } from "./dates.js";
import type { VaultFs } from "./fs.js";
import { normalizeLine, oneLine, sanitizeNoteName } from "./markdown.js";

export interface VaultContext {
  fs: VaultFs;
  config: Config;
  now: Date;
  timeZone: string;
  today: string;
  week: string;
  folders: { log: string; people: string; companies: string; projects: string };
  dashboardPath: string;
  dashboardName: string;
  threads: Record<string, ThreadState>;
  dropped: Set<Category>;
}

const DEFAULT_FOLDERS = { log: "Log", people: "People", companies: "Companies", projects: "Projects" };

/** Vault-relative folder; an empty setting falls back to the default so nothing lands at the root. */
function folder(value: string | undefined, fallback: string): string {
  const parts = (value ?? "")
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..")
    .map(sanitizeNoteName);
  return parts.length ? parts.join("/") : fallback;
}

export function createContext(
  fs: VaultFs,
  config: Config,
  now: Date,
  threads: Record<string, ThreadState>
): VaultContext {
  const timeZone = config.timezone || "UTC";
  const today = localDate(now, timeZone);
  const l = config.layout;
  const dashboardPath = (() => {
    const raw = (l.dashboard || "Dashboard.md").replace(/^[\\/]+/, "");
    const withExt = raw.endsWith(".md") ? raw : `${raw}.md`;
    const dir = withExt.includes("/") ? folder(withExt.slice(0, withExt.lastIndexOf("/")), "") : "";
    const base = sanitizeNoteName(withExt.slice(withExt.lastIndexOf("/") + 1).replace(/\.md$/, ""));
    return dir ? `${dir}/${base}.md` : `${base}.md`;
  })();
  return {
    fs,
    config,
    now,
    timeZone,
    today,
    week: isoWeekName(today),
    folders: {
      log: folder(l.log, DEFAULT_FOLDERS.log),
      people: folder(l.people, DEFAULT_FOLDERS.people),
      companies: folder(l.companies, DEFAULT_FOLDERS.companies),
      projects: folder(l.projects, DEFAULT_FOLDERS.projects),
    },
    dashboardPath,
    dashboardName: dashboardPath.slice(dashboardPath.lastIndexOf("/") + 1).replace(/\.md$/, ""),
    threads,
    dropped: new Set(config.filters?.dropCategories ?? []),
  };
}

export function notePath(dir: string, name: string): string {
  return `${dir}/${sanitizeNoteName(name)}.md`;
}

/** Items not already present anywhere in `noteText`, and not repeated within `items`. */
export function freshItems(noteText: string, items: string[]): string[] {
  const seen = new Set(noteText.split(/\r?\n/).map(normalizeLine).filter(Boolean));
  const out: string[] = [];
  for (const raw of items) {
    const item = oneLine(raw).replace(/^[-*+]\s+/, "");
    const key = normalizeLine(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function refLink(refs: Ref[]): string {
  const ref = refs.find((r) => r.url);
  return ref?.url ? ` · [${ref.source}](${ref.url})` : "";
}

/** Threads worth showing: someone owes a move, not a dropped category, touched in the last 30 days. */
export function openThreads(ctx: VaultContext): Array<ThreadState & { age: number }> {
  return Object.values(ctx.threads)
    .filter((t) => t.waitingOn !== "nobody" && !ctx.dropped.has(t.category))
    .filter((t) => {
      const last = localDate(t.lastActivityAt || t.since, ctx.timeZone);
      return last !== "" && daysBetween(last, ctx.today) <= 30;
    })
    .map((t) => ({ ...t, age: Math.max(0, daysBetween(localDate(t.since, ctx.timeZone) || ctx.today, ctx.today)) }))
    .sort((a, b) => b.age - a.age || a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
}

export function linkTitle(title: string, url?: string): string {
  const t = oneLine(title || "(untitled)").replace(/\[/g, "(").replace(/\]/g, ")");
  return url ? `[${t}](${url.replace(/\)/g, "%29").replace(/ /g, "%20")})` : t;
}
