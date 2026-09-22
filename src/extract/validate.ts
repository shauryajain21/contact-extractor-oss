import type {
  Activity,
  Category,
  Company,
  Config,
  Contact,
  ProjectStatus,
  ProjectUpdate,
  Ref,
  ThreadState,
  WaitingOn,
} from "../types.js";
import { companyFromEmail, emailDomain, isFreemail, nameFromEmail } from "./classify.js";
import { type DigestBody, dedupeLines, normName, refOf, threadKey, time } from "./digest.js";
import { waitingSince } from "./heuristic.js";
import { extractJsonObject } from "./llm.js";

const CATEGORIES: ReadonlySet<string> = new Set<Category>([
  "customer", "prospect", "partnership", "vendor", "hiring", "internal", "personal", "newsletter", "spam", "other",
]);
const STATUSES: ReadonlySet<string> = new Set<ProjectStatus>(["active", "blocked", "shipped", "paused"]);
const WAITING: ReadonlySet<string> = new Set<WaitingOn>(["me", "them", "nobody"]);

type Obj = Record<string, unknown>;

export type ParseResult = { ok: true; value: Obj } | { ok: false; error: string };

export function parseLlmJson(text: string): ParseResult {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const inner = extractJsonObject(trimmed);
    if (!inner) return { ok: false, error: "no JSON object found in the reply" };
    value = JSON.parse(inner);
  }
  if (!isObj(value)) return { ok: false, error: "the reply is JSON but not an object" };
  return { ok: true, value };
}

export interface CoerceContext {
  config: Config;
  /** The batch sent to the model; refs to anything else are dropped. */
  activities: Activity[];
  knownThreads: Record<string, ThreadState>;
  /** Rule-based category per activity id, from `classifyActivity`. */
  ruleCategory: Map<string, Category | null>;
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown, max = 300): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v).replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function lines(v: unknown, max = 400): string[] {
  return dedupeLines(
    arr(v)
      .map((x) => str(isObj(x) ? (x.text ?? x.line) : x, max))
      .filter((x): x is string => !!x)
      .map((x) => x.replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, ""))
  );
}

function compact(s: string): string {
  return normName(s).replace(/ /g, "");
}

