import type {
  Activity,
  Category,
  Company,
  Config,
  Contact,
  Digest,
  ExtractContext,
  Extractor,
  Participant,
  ProjectUpdate,
  ThreadState,
  WaitingOn,
} from "../types.js";
import {
  classifyActivity,
  companyFromEmail,
  domainMatches,
  emailDomain,
  externalParticipants,
  isMe,
  nameFromEmail,
} from "./classify.js";
import {
  type DigestBody,
  dedupeLines,
  finalize,
  normName,
  refOf,
  stripReplyPrefix,
  threadKey,
  time,
  unionRefs,
  windowOf,
} from "./digest.js";

const MAX_PROGRESS_ITEMS = 8;
const TOP_ITEMS_IN_LINE = 3;

export class HeuristicExtractor implements Extractor {
  async extract(activities: Activity[], ctx: ExtractContext): Promise<Digest> {
    return { window: windowOf(ctx), ...heuristicBody(activities, ctx) };
  }
}

export function heuristicBody(activities: Activity[], ctx: ExtractContext): DigestBody {
  const { config } = ctx;
  const drop = new Set(config.filters.dropCategories);
  const categories = new Map<string, Category | null>();
  const kept: Activity[] = [];
  for (const a of [...activities].sort((x, y) => time(x.at) - time(y.at))) {
    const cat = classifyActivity(a, config);
    if (cat && drop.has(cat)) continue;
    categories.set(a.id, cat);
    kept.push(a);
  }
  const categoryOf = (a: Activity): Category => categories.get(a.id) ?? "other";
  const outsiders = (a: Activity) =>
    externalParticipants(a, config).filter((p) => {
      const d = emailDomain(p.email);
      return !d || !domainMatches(d, config.filters.ignoreDomains);
    });

  const projects = buildProjects(kept);
  const contacts = buildContacts(kept, outsiders, categoryOf);
  const companies = buildCompanies(contacts);
  const threads = buildThreads(kept, outsiders, categoryOf, ctx.knownThreads);

  const body = finalize(
    { projects, contacts, companies, threads, progress: [], actions: [], openQuestions: [], noticed: [] },
    config
  );
  return {
    ...body,
    progress: body.projects.map(progressLine),
    actions: buildActions(kept, config, outsiders),
    openQuestions: body.threads.filter((t) => t.waitingOn === "me").map(openQuestionLine),
  };
}

export function displayName(p: Participant): string {
  return p.name?.trim() || (p.email ? nameFromEmail(p.email) : "") || p.handle || "someone";
}

function titleOf(a: Activity): string {
  const t = a.title?.trim() || a.text.split("\n").find((l) => l.trim())?.trim() || "";
  return t.length > 100 ? t.slice(0, 99) + "…" : t;
}

function isConversation(a: Activity): boolean {
  if (a.kind === "email") return true;
  return a.kind === "message" && (a.meta?.isDm === true || a.meta?.isExternal === true);
}

// ---------- projects ----------

function buildProjects(activities: Activity[]): ProjectUpdate[] {
  const byName = new Map<string, { name: string; commits: number; chats: number; items: string[]; acts: Activity[] }>();
  for (const a of activities) {
    if ((a.kind !== "commit" && a.kind !== "chat") || !a.project) continue;
    const key = normName(a.project);
    let acc = byName.get(key);
    if (!acc) {
      acc = { name: a.project, commits: 0, chats: 0, items: [], acts: [] };
      byName.set(key, acc);
    }
    if (a.kind === "commit") acc.commits++;
    else acc.chats++;
    const item = titleOf(a);
    if (item) acc.items.push(item);
    acc.acts.push(a);
  }
  return [...byName.values()].map((acc) => ({
    name: acc.name,
    status: "active",
    summary: counts(acc.commits, acc.chats),
    progress: dedupeLines(acc.items).slice(0, MAX_PROGRESS_ITEMS),
    refs: unionRefs([], acc.acts.map(refOf)),
  }));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function counts(commits: number, chats: number): string {
  return [commits && plural(commits, "commit"), chats && plural(chats, "chat")].filter(Boolean).join(", ");
}

function progressLine(p: ProjectUpdate): string {
  const top = p.progress.slice(0, TOP_ITEMS_IN_LINE).join("; ");
  return top ? `${p.name}: ${p.summary} — ${top}` : `${p.name}: ${p.summary}`;
}

// ---------- contacts & companies ----------

function contactKey(p: Participant): string {
  return p.email ? `e:${p.email.toLowerCase()}` : `n:${normName(displayName(p))}`;
}

function buildContacts(
  activities: Activity[],
  outsiders: (a: Activity) => Participant[],
  categoryOf: (a: Activity) => Category
): Contact[] {
  const byKey = new Map<string, Contact>();
  for (const a of activities) {
    if (a.kind !== "message" && a.kind !== "email" && a.kind !== "event") continue;
    const cat = categoryOf(a);
    for (const p of outsiders(a)) {
      const key = contactKey(p);
      const prev = byKey.get(key);
      const company = p.email ? companyFromEmail(p.email) : null;
      const next: Contact = {
        name: displayName(p),
        ...(p.email ? { email: p.email.toLowerCase() } : {}),
        ...(company ? { company: company.name, domain: company.domain } : {}),
        category: cat,
        summary: titleOf(a),
        lastSeen: a.at,
        refs: [refOf(a)],
      };
      if (!prev) {
        byKey.set(key, next);
        continue;
      }
      // Activities arrive sorted by time, so `next` is the newer sighting.
      byKey.set(key, {
        ...prev,
        name: p.name?.trim() ? next.name : prev.name,
        category: cat !== "other" ? cat : prev.category,
        summary: next.summary || prev.summary,
        lastSeen: next.lastSeen,
        refs: unionRefs(prev.refs, next.refs),
      });
    }
  }
  return [...byKey.values()];
}

function buildCompanies(contacts: Contact[]): Company[] {
  const byDomain = new Map<string, Company & { lastSeen: string }>();
  for (const c of contacts) {
    if (!c.domain || !c.company) continue;
    const prev = byDomain.get(c.domain);
    if (!prev) {
      byDomain.set(c.domain, {
        name: c.company,
        domain: c.domain,
        category: c.category,
        summary: `${c.name}: ${c.summary}`,
        contacts: [c.name],
        refs: [...c.refs],
        lastSeen: c.lastSeen,
      });
      continue;
    }
    const newer = time(c.lastSeen) >= time(prev.lastSeen);
    prev.contacts = dedupeLines([...prev.contacts, c.name]);
    prev.refs = unionRefs(prev.refs, c.refs);
    if (prev.category === "other" || (newer && c.category !== "other")) prev.category = c.category;
    if (newer) {
      prev.summary = `${c.name}: ${c.summary}`;
      prev.lastSeen = c.lastSeen;
    }
  }
  return [...byDomain.values()].map(({ lastSeen: _lastSeen, ...company }) => company);
}

// ---------- threads ----------

/** When the current run of messages from the same side began. */
export function waitingSince(sorted: Activity[], waitingOn: WaitingOn): string {
  const last = sorted[sorted.length - 1];
  if (!last) return "";
  if (waitingOn === "nobody") return last.at;
  const fromMe = waitingOn === "them";
  let since = last.at;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const a = sorted[i]!;
    if (a.fromMe !== fromMe) break;
    since = a.at;
  }
  return since;
}

