import type { Activity, Category, Config, Participant } from "../types.js";

export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.fr", "outlook.de", "hotmail.com", "hotmail.fr",
  "hotmail.de", "hotmail.es", "hotmail.co.uk", "hotmail.it", "live.com", "live.fr", "msn.com", "yahoo.com",
  "yahoo.fr", "yahoo.de", "yahoo.es", "yahoo.co.uk", "yahoo.co.in", "yahoo.co.jp", "ymail.com", "rocketmail.com",
  "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "protonmail.ch", "pm.me",
  "gmx.com", "gmx.de", "gmx.net", "gmx.fr", "web.de", "t-online.de", "freenet.de", "posteo.de", "mailbox.org",
  "orange.fr", "wanadoo.fr", "free.fr", "laposte.net", "sfr.fr", "libero.it", "virgilio.it", "qq.com",
  "163.com", "126.com", "sina.com", "foxmail.com", "yandex.ru", "yandex.com", "ya.ru", "mail.ru", "bk.ru",
  "rambler.ru", "naver.com", "daum.net", "hanmail.net", "rediffmail.com", "zoho.com", "zohomail.com",
  "tutanota.com", "tuta.io", "fastmail.com", "hey.com", "seznam.cz", "wp.pl", "o2.pl", "interia.pl",
  "terra.com.br", "uol.com.br", "bol.com.br",
]);

const CALENDAR_RESOURCE = /(?:^|\.)(?:resource|group)\.calendar\.google\.com$/;
const SECOND_LEVEL = /^(?:co|com|net|org|ac|gov|edu)\.[a-z]{2}$/;

export function emailDomain(email: string | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/[>.\s]+$/, "");
  return domain.includes(".") ? domain : null;
}

export function isFreemail(domain: string): boolean {
  return FREEMAIL_DOMAINS.has(domain.toLowerCase());
}

export function domainMatches(domain: string, list: readonly string[]): boolean {
  const d = domain.toLowerCase();
  return list.some((x) => {
    const l = x.toLowerCase().replace(/^@/, "");
    return d === l || d.endsWith("." + l);
  });
}

/** `ana@mail.acme-labs.io` → `{ domain: "acme-labs.io", name: "Acme Labs" }`; freemail → null. */
export function companyFromEmail(email: string): { domain: string; name: string } | null {
  const full = emailDomain(email);
  if (!full || isFreemail(full) || CALENDAR_RESOURCE.test(full)) return null;
  const parts = full.split(".");
  const tldLen = parts.length >= 3 && SECOND_LEVEL.test(parts.slice(-2).join(".")) ? 2 : 1;
  const domain = parts.slice(-(tldLen + 1)).join(".");
  if (isFreemail(domain)) return null;
  const label = parts[parts.length - tldLen - 1] ?? domain;
  const name = label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return name ? { domain, name } : null;
}

/** `ana.garcia@x.com` → `Ana Garcia`. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .replace(/\+.*$/, "")
    .split(/[._-]+/)
    .filter((w) => w && !/^\d+$/.test(w))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || email;
}

export function isMe(p: Participant, config: Config): boolean {
  const me = config.me;
  const email = p.email?.toLowerCase();
  if (email && me.emails.some((e) => e.toLowerCase() === email)) return true;
  if (p.handle && me.slackUserId && p.handle === me.slackUserId) return true;
  const authors = (me.gitAuthors ?? []).map((a) => a.toLowerCase());
  if (p.handle && authors.includes(p.handle.toLowerCase())) return true;
  if (!email && p.name) {
    const n = p.name.trim().toLowerCase();
    if ((me.name && n === me.name.trim().toLowerCase()) || authors.includes(n)) return true;
  }
  return false;
}

export function isInternalParticipant(p: Participant, activity: Activity, config: Config): boolean {
  // Everyone in a non-shared Slack conversation is a workspace member, whatever their email domain.
  if (activity.source === "slack" && activity.meta?.isExternal !== true) return true;
  const domain = emailDomain(p.email);
  return !!domain && (domainMatches(domain, config.me.domains) || CALENDAR_RESOURCE.test(domain));
}

/** Participants who are neither the user nor a teammate. */
export function externalParticipants(activity: Activity, config: Config): Participant[] {
  return activity.participants.filter(
    (p) => p.role !== "mention" && (p.email || p.name || p.handle) && !isMe(p, config) && !isInternalParticipant(p, activity, config)
  );
}

