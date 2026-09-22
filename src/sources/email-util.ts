import { clean } from "../redact.js";
import type { Activity, MeConfig, Participant, ParticipantRole } from "../types.js";

export interface EmailAddress {
  name?: string;
  email?: string;
}

export interface EmailMessage {
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  /** Gmail X-GM-THRID. */
  gmThreadId?: string;
  date: Date;
  subject?: string;
  from?: EmailAddress;
  replyTo: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  text: string;
  /** Lower-cased header name to raw value. */
  headers: Record<string, string>;
  mailbox?: string;
  attachments?: string[];
}

export interface GroupOptions {
  me: MeConfig;
  ignoreDomains: string[];
  maxChars: number;
}

export function normalizeMessageId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const m = /<([^<>]+)>/.exec(id);
  const out = (m ? m[1]! : id).trim();
  return out || undefined;
}

export function parseMessageIdList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const joined = Array.isArray(value) ? value.join(" ") : value;
  const bracketed = [...joined.matchAll(/<([^<>]+)>/g)].map((m) => m[1]!.trim());
  const ids = bracketed.length ? bracketed : joined.split(/[\s,]+/);
  return ids.map((s) => s.trim()).filter(Boolean);
}

export function parseAddress(raw: string | undefined): EmailAddress | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  const angle = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(s);
  if (angle) {
    const name = unquote(angle[1]!);
    return { name: name || undefined, email: angle[2]!.toLowerCase() };
  }
  const bare = /([^\s<>()"',;]+@[^\s<>()"',;]+)/.exec(s);
  if (!bare) return undefined;
  const paren = /\(([^)]+)\)/.exec(s);
  return { name: paren ? unquote(paren[1]!) : undefined, email: bare[1]!.toLowerCase() };
}

function unquote(s: string): string {
  return s.trim().replace(/^["']+|["']+$/g, "").replace(/\\"/g, '"').trim();
}

const VIA = /^\s*["']?(.+?)["']?\s+via\s+.+$/i;

/**
 * Mailing lists such as Google Groups rewrite From to
 * `'Jane Doe' via Contact <contact@acme.com>`; the real sender is in
 * X-Original-From, X-Original-Sender or Reply-To.
 */
export function resolveSender(
  from: EmailAddress | undefined,
  replyTo: EmailAddress[],
  headers: Record<string, string>,
): { sender?: EmailAddress; viaGroup?: string } {
  const via = from?.name ? VIA.exec(from.name) : null;
  const original = parseAddress(headers["x-original-from"]);
  if (original?.email && original.email !== from?.email) {
    const name = original.name ?? (via ? unquote(via[1]!) : undefined);
    return { sender: { name, email: original.email }, viaGroup: from?.email };
  }
  if (!via) return { sender: from };
  const name = unquote(via[1]!);
  const originalSender = parseAddress(headers["x-original-sender"]);
  if (originalSender?.email && originalSender.email !== from?.email) {
    return { sender: { name, email: originalSender.email }, viaGroup: from?.email };
  }
  const reply = replyTo.find((r) => r.email && r.email !== from?.email);
  if (reply) return { sender: { name: reply.name || name, email: reply.email }, viaGroup: from?.email };
  return { sender: { name }, viaGroup: from?.email };
}

const ATTRIBUTIONS: RegExp[] = [
  /^On\s.+\swrote\s?:$/i,
  /^Le\s.+\sa\s[ée]crit\s?:$/i,
  /^Am\s.+\sschrieb.*:$/i,
  /^El\s.+\sescribi[óo]\s?:$/i,
  /^Il\s.+\sha scritto\s?:$/i,
  /^Op\s.+\sschreef.*:$/i,
  /^(?:Em|No dia)\s.+\sescreveu\s?:$/i,
];

const SEPARATORS: RegExp[] = [
  /^\s*-{2,}\s*(?:Original Message|Message d'origine|Ursprüngliche Nachricht|Mensaje original|Messaggio originale|Oorspronkelijk bericht)\s*-{2,}\s*$/i,
  /^\s*_{10,}\s*$/,
];

const OUTLOOK_FROM = /^\s*\*?(?:From|De|Von|Van|Da|Från)\s?:\*?\s+\S/i;
const OUTLOOK_SENT = /^\s*\*?(?:Sent|Date|Envoyé|Gesendet|Verzonden|Inviato|Enviado|Skickat)\s?:\*?\s+\S/i;

/** Drop the quoted history under a reply, in the languages mail clients commonly use. */
export function stripQuotes(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length && cut === lines.length; i++) {
    const line = lines[i]!;
    if (SEPARATORS.some((re) => re.test(line))) cut = i;
    else if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => OUTLOOK_SENT.test(l))) cut = i;
    else if (/^\s*(?:On|Le|Am|El|Il|Op|Em|No dia)\s/i.test(line)) {
      let chunk = "";
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        chunk = (chunk + " " + lines[j]!.trim()).replace(/\s+/g, " ").trim();
        if (chunk.length > 300) break;
        if (ATTRIBUTIONS.some((re) => re.test(chunk))) {
          cut = i;
          break;
        }
      }
    }
  }
  return lines
    .slice(0, cut)
    .filter((l) => !/^\s*>/.test(l))
    .join("\n");
}