export function coerceBody(raw: Obj, cx: CoerceContext): DigestBody {
  const byId = new Map(cx.activities.map((a) => [a.id, a]));
  const participantEmails = new Set(
    cx.activities.flatMap((a) => a.participants.map((p) => p.email?.toLowerCase()).filter((e): e is string => !!e))
  );

  const refsOf = (v: unknown): Ref[] => {
    const seen = new Set<string>();
    const out: Ref[] = [];
    for (const r of arr(v)) {
      const id = typeof r === "string" ? r : isObj(r) ? (r.activityId ?? r.id) : undefined;
      const a = typeof id === "string" ? byId.get(id.trim()) : undefined;
      if (!a || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(refOf(a));
    }
    return out;
  };
  const actsOf = (refs: Ref[]) => refs.map((r) => byId.get(r.activityId)).filter((a): a is Activity => !!a);
  const latestAt = (acts: Activity[]) => acts.reduce((m, a) => (time(a.at) > time(m) ? a.at : m), acts[0]?.at ?? "");

  /** Rules win when every referenced activity got the same deterministic category. */
  const category = (v: unknown, refs: Ref[]): Category => {
    const cats = refs.map((r) => cx.ruleCategory.get(r.activityId) ?? null);
    const first = cats[0];
    if (first && cats.every((c) => c === first)) return first;
    return typeof v === "string" && CATEGORIES.has(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as Category) : "other";
  };

  const grounded = (value: string, acts: Activity[]): boolean => {
    const needle = compact(value);
    if (needle.length < 2) return false;
    return acts.some((a) => {
      const hay = compact(
        [a.title ?? "", a.text, ...a.participants.map((p) => `${p.name ?? ""} ${p.email ?? ""}`)].join(" ")
      );
      return hay.includes(needle);
    });
  };

  const projects: ProjectUpdate[] = [];
  const projectActs = cx.activities.filter((a) => a.project && a.source !== "slack");
  const projectNames = new Map(projectActs.map((a) => [normName(a.project!), a.project!]));
  for (const p of arr(raw.projects)) {
    if (!isObj(p)) continue;
    const given = str(p.name, 120);
    if (!given) continue;
    const name = projectNames.get(normName(given)) ?? given;
    let refs = refsOf(p.refs);
    if (!refs.length) refs = projectActs.filter((a) => a.project === name).map(refOf);
    if (!refs.length) continue;
    const progress = lines(p.progress);
    const status = str(p.status)?.toLowerCase();
    projects.push({
      name,
      status: status && STATUSES.has(status) ? (status as ProjectStatus) : "active",
      summary: str(p.summary) ?? progress[0] ?? "",
      progress,
      refs,
    });
  }

  const contacts: Contact[] = [];
  for (const c of arr(raw.contacts)) {
    if (!isObj(c)) continue;
    const rawEmail = str(c.email, 200)?.toLowerCase().replace(/^mailto:/, "");
    const email = rawEmail && participantEmails.has(rawEmail) ? rawEmail : undefined;
    const name = str(c.name, 120) ?? (email ? nameFromEmail(email) : undefined);
    if (!name) continue;
    let refs = refsOf(c.refs);
    if (!refs.length && email) {
      refs = cx.activities.filter((a) => a.participants.some((p) => p.email?.toLowerCase() === email)).map(refOf);
    }
    if (!refs.length) continue;
    const acts = actsOf(refs);
    const fromDomain = email ? companyFromEmail(email) : null;
    const company = str(c.company, 120);
    const keptCompany = company && (grounded(company, acts) || company === fromDomain?.name) ? company : fromDomain?.name;
    const llmDomain = str(c.domain, 120)?.toLowerCase();
    const domain =
      fromDomain?.domain ??
      (llmDomain && !email && !isFreemail(llmDomain) && grounded(llmDomain, acts) ? llmDomain : undefined);
    const role = str(c.role, 80);
    contacts.push({
      name,
      ...(email ? { email } : {}),
      ...(keptCompany ? { company: keptCompany } : {}),
      ...(domain ? { domain } : {}),
      ...(role ? { role } : {}),
      category: category(c.category, refs),
      summary: str(c.summary) ?? "",
      lastSeen: latestAt(acts),
      refs,
    });
  }

  const companies: Company[] = [];
  for (const c of arr(raw.companies)) {
    if (!isObj(c)) continue;
    const name = str(c.name, 120);
    if (!name) continue;
    let domain = str(c.domain, 120)?.toLowerCase().replace(/^(?:https?:\/\/)?(?:www\.)?@?/, "").replace(/\/.*$/, "");
    const onDomain = (a: Activity) =>
      !!domain && a.participants.some((p) => {
        const d = emailDomain(p.email);
        return !!d && (d === domain || d.endsWith("." + domain));
      });
    let refs = refsOf(c.refs);
    if (!refs.length && domain) refs = cx.activities.filter(onDomain).map(refOf);
    if (!refs.length) continue;
    const acts = actsOf(refs);
    if (domain && (isFreemail(domain) || !(acts.some(onDomain) || grounded(domain, acts)))) domain = undefined;
    if (!domain && !grounded(name, acts)) continue;
    companies.push({
      name,
      ...(domain ? { domain } : {}),
      category: category(c.category, refs),
      summary: str(c.summary) ?? "",
      contacts: dedupeLines(arr(c.contacts).map((x) => str(x, 120)).filter((x): x is string => !!x)),
      refs,
    });
  }

  const threads: ThreadState[] = [];
  const keys = new Set(cx.activities.map(threadKey));
  for (const t of arr(raw.threads)) {
    if (!isObj(t)) continue;
    const refs = refsOf(t.refs);
    const given = str(t.id, 300);
    const id =
      given && (keys.has(given) || cx.knownThreads[given])
        ? given
        : refs[0]
          ? threadKey(byId.get(refs[0].activityId)!)
          : undefined;
    if (!id) continue;
    const threadActs = cx.activities
      .filter((a) => threadKey(a) === id || refs.some((r) => r.activityId === a.id))
      .sort((a, b) => time(a.at) - time(b.at));
    const last = threadActs[threadActs.length - 1];
    const counterpart = str(t.counterpart, 120);
    const title = str(t.title, 200) ?? last?.title?.trim();
    if (!last || !counterpart || !title) continue;
    const allRefs = threadActs.map(refOf);
    const cat = category(t.category, allRefs);
    if (cat === "internal") continue;
    const w = str(t.waitingOn)?.toLowerCase();
    const waitingOn: WaitingOn = w && WAITING.has(w) ? (w as WaitingOn) : last.fromMe ? "them" : "me";
    const prev = cx.knownThreads[id];
    const company = str(t.company, 120);
    const url = [...threadActs].reverse().find((a) => a.url)?.url;
    threads.push({
      id,
      title,
      counterpart,
      ...(company && grounded(company, threadActs) ? { company } : {}),
      category: cat,
      waitingOn,
      since: prev && prev.waitingOn === waitingOn ? prev.since : waitingSince(threadActs, waitingOn),
      lastActivityAt: last.at,
      ...(url ? { url } : {}),
      refs: allRefs,
    });
  }

  return {
    projects,
    contacts,
    companies,
    threads,
    progress: lines(raw.progress),
    actions: lines(raw.actions),
    openQuestions: lines(raw.openQuestions),
    noticed: lines(raw.noticed),
  };
}
