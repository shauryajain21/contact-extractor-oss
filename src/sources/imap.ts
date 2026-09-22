import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { Activity, CollectContext, Config, Source } from "../types.js";
import { groupEmailThreads, parseMessageIdList, type EmailAddress, type EmailMessage } from "./email-util.js";

export interface RawMail {
  source: Buffer;
  mailbox: string;
  /** Gmail X-GM-THRID or OBJECTID thread id, when the server provides one. */
  threadId?: string;
  internalDate?: Date;
}

/** The slice of IMAP the source needs, so tests can run without a server. */
export interface MailClient {
  connect(): Promise<void>;
  /** Path of the special-use \Sent mailbox, if the server advertises one. */
  sentMailbox(): Promise<string | undefined>;
  fetchSince(mailbox: string, since: Date): Promise<RawMail[]>;
  logout(): Promise<void>;
}

export type MailClientFactory = (imap: Config["sources"]["imap"], password: string) => MailClient;

const MAX_SOURCE_BYTES = 1_000_000;
const DAY = 86_400_000;

export const createImapFlowClient: MailClientFactory = (imap, password) => {
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: imap.user, pass: password },
    logger: false,
    disableAutoIdle: true,
  });
  // Socket errors also reject the pending command; without a listener they would crash the process.
  client.on("error", () => {});
  return {
    connect: () => client.connect(),
    async sentMailbox() {
      const boxes = await client.list();
      return boxes.find((b) => b.specialUse === "\\Sent")?.path;
    },
    async fetchSince(mailbox, since) {
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const uids = await client.search({ since }, { uid: true });
        if (!uids || uids.length === 0) return [];
        const out: RawMail[] = [];
        const query = { uid: true, source: { maxLength: MAX_SOURCE_BYTES }, threadId: true, internalDate: true };
        for await (const msg of client.fetch(uids, query, { uid: true })) {
          if (!msg.source) continue;
          const internal = msg.internalDate ? new Date(msg.internalDate) : undefined;
          out.push({ source: msg.source, mailbox, threadId: msg.threadId, internalDate: internal });
        }
        return out;
      } finally {
        lock.release();
      }
    },
    async logout() {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
};

function addresses(value: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!value) return [];
  const out: EmailAddress[] = [];
  const walk = (list: AddressObject["value"]) => {
    for (const a of list) {
      if (a.group) walk(a.group);
      else if (a.address || a.name) out.push({ name: a.name || undefined, email: a.address?.toLowerCase() || undefined });
    }
  };
  for (const obj of Array.isArray(value) ? value : [value]) walk(obj.value);
  return out;
}

const RAW_HEADERS = [
  "x-original-from",
  "x-original-sender",
  "list-unsubscribe",
  "list-id",
  "precedence",
  "auto-submitted",
];

function rawHeaders(parsed: ParsedMail): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, line } of parsed.headerLines ?? []) {
    if (!RAW_HEADERS.includes(key) || out[key] !== undefined) continue;
    out[key] = line.slice(line.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim();
  }
  return out;
}

export async function parseRawEmail(raw: RawMail): Promise<EmailMessage> {
  const parsed = await simpleParser(raw.source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const date = parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : (raw.internalDate ?? new Date(NaN));
  return {
    messageId: parsed.messageId,
    inReplyTo: parseMessageIdList(parsed.inReplyTo)[0],
    references: parseMessageIdList(parsed.references),
    gmThreadId: raw.threadId,
    date,
    subject: parsed.subject,
    from: addresses(parsed.from)[0],
    replyTo: addresses(parsed.replyTo),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    text: parsed.text ?? "",
    headers: rawHeaders(parsed),
    mailbox: raw.mailbox,
    attachments: (parsed.attachments ?? []).map((a) => a.filename).filter((f): f is string => !!f),
  };
}

export function mailboxesToScan(imap: Config["sources"]["imap"], sent: string | undefined): string[] {
  const boxes = [...imap.mailboxes];
  if (sent) boxes.push(sent);
  else if (/(^|\.)imap\.gmail\.com$/i.test(imap.host)) boxes.push("[Gmail]/Sent Mail");
  return [...new Set(boxes)];
}

export function createImapSource(factory: MailClientFactory = createImapFlowClient): Source {
  return {
    name: "imap",
    enabled(config) {
      const imap = config.sources.imap;
      return imap.enabled && !!imap.user && !!process.env[imap.passwordEnv];
    },
    async collect(ctx: CollectContext): Promise<Activity[]> {
      const { config, log, since, until } = ctx;
      const imap = config.sources.imap;
      const password = process.env[imap.passwordEnv];
      if (!password) {
        log.error(`imap: ${imap.passwordEnv} is not set`);
        return [];
      }
      const client = factory(imap, password);
      const messages: EmailMessage[] = [];
      try {
        try {
          await client.connect();
        } catch (err) {
          log.error("imap: could not connect or authenticate", { host: imap.host, user: imap.user, error: String(err) });
          return [];
        }
        let sent: string | undefined;
        try {
          sent = await client.sentMailbox();
        } catch (err) {
          log.debug("imap: could not list mailboxes", { error: String(err) });
        }
        // IMAP SINCE is date-only and ignores time zones, so over-fetch a day and filter below.
        const searchSince = new Date(since.getTime() - DAY);
        for (const mailbox of mailboxesToScan(imap, sent)) {
          let raws: RawMail[];
          try {
            raws = await client.fetchSince(mailbox, searchSince);
          } catch (err) {
            log.warn(`imap: skipping mailbox ${mailbox}`, { error: String(err) });
            continue;
          }
          for (const raw of raws) {
            try {
              const msg = await parseRawEmail(raw);
              const t = msg.date.getTime();
              if (Number.isNaN(t) || t < since.getTime() || t >= until.getTime()) continue;
              messages.push(msg);
            } catch (err) {
              log.warn("imap: could not parse a message", { mailbox, error: String(err) });
            }
          }
        }
      } finally {
        try {
          await client.logout();
        } catch (err) {
          log.debug("imap: logout failed", { error: String(err) });
        }
      }
      try {
        const activities = groupEmailThreads(messages, {
          me: config.me,
          ignoreDomains: config.filters.ignoreDomains,
          maxChars: config.limits.maxActivityChars,
        });
        log.info(`imap: ${activities.length} threads from ${messages.length} messages`);
        return activities;
      } catch (err) {
        log.error("imap: grouping failed", { error: String(err) });
        return [];
      }
    },
  };
}

export const imapSource: Source = createImapSource();