export function isOwnWork(activity: Activity): boolean {
  return activity.kind === "chat" || activity.kind === "commit";
}

function sender(activity: Activity): Participant | undefined {
  return activity.participants.find((p) => p.role === "from");
}

function firstParagraph(text: string, max = 700): string {
  // Email thread activities prefix each message with "From: Name <addr> | <ISO date>".
  const body = text
    .split("\n")
    .filter((l) => !/^\s*>/.test(l) && !/^From: .*\| \d{4}-\d\d-\d\dT\S+$/.test(l))
    .join("\n")
    .trim();
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  // Skip a bare greeting line ("Hi Ana,") so the first real paragraph is checked.
  const start = paras.length > 1 && (paras[0]?.length ?? 0) < 40 ? 2 : 1;
  return paras.slice(0, start).join("\n").slice(0, max);
}

function attachmentNames(activity: Activity): string[] {
  const raw = activity.meta?.attachments;
  return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
}

// ---------- newsletter ----------

const BULK_LOCAL_PART =
  /^(?:no-?reply|do-?not-?reply|donotreply|noreply-\w+|notifications?|notify|news|newsletters?|marketing|mailer|mailer-daemon|bounces?|digest|updates|alerts?|info-noreply)$/i;

export function isNewsletter(activity: Activity): boolean {
  const m = activity.meta ?? {};
  if (m.listUnsubscribe || m.precedenceBulk || m.noReply) return true;
  const local = sender(activity)?.email?.split("@")[0];
  return !!local && BULK_LOCAL_PART.test(local);
}

// ---------- hiring ----------

const APPLICATION_SUBJECT = new RegExp(
  [
    String.raw`\b(?:job|internship|spontaneous|unsolicited|open)\s+application\b`,
    String.raw`\bapplication\s+(?:for|to)\s+(?:the\s+)?(?:\w+\s+){0,4}(?:position|role|job|internship|post)\b`,
    String.raw`\bapplying\s+for\b`,
    // Not "resume"/"résumé": "Resume our call", "Résumé de la réunion".
    String.raw`\b(?:cv|curriculum vitae)\b`,
    String.raw`\bcandidature\b`,
    String.raw`\bdemande\s+de\s+stage\b`,
    String.raw`\b(?:recherche|offre)\s+(?:de\s+|d')?(?:stage|emploi|alternance)\b`,
    String.raw`\b(?:initiativ)?bewerbung\b`,
    String.raw`\blebenslauf\b`,
    String.raw`\bpraktikumsanfrage\b`,
    String.raw`\bsolicitud\s+de\s+(?:empleo|trabajo|prácticas|practicas)\b`,
    String.raw`\bcandidatura\b`,
  ].join("|"),
  "i"
);