function counterpartOf(a: Activity, outsiders: Participant[]): Participant | undefined {
  const order = a.fromMe ? ["to", "cc", "attendee", "from"] : ["from", "to", "cc", "attendee"];
  for (const role of order) {
    const p = outsiders.find((x) => x.role === role);
    if (p) return p;
  }
  return outsiders[0];
}

function buildThreads(
  activities: Activity[],
  outsiders: (a: Activity) => Participant[],
  categoryOf: (a: Activity) => Category,
  known: Record<string, ThreadState>
): ThreadState[] {
  const groups = new Map<string, Activity[]>();
  for (const a of activities) {
    if (!isConversation(a) || outsiders(a).length === 0) continue;
    const key = threadKey(a);
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const threads: ThreadState[] = [];
  for (const [id, acts] of groups) {
    const last = acts[acts.length - 1]!;
    const first = acts[0]!;
    const who = counterpartOf(last, outsiders(last)) ?? counterpartOf(first, outsiders(first));
    if (!who) continue;
    const waitingOn: WaitingOn = last.fromMe ? "them" : "me";
    const prev = known[id];
    const company = who.email ? companyFromEmail(who.email)?.name : undefined;
    const category = [...acts].reverse().map(categoryOf).find((c) => c !== "other") ?? "other";
    threads.push({
      id,
      title: stripReplyPrefix(first.title ?? "") || titleOf(first),
      counterpart: displayName(who),
      ...(company ? { company } : {}),
      category,
      waitingOn,
      since: prev && prev.waitingOn === waitingOn ? prev.since : waitingSince(acts, waitingOn),
      lastActivityAt: last.at,
      ...(last.url ? { url: last.url } : {}),
      refs: acts.map(refOf),
    });
  }
  return threads;
}

function openQuestionLine(t: ThreadState): string {
  const who = t.company ? `${t.counterpart} (${t.company})` : t.counterpart;
  const since = t.since ? ` — waiting since ${t.since.slice(0, 10)}` : "";
  return `Reply to ${who} re: ${t.title}${since}`;
}

// ---------- actions ----------

function buildActions(activities: Activity[], config: Config, outsiders: (a: Activity) => Participant[]): string[] {
  const lastByThread = new Map<string, { a: Activity; to: Participant; reply: boolean }>();
  const inboundSeen = new Set<string>();
  for (const a of activities) {
    const key = threadKey(a);
    if (!a.fromMe) {
      inboundSeen.add(key);
      continue;
    }
    if (a.kind !== "email" && !(a.kind === "message" && isConversation(a))) continue;
    const others = a.kind === "email" ? a.participants.filter((p) => p.role !== "mention" && !isMe(p, config)) : outsiders(a);
    const to = counterpartOf(a, others);
    if (!to) continue;
    const reply =
      inboundSeen.has(key) ||
      /^\s*(?:re|aw|antw|rv|sv)\s*:/i.test(a.title ?? "") ||
      a.participants.some((p) => p.role === "from" && !isMe(p, config));
    lastByThread.set(key, { a, to, reply });
  }
  return dedupeLines(
    [...lastByThread.values()].map(({ a, to, reply }) => {
      const subject = stripReplyPrefix(titleOf(a));
      return `${reply ? "Replied to" : "Wrote to"} ${displayName(to)}${subject ? ` re: ${subject}` : ""}`;
    })
  );
}
