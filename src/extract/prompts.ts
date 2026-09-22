import type { Activity, Config, LlmRequest, Participant, ThreadState } from "../types.js";
import { threadKey, time } from "./digest.js";

export const CATEGORY_DEFINITIONS: ReadonlyArray<[string, string]> = [
  ["customer", "already paying for or using the user's product or service"],
  ["prospect", "a business inquiry or buying intent"],
  ["partnership", "a partnership, integration or reseller proposal"],
  ["vendor", "someone selling to the user or their company"],
  ["hiring", "job seekers, applicants and recruiters"],
  ["internal", "teammates, people on the user's own domains"],
  ["personal", "friends, family, private matters"],
  ["newsletter", "bulk mail, notifications, automated updates"],
  ["spam", "unsolicited mass pitches: SEO, dev shops, lead-gen, guest posts, token listings"],
  ["other", "none of the above fits"],
];

const OUTPUT_SHAPE = `{
  "projects": [{ "name": string, "status": "active"|"blocked"|"shipped"|"paused", "summary": string, "progress": string[], "refs": string[] }],
  "contacts": [{ "name": string, "email"?: string, "company"?: string, "domain"?: string, "role"?: string, "category": Category, "summary": string, "refs": string[] }],
  "companies": [{ "name": string, "domain"?: string, "category": Category, "summary": string, "contacts": string[], "refs": string[] }],
  "threads": [{ "id": string, "title": string, "counterpart": string, "company"?: string, "category": Category, "waitingOn": "me"|"them"|"nobody", "refs": string[] }],
  "progress": string[],
  "actions": string[],
  "openQuestions": string[],
  "noticed": string[]
}
"refs" are activity ids copied from the input.`;

export function buildSystemPrompt(config: Config): string {
  const me = config.me;
  const who = me.name || "the user";
  const emails = me.emails.length ? me.emails.join(", ") : "unknown";
  const domains = me.domains.length ? me.domains.join(", ") : "none configured";
  const categories = CATEGORY_DEFINITIONS.map(([c, d]) => `- ${c}: ${d}`).join("\n");

  return `You turn a window of ${who}'s work activity into a structured digest for their personal work log and CRM. The reader is ${who}; "the user" below means them.

The user: ${who}. Their addresses: ${emails}. Their team's domains: ${domains} (people on these domains are internal colleagues, not contacts).

Input: known open threads from earlier runs, then one JSON object per line per activity with id, source (cursor and claude-code are the user's AI coding chats, git is commits, slack, imap is email, calendar), kind, at (ISO time), project, workspace (Slack workspace, not a project), language (a detected language code, when not English), threadId, title, participants ("role: Name <email>"), fromMe (true when the user wrote the latest message), url and text. An email or Slack activity can hold a whole conversation, oldest message first; in email text each message starts with "From: Name <email> | <time>".

House style:
- Only include work the user is personally involved in. Skip broadcasts, automated mail and anything they merely received in bulk.
- Terse, one line per item. Names and numbers over adjectives: "balance $34, +65% WoW", not "usage is growing fast".
- No preamble, headings, markdown or emoji inside strings.
- Nothing to report is a valid answer: return empty arrays.
- Write everything in English. When a summary or line comes from a non-English message, append " (translated from <Language>)", e.g. " (translated from French)".

Daily log sections, one line per item:
- progress: something moved forward (shipped, fixed, merged, decided, agreed).
- actions: something the user did to or told someone, e.g. "Sent Acme the revised quote: 20 seats at $40".
- openQuestions: something waiting on an answer, from the user or from someone else. Say who owes it.
- noticed: a fact the data surfaced that nobody asked for. Leave empty unless it is genuinely useful.

Categories, use exactly one of:
${categories}

Entities:
- projects: one per project that moved. When activities have a project value, use it verbatim as the name. status is active, blocked, shipped or paused. summary is one line; progress is one line per concrete step.
- contacts: people outside the user's team whom the user dealt with. email only if it appears in the participants. company only if the data states it or it is evident from a company email domain; a free-mail address (gmail.com, outlook.com and the like) says nothing about their company. role is their job title if stated. summary is one line: who they are and what the latest exchange was about.
- companies: organisations behind those contacts; contacts lists contact names exactly as in contacts.
- threads: conversations with someone outside the team (email, Slack DMs, shared Slack channels). id is the activity's threadId, or the id of its first activity when it has none; reuse the id of a known thread when continuing it. waitingOn is "me" if the last external message is unanswered by the user, "them" if the user spoke last and expects a reply, "nobody" if it is resolved or needs no reply.

Grounding:
- Every project, contact, company and thread carries refs: ids of the input activities it comes from. Only use ids that appear in the input.
- Never invent email addresses, companies, numbers or events. When unsure, leave the field out.
- Never list the user as a contact.

Reply with a single JSON object of exactly this shape and nothing else:
${OUTPUT_SHAPE}`;
}