const APPLICANT_PHRASE = new RegExp(
  [
    // EN
    String.raw`\bappl(?:y|ying)\s+(?:for|to)\s+(?:\w+\s+){0,4}(?:position|role|job|internship|opening|vacancy)\b`,
    String.raw`\bi(?:'m| am)\s+applying\s+(?:for|to)\b`,
    String.raw`\bi\s+am\s+writing\s+to\s+(?:apply|express\s+my\s+interest\s+in\s+(?:the|a|joining))\b`,
    String.raw`\b(?:i(?:'m| am)|currently)\s+(?:actively\s+)?(?:looking|searching|seeking)\s+for\s+(?:a|an|new)?\s*(?:job|internship|position|role|opportunit(?:y|ies)|work|employment)\b`,
    String.raw`\b(?:looking|searching)\s+for\s+(?:a|an)\s+(?:new\s+)?(?:job|internship|position|role)\b`,
    String.raw`\binterested\s+in\s+(?:joining|working\s+(?:at|for|with))\s+(?:your|the)\s+(?:team|company)\b`,
    String.raw`\b(?:any|your)\s+open\s+(?:positions?|roles?|vacancies)\b`,
    String.raw`\b(?:are\s+you|is\s+your\s+(?:team|company))\s+(?:currently\s+)?hiring\b`,
    String.raw`\b(?:attached|enclosed|please\s+find)\b[^.\n]{0,40}\bmy\s+(?:cv|resume|résumé|curriculum)\b`,
    String.raw`\bmy\s+(?:cv|resume|résumé)\s+(?:is\s+)?(?:attached|enclosed)\b`,
    String.raw`\bi(?:'m| am)\s+a\s+(?:technical\s+|tech\s+)?recruiter\b`,
    String.raw`\b(?:candidates|talent)\s+for\s+your\s+(?:open\s+)?(?:roles|positions|team)\b`,
    // FR
    String.raw`\bje\s+me\s+permets\s+de\s+(?:vous\s+)?(?:contacter|écrire|ecrire)\s+(?:afin\s+de|pour)\s+(?:postuler|vous\s+proposer\s+ma\s+candidature)\b`,
    String.raw`\b(?:ma|une)\s+candidature\b`,
    String.raw`\bcandidature\s+spontanée\b`,
    String.raw`\bje\s+suis\s+(?:actuellement\s+)?(?:à|a)\s+la\s+recherche\s+d'?(?:un|une)?\s*(?:stage|emploi|poste|alternance|opportunité)\b`,
    String.raw`\bje\s+souhaite(?:rais)?\s+postuler\b`,
    String.raw`\b(?:ci-joint|vous\s+trouverez)[^.\n]{0,30}\bmon\s+(?:cv|curriculum)\b`,
    // DE
    String.raw`\bbewerbe\s+mich\b`,
    String.raw`\bmeine\s+(?:initiativ)?bewerbung\b`,
    String.raw`\bsuche\s+(?:eine?n?\s+)?(?:stelle|praktikum|praktikumsplatz|job|arbeitsstelle|werkstudentenstelle)\b`,
    String.raw`\bmeinen\s+lebenslauf\b`,
    // ES
    String.raw`\bme\s+gustar[íi]a\s+(?:postularme|aplicar|presentar\s+mi\s+candidatura)\b`,
    String.raw`\b(?:busco|estoy\s+buscando)\s+(?:un\s+|una\s+)?(?:trabajo|empleo|prácticas|practicas|puesto)\b`,
    String.raw`\b(?:adjunto|les?\s+env[íi]o)\b[^.\n]{0,30}\bmi\s+(?:cv|curr[íi]culum)\b`,
  ].join("|"),
  "i"
);

const JOB_TERM =
  /\b(?:job|jobs|internship|intern|position|role|vacanc(?:y|ies)|hiring|career|stage|emploi|poste|alternance|stelle|praktikum|werkstudent|empleo|trabajo|prácticas|vacante|puesto)\b/i;

const CV_FILE = /(?:\bcv\b|_cv|cv_|resume|résumé|lebenslauf|curriculum)/i;

export function isJobInquiry(subject: string, body: string, attachments: readonly string[] = []): boolean {
  const lead = firstParagraph(body);
  if (APPLICATION_SUBJECT.test(subject)) return true;
  if (APPLICANT_PHRASE.test(subject) || APPLICANT_PHRASE.test(lead)) return true;
  const hasCv = attachments.some((a) => CV_FILE.test(a));
  return hasCv && (JOB_TERM.test(subject) || JOB_TERM.test(lead));
}

// ---------- spam / solicitation ----------

