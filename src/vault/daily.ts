import type { Contact, Digest } from "../types.js";
import { addDays, isoWeekStart } from "./dates.js";
import { freshItems, linkTitle, openThreads, type VaultContext } from "./context.js";
import {
  appendUnderHeading,
  blockLines,
  findBlock,
  oneLine,
  renderBlock,
  replaceBlock,
  sanitizeNoteName,
  upsertBlock,
  wikiLink,
} from "./markdown.js";

const DAILY_SECTIONS = [
  { heading: "## Progress", key: "progress", pick: (d: Digest) => d.progress },
  { heading: "## Actions taken", key: "actions", pick: (d: Digest) => d.actions },
  { heading: "## Open questions", key: "questions", pick: (d: Digest) => d.openQuestions },
  { heading: "## Noticed", key: "noticed", pick: (d: Digest) => d.noticed },
] as const;

export function dailyPath(ctx: VaultContext, ymd = ctx.today): string {
  return `${ctx.folders.log}/${ymd}.md`;
}

function newDailyNote(ctx: VaultContext): string {
  return [
    `Week [[${ctx.week}]] · [[${ctx.dashboardName}]]`,
    "",
    ...DAILY_SECTIONS.flatMap((s) => [s.heading, ""]),
    "## People",
    "",
  ].join("\n");
}

export function visibleContacts(ctx: VaultContext, contacts: Contact[]): Contact[] {
  const me = sanitizeNoteName(ctx.config.me.name || "").toLowerCase();
  const myEmails = new Set(ctx.config.me.emails.map((e) => e.toLowerCase()));
  return contacts.filter(
    (c) =>
      oneLine(c.name) !== "" &&
      !ctx.dropped.has(c.category) &&
      sanitizeNoteName(c.name).toLowerCase() !== me &&
      !(c.email && myEmails.has(c.email.toLowerCase()))
  );
}

function hasLink(lines: string[], name: string): boolean {
  const link = wikiLink(name).toLowerCase();
  return lines.some((l) => l.toLowerCase().includes(link));
}

export function writeDaily(ctx: VaultContext, digest: Digest): void {
  const rel = dailyPath(ctx);
  const existing = ctx.fs.read(rel);
  let text = existing ?? newDailyNote(ctx);
  let added = 0;

  for (const s of DAILY_SECTIONS) {
    const items = freshItems(text, s.pick(digest) ?? []);
    added += items.length;
    text = appendUnderHeading(text, s.heading, s.key, items.map((i) => `- ${i}`));
  }

  const peopleBlock = blockLines(text, "people");
  const peopleLines: string[] = [];
  for (const c of visibleContacts(ctx, digest.contacts)) {
    if (hasLink([...peopleBlock, ...peopleLines], c.name)) continue;
    const company = c.company ? ` (${oneLine(c.company)})` : "";
    const summary = c.summary ? ` — ${oneLine(c.summary)}` : "";
    const [line] = freshItems(text, [`${wikiLink(c.name)}${company}${summary}`]);
    if (line) peopleLines.push(`- ${line}`);
  }
  added += peopleLines.length;
  text = appendUnderHeading(text, "## People", "people", peopleLines);

  if (existing === null && added === 0) return;
  ctx.fs.write(rel, text);
}

function newWeeklyNote(daysLine: string): string {
  return [renderBlock("days", daysLine), "", "## Shipped", "", "## Still open", "", "## People this week", ""].join(
    "\n"
  );
}

/** Replace the block under `heading`, creating it there on first use. */
function setUnderHeading(text: string, heading: string, key: string, lines: string[]): string {
  if (findBlock(text, key)) return replaceBlock(text, key, lines.join("\n"))!;
  return appendUnderHeading(text, heading, key, lines);
}

export function writeWeekly(ctx: VaultContext, digest: Digest): void {
  const rel = `${ctx.folders.log}/${ctx.week}.md`;
  const monday = isoWeekStart(ctx.today);
  const weekDays = new Set(Array.from({ length: 7 }, (_, i) => addDays(monday, i)));
  const days = ctx.fs
    .listNotes(ctx.folders.log)
    .map((p) => p.slice(p.lastIndexOf("/") + 1, -3))
    .filter((d) => weekDays.has(d));
  const daysLine = `Days: ${days.map((d) => `[[${d}]]`).join(" · ")} · [[${ctx.dashboardName}]]`;

  let text = ctx.fs.read(rel) ?? newWeeklyNote(daysLine);
  text = upsertBlock(text, "days", daysLine);

  const shipped: string[] = [];
  for (const p of digest.projects) {
    if (p.status === "shipped") shipped.push(`${wikiLink(p.name)} — ${oneLine(p.summary)}`);
    for (const line of p.progress) {
      if (/\bshipped\b|#shipped/i.test(line)) shipped.push(`${wikiLink(p.name)}: ${oneLine(line)}`);
    }
  }
  for (const line of digest.progress) if (/\bshipped\b|#shipped/i.test(line)) shipped.push(line);
  text = appendUnderHeading(text, "## Shipped", "shipped", freshItems(text, shipped).map((s) => `- ${s}`));

  const open = openThreads(ctx);
  const openLines = [
    ...open.filter((t) => t.waitingOn === "me").map((t) => ({ t, who: "Waiting on me" })),
    ...open.filter((t) => t.waitingOn === "them").map((t) => ({ t, who: "Waiting on them" })),
  ].map(({ t, who }) => `- ${who}: ${wikiLink(t.counterpart)} — ${linkTitle(t.title, t.url)} (${t.age}d)`);
  text = setUnderHeading(text, "## Still open", "open", openLines);

  const peopleBlock = blockLines(text, "people-week");
  const people: string[] = [];
  for (const c of visibleContacts(ctx, digest.contacts)) {
    if (hasLink([...peopleBlock, ...people], c.name)) continue;
    people.push(`- ${wikiLink(c.name)}${c.company ? ` (${oneLine(c.company)})` : ""}`);
  }
  text = appendUnderHeading(text, "## People this week", "people-week", people);

  ctx.fs.write(rel, text);
}