function formatParticipant(p: Participant): string {
  const name = p.name?.trim() || p.handle || "";
  const addr = p.email ? `<${p.email}>` : "";
  return `${p.role}: ${[name, addr].filter(Boolean).join(" ")}`;
}

/** One compact JSON line per activity; undefined fields are omitted. */
export function serializeActivity(a: Activity, maxTextChars = Infinity): string {
  const text = a.text.length > maxTextChars ? a.text.slice(0, maxTextChars) + "…" : a.text;
  const language = typeof a.meta?.language === "string" && a.meta.language !== "en" ? a.meta.language : undefined;
  return JSON.stringify({
    id: a.id,
    source: a.source,
    kind: a.kind,
    at: a.at,
    project: a.project,
    workspace: a.meta?.workspace,
    language,
    threadId: a.threadId,
    title: a.title,
    participants: a.participants.length ? a.participants.map(formatParticipant) : undefined,
    fromMe: a.fromMe,
    url: a.url,
    text,
  });
}

function serializeThread(t: ThreadState): string {
  return JSON.stringify({
    id: t.id,
    title: t.title,
    counterpart: t.counterpart,
    company: t.company,
    category: t.category,
    waitingOn: t.waitingOn,
    since: t.since,
  });
}

export interface BatchPromptInput {
  activities: Activity[];
  knownThreads: ThreadState[];
  window: { since: Date; until: Date };
  batch: { index: number; total: number };
  maxTextChars?: number;
}

export function buildUserPrompt(input: BatchPromptInput): string {
  const { batch, window } = input;
  const head = `Window: ${window.since.toISOString()} to ${window.until.toISOString()}.${
    batch.total > 1 ? ` Batch ${batch.index + 1} of ${batch.total}; other batches are handled separately.` : ""
  }`;
  const threads = input.knownThreads.length
    ? `Known open threads (update them when the activity below changes who owes the next move):\n${input.knownThreads
        .map(serializeThread)
        .join("\n")}`
    : "Known open threads: none.";
  const acts = input.activities.map((a) => serializeActivity(a, input.maxTextChars)).join("\n");
  return `${head}\n\n${threads}\n\nActivities (one JSON object per line):\n${acts}`;
}

export function buildRepairRequest(original: LlmRequest, error: string): LlmRequest {
  return {
    ...original,
    user: `${original.user}\n\nYour previous reply could not be used (${error}). Reply again with only the JSON object of the required shape.`,
  };
}

/** Known threads the batch can move: still open and touched by one of its activities. */
export function relevantThreads(activities: Activity[], known: Record<string, ThreadState>): ThreadState[] {
  const out = new Map<string, ThreadState>();
  for (const a of activities) {
    const t = known[threadKey(a)] ?? known[a.id];
    if (t && t.waitingOn !== "nobody") out.set(t.id, t);
  }
  return [...out.values()];
}

/**
 * Greedy packing into batches of roughly `batchChars` serialized characters.
 * Messages of one thread stay together so the model sees who spoke last; a
 * thread larger than a batch is split across batches in time order.
 */
export function splitIntoBatches(activities: Activity[], batchChars: number, maxTextChars?: number): Activity[][] {
  const groups = new Map<string, Activity[]>();
  for (const a of [...activities].sort((x, y) => time(x.at) - time(y.at))) {
    const key = threadKey(a);
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const size = (a: Activity) => serializeActivity(a, maxTextChars).length + 1;
  const limit = Math.max(1, batchChars);

  const batches: Activity[][] = [];
  let current: Activity[] = [];
  let used = 0;
  const flush = () => {
    if (current.length) batches.push(current);
    current = [];
    used = 0;
  };
  for (const group of groups.values()) {
    const groupSize = group.reduce((n, a) => n + size(a), 0);
    if (used + groupSize > limit) flush();
    for (const a of group) {
      const s = size(a);
      if (used > 0 && used + s > limit) flush();
      current.push(a);
      used += s;
    }
  }
  flush();
  return batches;
}