const SPAM_STRONG: RegExp[] = [
  /\bguest\s+post(?:s|ing)?\b/i,
  /\bback-?links?\b/i,
  /\blink[\s-]?(?:building|insertion|exchange)\b/i,
  /\bsponsored\s+(?:post|article|content)\b/i,
  /\bseo\s+(?:services?|agency|audit|expert|package|report|specialist)\b/i,
  /\b(?:first|top)\s+page\s+(?:of|on)\s+google\b/i,
  /\brank(?:ing)?\s+(?:higher|#?1|first)\s+(?:on|in)\s+(?:google|search)\b/i,
  /\b(?:list(?:ing)?\s+your\s+(?:token|coin|project)|(?:token|coin|exchange)\s+listing)\b/i,
  /\bwe\s+(?:can|will|could)\s+(?:build|develop|design)\s+your\s+(?:app|website|mvp|platform|product)\b/i,
  /\b(?:hire|offer)\s+(?:our\s+)?dedicated\s+(?:developers|engineers|team)\b/i,
  /\b(?:offshore|white[\s-]label)\s+(?:development|developers|team)\b/i,
  /\blead\s+generation\s+(?:services?|agency|campaign)\b/i,
  /\bwe\s+(?:can|will)\s+(?:get|book|schedule|deliver)\s+(?:you\s+)?\d+\+?\s+(?:qualified\s+)?(?:meetings|appointments|calls|leads)\b/i,
  /\b(?:netlinking|article\s+sponsoris[ée]|gastbeitrag|art[íi]culo\s+patrocinado)\b/i,
];

const SPAM_WEAK: RegExp[] = [
  /\bcame\s+across\s+your\s+(?:website|site|company|profile|app)\b/i,
  /\b(?:increase|boost|improve)\s+(?:your\s+)?(?:website\s+|organic\s+)?(?:traffic|rankings?|online\s+presence|domain\s+authority)\b/i,
  /\bmutually\s+beneficial\b/i,
  /\bwin[\s-]win\b/i,
  /\b(?:affordable|competitive|reasonable)\s+(?:price|pricing|rates?|cost)\b/i,
  /\bfree\s+(?:audit|consultation|quote|analysis|mockup)\b/i,
  /\b(?:outsourc(?:e|ing)|development\s+(?:agency|company|services)|software\s+house)\b/i,
  /\b(?:qualified\s+leads|generate\s+(?:more\s+)?leads|appointment\s+setting)\b/i,
  /\bif\s+(?:you(?:'re|\s+are)\s+not\s+interested|this\s+is\s+not\s+relevant|i'?ve\s+reached\s+the\s+wrong\s+person)\b/i,
  /\breply\s+(?:with\s+)?["']?(?:yes|stop|unsubscribe)["']?\b/i,
  /\b(?:seo|référencement|suchmaschinenoptimierung|posicionamiento\s+web)\b/i,
  /\b(?:crypto|blockchain|web3)\s+(?:marketing|promotion|listing|exchange)\b/i,
  /\bpartnership\s+(?:opportunity|proposal)\b.*\b(?:commission|affiliate|revenue\s+share)\b/is,
];

export function isSolicitation(subject: string, body: string): boolean {
  const text = `${subject}\n${body}`;
  let score = 0;
  for (const re of SPAM_STRONG) if (re.test(text)) score += 2;
  for (const re of SPAM_WEAK) if (re.test(text)) score += 1;
  return score >= 2;
}

// ---------- entry point ----------

/**
 * Deterministic category, or null to let the LLM (or the heuristic default) decide.
 * Chats and commits are the user's own work and are never categorised.
 */
export function classifyActivity(activity: Activity, config: Config): Category | null {
  if (isOwnWork(activity)) return null;

  const others = activity.participants.filter((p) => p.role !== "mention" && !isMe(p, config));
  const allInternal = others.every((p) => isInternalParticipant(p, activity, config));
  const internalSlack = activity.source === "slack" && activity.meta?.isExternal !== true;
  if (allInternal && (others.length > 0 || internalSlack)) return "internal";

  if (activity.kind === "event") return null;

  const subject = activity.title ?? "";
  const body = activity.text ?? "";

  if (activity.kind === "email" && !activity.fromMe && isNewsletter(activity)) return "newsletter";
  if (isJobInquiry(subject, body, attachmentNames(activity))) return "hiring";
  if (!activity.fromMe && isSolicitation(subject, body)) return "spam";
  return null;
}