const MOBILE_FOOTER =
  /^\s*(?:Sent from my \S+|Sent from (?:Mail|Outlook) for \S+|Get Outlook for \S+|Envoyé de mon \S+|Von meinem \S+ gesendet|Enviado desde mi \S+|Inviato da \S+)/i;

export function stripSignature(text: string): string {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l === "-- " || l.trimEnd() === "--" || MOBILE_FOOTER.test(l));
  return (idx === -1 ? lines : lines.slice(0, idx)).join("\n");
}

export function cleanBody(text: string): string {
  return stripSignature(stripQuotes(text))
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeSubject(subject: string | undefined): string | undefined {
  if (!subject) return undefined;
  const s = subject.replace(/^(?:\s*(?:re|fwd?|aw|wg|tr|sv|vs|rv|réf|ref|antw)\s*(?:\[\d+\])?\s*:\s*)+/i, "").trim();
  return s || subject.trim();
}

export function domainOf(email: string | undefined): string | undefined {
  const at = email?.lastIndexOf("@") ?? -1;
  return at >= 0 ? email!.slice(at + 1).toLowerCase() : undefined;
}

export function domainMatches(domain: string | undefined, list: string[]): boolean {
  if (!domain) return false;
  return list.some((d) => {
    const x = d.toLowerCase().replace(/^@/, "");
    return domain === x || domain.endsWith("." + x);
  });
}

export function isMyEmail(email: string | undefined, me: MeConfig): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  return me.emails.some((m) => m.toLowerCase() === e);
}

export function isNoReply(email: string | undefined): boolean {
  if (!email) return false;
  const local = email.slice(0, email.indexOf("@")).toLowerCase();
  return /no-?reply|do-?not-?reply|^notifications?$|^notify$|mailer-daemon|^postmaster$/.test(local);
}

/** Keeps the newest blocks whole and trims or drops older ones to fit `max`. */
export function fitNewest(blocks: string[], max: number, sep = "\n\n"): string {
  const out: string[] = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const room = max - used - (out.length ? sep.length : 0);
    if (out.length && room < 200) {
      out.unshift(`[${i + 1} earlier message${i ? "s" : ""} omitted]`);
      break;
    }
    if (block.length <= room) {
      out.unshift(block);
      used += block.length + (out.length > 1 ? sep.length : 0);
    } else {
      out.unshift(block.slice(0, Math.max(room - 16, 0)) + "\n…[truncated]");
      used = max;
    }
  }
  return out.join(sep);
}

const STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "you", "for", "with", "this", "that", "is", "are", "have"],
  fr: ["le", "la", "les", "et", "vous", "pour", "avec", "est", "une", "des", "je", "nous"],
  de: ["der", "die", "und", "sie", "mit", "ist", "nicht", "ich", "für", "das", "wir"],
  es: ["el", "los", "las", "y", "usted", "para", "con", "una", "que", "gracias"],
};

export function languageHint(text: string): string | undefined {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const scores = Object.entries(STOPWORDS).map(([lang, list]) => {
    const set = new Set(list);
    return [lang, words.filter((w) => set.has(w)).length] as const;
  });
  scores.sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (!best || best[1] < 3 || (second && best[1] < second[1] * 1.5)) return undefined;
  return best[0];
}

function formatAddress(a: EmailAddress | undefined): string {
  if (!a) return "(unknown)";
  if (a.name && a.email) return `${a.name} <${a.email}>`;
  return a.name ?? a.email ?? "(unknown)";
}

