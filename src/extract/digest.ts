import type {
  Activity,
  Company,
  Config,
  Contact,
  Digest,
  ExtractContext,
  ProjectUpdate,
  Ref,
  ThreadState,
} from "../types.js";
import { domainMatches, emailDomain, isMe } from "./classify.js";

export type DigestBody = Omit<Digest, "window">;

export function emptyBody(): DigestBody {
  return { projects: [], contacts: [], companies: [], threads: [], progress: [], actions: [], openQuestions: [], noticed: [] };
}

export function windowOf(ctx: ExtractContext): Digest["window"] {
  return { since: ctx.window.since.toISOString(), until: ctx.window.until.toISOString() };
}

export function refOf(a: Activity): Ref {
  return a.url ? { activityId: a.id, source: a.source, url: a.url } : { activityId: a.id, source: a.source };
}

export function time(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export function laterIso(a: string | undefined, b: string | undefined): string {
  return time(b) > time(a) ? (b ?? "") : (a ?? b ?? "");
}

export function normName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function dedupeLines(lines: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const key = line.toLowerCase().replace(/\s+/g, " ");
    if (!line || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function unionRefs(a: Ref[], b: Ref[]): Ref[] {
  const out = [...a];
  const seen = new Set(a.map((r) => r.activityId));
  for (const r of b) {
    if (seen.has(r.activityId)) continue;
    seen.add(r.activityId);
    out.push(r);
  }
  return out;
}

export function threadKey(a: Activity): string {
  return a.threadId ?? a.id;
}

export function stripReplyPrefix(subject: string): string {
  return subject.replace(/^(?:\s*(?:re|fwd?|aw|wg|tr|rv|sv|antw)\s*(?:\[\d+\])?\s*:\s*)+/i, "").trim();
}

// ---------- merging batches ----------

function mergeContact(a: Contact, b: Contact): Contact {
  const [older, newer] = time(b.lastSeen) >= time(a.lastSeen) ? [a, b] : [b, a];
  const category =
    newer.category !== "other" ? newer.category : older.category !== "other" ? older.category : "other";
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  return {
    name: words(older.name) > words(newer.name) ? older.name : newer.name || older.name,
    email: newer.email ?? older.email,
    company: newer.company ?? older.company,
    domain: newer.domain ?? older.domain,
    role: newer.role ?? older.role,
    category,
    summary: newer.summary || older.summary,
    lastSeen: laterIso(a.lastSeen, b.lastSeen),
    refs: unionRefs(a.refs, b.refs),
  };
}

export function mergeContacts(list: Contact[]): Contact[] {
  const byKey = new Map<string, Contact>();
  const nameToKey = new Map<string, string>();
  for (const c of list) {
    const email = c.email?.toLowerCase();
    const name = normName(c.name);
    const key = email ? `e:${email}` : nameToKey.get(name) ?? `n:${name}`;
    if (email && !byKey.has(key)) {
      // A name-only entry for the same person folds into the one with an email.
      const nameOnly = `n:${name}`;
      const prev = byKey.get(nameOnly);
      if (prev) {
        byKey.delete(nameOnly);
        byKey.set(key, prev);
      }
    }
    const prev = byKey.get(key);
    byKey.set(key, prev ? mergeContact(prev, c) : c);
    if (name && (email || !nameToKey.has(name))) nameToKey.set(name, key);
  }
  return [...byKey.values()];
}

export function mergeCompanies(list: Company[]): Company[] {
  const byKey = new Map<string, Company>();
  const nameToKey = new Map<string, string>();
  for (const c of list) {
    const domain = c.domain?.toLowerCase();
    const name = normName(c.name);
    const key = domain ? `d:${domain}` : nameToKey.get(name) ?? `n:${name}`;
    if (domain && !byKey.has(key)) {
      const prev = byKey.get(`n:${name}`);
      if (prev) {
        byKey.delete(`n:${name}`);
        byKey.set(key, prev);
      }
    }
    const prev = byKey.get(key);
    byKey.set(
      key,
      prev
        ? {
            name: prev.name || c.name,
            domain: prev.domain ?? c.domain,
            category: c.category !== "other" ? c.category : prev.category,
            summary: c.summary || prev.summary,
            contacts: dedupeLines([...prev.contacts, ...c.contacts]),
            refs: unionRefs(prev.refs, c.refs),
          }
        : c
    );
    if (name && (domain || !nameToKey.has(name))) nameToKey.set(name, key);
  }
  return [...byKey.values()];
}

export function mergeProjects(list: ProjectUpdate[]): ProjectUpdate[] {
  const byKey = new Map<string, ProjectUpdate>();
  for (const p of list) {
    const key = normName(p.name);
    const prev = byKey.get(key);
    byKey.set(
      key,
      prev
        ? {
            name: prev.name,
            status: p.status,
            summary: p.summary || prev.summary,
            progress: dedupeLines([...prev.progress, ...p.progress]),
            refs: unionRefs(prev.refs, p.refs),
          }
        : p
    );
  }
  return [...byKey.values()];
}

export function mergeThreadList(list: ThreadState[]): ThreadState[] {
  const byId = new Map<string, ThreadState>();
  for (const t of list) {
    const prev = byId.get(t.id);
    if (!prev) {
      byId.set(t.id, t);
      continue;
    }
    const [older, newer] = time(t.lastActivityAt) >= time(prev.lastActivityAt) ? [prev, t] : [t, prev];
    byId.set(t.id, {
      ...older,
      ...newer,
      company: newer.company ?? older.company,
      url: newer.url ?? older.url,
      refs: unionRefs(older.refs ?? [], newer.refs ?? []),
      category: newer.category !== "other" ? newer.category : older.category,
      since: older.waitingOn === newer.waitingOn ? older.since : newer.since,
    });
  }
  return [...byId.values()];
}

/** Batches are given in chronological order; later ones win where fields conflict. */
export function mergeBodies(parts: DigestBody[]): DigestBody {
  return {
    projects: mergeProjects(parts.flatMap((p) => p.projects)),
    contacts: mergeContacts(parts.flatMap((p) => p.contacts)),
    companies: mergeCompanies(parts.flatMap((p) => p.companies)),
    threads: mergeThreadList(parts.flatMap((p) => p.threads)),
    progress: dedupeLines(parts.flatMap((p) => p.progress)),
    actions: dedupeLines(parts.flatMap((p) => p.actions)),
    openQuestions: dedupeLines(parts.flatMap((p) => p.openQuestions)),
    noticed: dedupeLines(parts.flatMap((p) => p.noticed)),
  };
}

// ---------- final filtering ----------

/**
 * Drop filtered categories, ignored or internal domains and the user themself,
 * then sort for stable output.
 */
export function finalize(body: DigestBody, config: Config): DigestBody {
  const drop = new Set(config.filters.dropCategories);
  const blockedDomain = (d: string | undefined) =>
    !!d && (domainMatches(d, config.filters.ignoreDomains) || domainMatches(d, config.me.domains));
  const meName = normName(config.me.name ?? "");

  const contacts = body.contacts.filter((c) => {
    if (drop.has(c.category)) return false;
    if (blockedDomain(emailDomain(c.email) ?? c.domain)) return false;
    if (isMe({ email: c.email, name: c.email ? undefined : c.name, role: "from" }, config)) return false;
    return !(meName && normName(c.name) === meName);
  });
  const companies = body.companies.filter((c) => !drop.has(c.category) && !blockedDomain(c.domain));
  const threads = body.threads.filter((t) => !drop.has(t.category));

  return {
    ...body,
    projects: [...body.projects].sort((a, b) => a.name.localeCompare(b.name)),
    contacts: contacts.sort((a, b) => a.name.localeCompare(b.name)),
    companies: companies.sort((a, b) => a.name.localeCompare(b.name)),
    threads: threads.sort((a, b) => time(b.lastActivityAt) - time(a.lastActivityAt)),
  };
}
