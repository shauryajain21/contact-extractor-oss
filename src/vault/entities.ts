import type { Company, Contact, Digest, ProjectUpdate } from "../types.js";
import { localDate } from "./dates.js";
import { notePath, refLink, type VaultContext } from "./context.js";
import { visibleContacts } from "./daily.js";
import {
  appendUnderHeading,
  blockLines,
  findBlock,
  mergeFrontmatter,
  normalizeLine,
  oneLine,
  readFrontmatter,
  replaceBlock,
  wikiLink,
} from "./markdown.js";

const TIMELINE_CAP = 50;
const PROGRESS_CAP = 200;
const DATED = /^- (\d{4}-\d{2}-\d{2}) · /;

/**
 * New lines first, then existing, deduped on normalized text and ordered
 * newest date first; the sort is stable so same-day order is preserved.
 */
export function mergeDated(existing: string[], added: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of [...added, ...existing]) {
    const key = normalizeLine(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  const dateOf = (l: string) => DATED.exec(l)?.[1] ?? "";
  return out
    .map((line, i) => ({ line, i, d: dateOf(line) }))
    .sort((a, b) => (a.d === b.d ? a.i - b.i : b.d.localeCompare(a.d)))
    .slice(0, cap)
    .map((x) => x.line);
}

/** Rewrite (or create under `heading`) a block holding dated lines. */
function writeDatedBlock(text: string, heading: string, key: string, added: string[], cap: number): string {
  const merged = mergeDated(blockLines(text, key), added, cap);
  if (findBlock(text, key)) return replaceBlock(text, key, merged.join("\n"))!;
  return appendUnderHeading(text, heading, key, merged);
}

function laterDate(current: unknown, next: string): string {
  return typeof current === "string" && current > next ? current : next;
}

function writePerson(ctx: VaultContext, c: Contact): void {
  const rel = notePath(ctx.folders.people, c.name);
  const existing = ctx.fs.read(rel);
  const seen = localDate(c.lastSeen, ctx.timeZone) || ctx.today;
  let text = existing ?? (c.company ? `Company: ${wikiLink(c.company)}\n` : "");
  const fm = readFrontmatter(text);
  text = mergeFrontmatter(
    text,
    {
      email: c.email,
      company: c.company ? oneLine(c.company) : undefined,
      category: c.category,
      last_seen: laterDate(fm.last_seen, seen),
    },
    ["worklog/person"]
  );
  const line = `- ${seen} · ${oneLine(c.summary || "seen")}${refLink(c.refs)}`;
  text = writeDatedBlock(text, "## Timeline", "timeline", [line], TIMELINE_CAP);
  ctx.fs.write(rel, text);
}

function writeCompany(ctx: VaultContext, co: Company, contacts: Contact[]): void {
  const rel = notePath(ctx.folders.companies, co.name);
  const existing = ctx.fs.read(rel);
  const related = contacts.filter(
    (c) => co.contacts.includes(c.name) || (c.company && c.company.toLowerCase() === co.name.toLowerCase())
  );
  const seen =
    related.map((c) => localDate(c.lastSeen, ctx.timeZone)).filter(Boolean).sort().pop() ?? ctx.today;
  let text = existing ?? "";
  const fm = readFrontmatter(text);
  text = mergeFrontmatter(
    text,
    { domain: co.domain, category: co.category, last_seen: laterDate(fm.last_seen, seen) },
    ["worklog/company"]
  );

  const names = new Set([...co.contacts, ...related.map((c) => c.name)].map((n) => oneLine(n)).filter(Boolean));
  const current = blockLines(text, "people");
  const have = new Set(current.map((l) => l.toLowerCase()));
  const peopleAdd = [...names]
    .map((n) => `- ${wikiLink(n)}`)
    .filter((l) => !have.has(l.toLowerCase()));
  if (findBlock(text, "people")) {
    const all = [...current, ...peopleAdd].sort((a, b) => a.localeCompare(b));
    text = replaceBlock(text, "people", all.join("\n"))!;
  } else {
    text = appendUnderHeading(text, "## People", "people", peopleAdd.sort((a, b) => a.localeCompare(b)));
  }

  if (co.summary) {
    const line = `- ${seen} · ${oneLine(co.summary)}${refLink(co.refs)}`;
    text = writeDatedBlock(text, "## Timeline", "timeline", [line], TIMELINE_CAP);
  }
  ctx.fs.write(rel, text);
}

function writeProject(ctx: VaultContext, p: ProjectUpdate): void {
  const rel = notePath(ctx.folders.projects, p.name);
  let text = ctx.fs.read(rel) ?? "";
  text = mergeFrontmatter(text, { status: p.status, last_update: ctx.today });
  const statusLine = `**${p.status}** — ${oneLine(p.summary)}`;
  text = findBlock(text, "status")
    ? replaceBlock(text, "status", statusLine)!
    : appendUnderHeading(text, "## Status", "status", [statusLine]);
  const lines = p.progress.map(oneLine).filter(Boolean).map((l) => `- ${ctx.today} · ${l}`);
  if (lines.length || !findBlock(text, "progress")) {
    text = writeDatedBlock(text, "## Progress log", "progress", lines, PROGRESS_CAP);
  }
  ctx.fs.write(rel, text);
}

export function writeEntities(ctx: VaultContext, digest: Digest): void {
  const contacts = visibleContacts(ctx, digest.contacts);
  for (const c of contacts) writePerson(ctx, c);
  for (const co of digest.companies) {
    if (!oneLine(co.name) || ctx.dropped.has(co.category)) continue;
    writeCompany(ctx, co, contacts);
  }
  for (const p of digest.projects) {
    if (!oneLine(p.name)) continue;
    writeProject(ctx, p);
  }
}
