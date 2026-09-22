import { addDays, daysBetween, localDate, localDateTime } from "./dates.js";
import { linkTitle, openThreads, type VaultContext } from "./context.js";
import { blockLines, escapeCell, readFrontmatter, sanitizeNoteName, upsertBlock, wikiLink } from "./markdown.js";

function table(header: string[], rows: string[][], empty: string): string[] {
  if (rows.length === 0) return [`_${empty}_`];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ];
}

const cellLink = (name?: string) => (name ? wikiLink(name) : "");

function waitingRows(ctx: VaultContext, side: "me" | "them"): string[][] {
  return openThreads(ctx)
    .filter((t) => t.waitingOn === side)
    .map((t) => [
      cellLink(t.counterpart),
      cellLink(t.company),
      escapeCell(linkTitle(t.title, t.url)),
      localDate(t.since, ctx.timeZone),
      String(t.age),
    ]);
}

function noteName(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function projectRows(ctx: VaultContext): string[][] {
  const rows: Array<{ date: string; row: string[] }> = [];
  for (const rel of ctx.fs.listNotes(ctx.folders.projects)) {
    const text = ctx.fs.read(rel) ?? "";
    const fm = readFrontmatter(text);
    const status = str(fm.status);
    const date = str(fm.last_update);
    if (status !== "active" && status !== "blocked") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || daysBetween(date, ctx.today) > 30) continue;
    const latest = (blockLines(text, "progress")[0] ?? "").replace(/^- (\d{4}-\d{2}-\d{2} · )?/, "");
    rows.push({ date, row: [`[[${noteName(rel)}]]`, status, date, escapeCell(latest)] });
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.row[0]!.localeCompare(b.row[0]!)).map((r) => r.row);
}

function peopleRows(ctx: VaultContext): string[][] {
  const cutoff = addDays(ctx.today, -6);
  const people = new Map<string, { name: string; company: string; date: string }>();
  const add = (name: string, company: string, date: string) => {
    if (!name || !date || date < cutoff || date > ctx.today) return;
    const key = sanitizeNoteName(name).toLowerCase();
    const prev = people.get(key);
    if (!prev || prev.date < date) people.set(key, { name, company: company || prev?.company || "", date });
  };
  for (const rel of ctx.fs.listNotes(ctx.folders.people)) {
    const fm = readFrontmatter(ctx.fs.read(rel) ?? "");
    if (ctx.dropped.has(str(fm.category) as never)) continue;
    add(noteName(rel), str(fm.company), str(fm.last_seen));
  }
  for (const t of Object.values(ctx.threads)) {
    if (ctx.dropped.has(t.category)) continue;
    add(t.counterpart, t.company ?? "", localDate(t.lastActivityAt, ctx.timeZone));
  }
  return [...people.values()]
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name))
    .slice(0, 50)
    .map((p) => [cellLink(p.name), cellLink(p.company), p.date]);
}

export function writeDashboard(ctx: VaultContext): void {
  const threadHeader = ["Who", "Company", "Thread", "Since", "Days"];
  const inner = [
    `_Updated ${localDateTime(ctx.now, ctx.timeZone)} (${ctx.timeZone}) by worklog. Edits inside this block are replaced on the next run._`,
    "",
    "### Waiting on me",
    ...table(threadHeader, waitingRows(ctx, "me"), "Nothing waiting on you."),
    "",
    "### Waiting on them",
    ...table(threadHeader, waitingRows(ctx, "them"), "Nobody owes you a reply."),
    "",
    "### Active projects",
    ...table(["Project", "Status", "Last update", "Latest"], projectRows(ctx), "No active projects."),
    "",
    "### People this week",
    ...table(["Who", "Company", "Last seen"], peopleRows(ctx), "Nobody in the last 7 days."),
  ].join("\n");
  const existing = ctx.fs.read(ctx.dashboardPath) ?? "";
  ctx.fs.write(ctx.dashboardPath, upsertBlock(existing, "dashboard", inner));
}