function messageKey(m: EmailMessage): string {
  return normalizeMessageId(m.messageId) ?? `${m.from?.email ?? ""}|${m.date.getTime()}|${m.subject ?? ""}`;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Stable across runs: the thread root id every reply points back to. */
export function threadKey(msgs: EmailMessage[]): string {
  const gm = msgs.find((m) => m.gmThreadId)?.gmThreadId;
  if (gm) return `gm:${gm}`;
  const sorted = [...msgs].sort((a, b) => a.date.getTime() - b.date.getTime());
  const ref = sorted.find((m) => m.references.length)?.references[0];
  if (ref) return normalizeMessageId(ref)!;
  const irt = sorted.find((m) => m.inReplyTo)?.inReplyTo;
  if (irt) return normalizeMessageId(irt)!;
  return messageKey(sorted[0]!);
}

const ROLE_RANK: Record<ParticipantRole, number> = { from: 0, to: 1, cc: 2, attendee: 3, mention: 4 };

/** One Activity per thread. Messages outside the window must already be filtered out. */
export function groupEmailThreads(messages: EmailMessage[], opts: GroupOptions): Activity[] {
  const unique = new Map<string, EmailMessage>();
  for (const m of messages) {
    const key = messageKey(m);
    const prev = unique.get(key);
    if (!prev || (!prev.gmThreadId && m.gmThreadId)) unique.set(key, m);
  }

  const uf = new UnionFind();
  for (const [key, m] of unique) {
    const gm = m.gmThreadId ? `gm:${m.gmThreadId}` : undefined;
    if (gm) uf.union(key, gm);
    for (const id of [m.inReplyTo, ...m.references]) {
      const n = normalizeMessageId(id);
      if (n) uf.union(key, n);
    }
  }
  const threads = new Map<string, EmailMessage[]>();
  for (const [key, m] of unique) {
    const root = uf.find(key);
    const list = threads.get(root) ?? [];
    list.push(m);
    threads.set(root, list);
  }

  const out: Activity[] = [];
  for (const msgs of threads.values()) {
    const activity = buildThreadActivity(msgs, opts);
    if (activity) out.push(activity);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

function buildThreadActivity(msgs: EmailMessage[], opts: GroupOptions): Activity | undefined {
  const { me } = opts;
  msgs.sort((a, b) => a.date.getTime() - b.date.getTime());
  const resolved = msgs.map((m) => ({ m, ...resolveSender(m.from, m.replyTo, m.headers) }));

  const isInternal = (e: string | undefined) => isMyEmail(e, me) || domainMatches(domainOf(e), me.domains);
  const externalSenders = resolved.map((r) => r.sender?.email).filter((e) => e && !isInternal(e)) as string[];
  if (externalSenders.length && externalSenders.every((e) => domainMatches(domainOf(e), opts.ignoreDomains))) {
    return undefined;
  }

  const participants = new Map<string, Participant>();
  const add = (a: EmailAddress | undefined, role: ParticipantRole) => {
    if (!a || (!a.email && !a.name)) return;
    const key = (a.email ?? a.name!).toLowerCase();
    const prev = participants.get(key);
    if (prev && ROLE_RANK[prev.role] <= ROLE_RANK[role]) {
      if (!prev.name && a.name) prev.name = a.name;
      return;
    }
    participants.set(key, { name: a.name || prev?.name, email: a.email, role });
  };
  for (const r of resolved) {
    add(r.sender, "from");
    r.m.to.forEach((a) => add(a, "to"));
    r.m.cc.forEach((a) => add(a, "cc"));
  }

  const blocks = resolved.map(
    (r) => `From: ${formatAddress(r.sender)} | ${r.m.date.toISOString()}\n${clean(cleanBody(r.m.text), opts.maxChars)}`,
  );
  const last = resolved[resolved.length - 1]!;
  const lastSenderIsMe = isMyEmail(last.sender?.email, me);
  const key = threadKey(msgs);
  const messageIds = msgs.map((m) => normalizeMessageId(m.messageId)).filter(Boolean) as string[];
  const lastId = normalizeMessageId(last.m.messageId) ?? String(last.m.date.getTime());
  const externalMsgs = resolved.filter((r) => !isInternal(r.sender?.email));
  const viaGroup = resolved.find((r) => r.viaGroup)?.viaGroup;
  const attachments = [...new Set(msgs.flatMap((m) => m.attachments ?? []))];
  const language = languageHint(resolved.map((r) => cleanBody(r.m.text)).join("\n"));

  return {
    id: `imap:${key}:${lastId}`,
    source: "imap",
    kind: "email",
    at: last.m.date.toISOString(),
    title: normalizeSubject(msgs.find((m) => m.subject)?.subject),
    text: clean(fitNewest(blocks, opts.maxChars), opts.maxChars),
    threadId: `imap:${key}`,
    participants: [...participants.values()],
    fromMe: lastSenderIsMe,
    meta: {
      listUnsubscribe: msgs.some((m) => !!m.headers["list-unsubscribe"]),
      precedenceBulk: msgs.some((m) => /\b(?:bulk|list|junk)\b/i.test(m.headers["precedence"] ?? "")),
      noReply: externalMsgs.some((r) => isNoReply(r.sender?.email)),
      autoSubmitted: msgs.some((m) => /^auto-/i.test(m.headers["auto-submitted"] ?? "")),
      lastSenderIsMe,
      messageIds,
      messageCount: msgs.length,
      mailboxes: [...new Set(msgs.map((m) => m.mailbox).filter(Boolean))],
      externalDomains: [...new Set(externalMsgs.map((r) => domainOf(r.sender?.email)).filter(Boolean))],
      ...(attachments.length ? { attachments } : {}),
      ...(viaGroup ? { viaGroup } : {}),
      ...(language ? { language } : {}),
    },
  };
}
