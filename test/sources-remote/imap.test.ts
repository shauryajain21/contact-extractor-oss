import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { defaultConfig } from "../../src/config.js";
import { createImapSource, mailboxesToScan, parseRawEmail, type MailClient, type RawMail } from "../../src/sources/imap.js";
import type { CollectContext, Config, Logger } from "../../src/types.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "remote");
const eml = (name: string) => readFileSync(join(FIXTURES, name));
const PASSWORD_ENV = "WORKLOG_TEST_IMAP_PASSWORD";

function config(): Config {
  const c = defaultConfig();
  c.me = { name: "Alex Rivera", emails: ["alex@mycorp.example"], domains: ["mycorp.example"] };
  c.timezone = "UTC";
  c.sources.imap = {
    ...c.sources.imap,
    enabled: true,
    host: "imap.gmail.com",
    user: "alex@mycorp.example",
    passwordEnv: PASSWORD_ENV,
    mailboxes: ["INBOX"],
  };
  return c;
}

function recordingLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (msg: string) => void lines.push(`${level} ${msg}`);
  return { lines, debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
}

function ctx(c: Config, log: Logger): CollectContext {
  return { config: c, log, since: new Date("2024-03-04T00:00:00Z"), until: new Date("2024-03-05T00:00:00Z") };
}

class FakeMail implements MailClient {
  loggedOut = false;
  fetched: string[] = [];
  constructor(
    private boxes: Record<string, RawMail[] | Error>,
    private sent?: string,
    private failConnect = false,
  ) {}
  async connect() {
    if (this.failConnect) throw new Error("Invalid credentials (Failure)");
  }
  async sentMailbox() {
    return this.sent;
  }
  async fetchSince(mailbox: string) {
    this.fetched.push(mailbox);
    const v = this.boxes[mailbox];
    if (v instanceof Error) throw v;
    return v ?? [];
  }
  async logout() {
    this.loggedOut = true;
  }
}

describe("parseRawEmail", () => {
  it("parses a Google Groups message with raw headers", async () => {
    const m = await parseRawEmail({ source: eml("google-group.eml"), mailbox: "INBOX", threadId: "17900001" });
    assert.equal(m.messageId, "<CAF1root@mail.acme.example>");
    assert.equal(m.from?.email, "contact@mycorp.example");
    assert.equal(m.from?.name, "'Jane Doe' via Contact");
    assert.equal(m.headers["x-original-from"], "Jane Doe <jane@acme.example>");
    assert.equal(m.headers["precedence"], "list");
    assert.equal(m.gmThreadId, "17900001");
    assert.equal(m.date.toISOString(), "2024-03-04T09:00:00.000Z");
    assert.ok(m.text.includes("logistics platform"));
  });

  it("decodes quoted-printable replies and reads references", async () => {
    const m = await parseRawEmail({ source: eml("reply-fr.eml"), mailbox: "[Gmail]/Sent Mail" });
    assert.equal(m.inReplyTo, "CAF1root@mail.acme.example");
    assert.deepEqual(m.references, ["CAF1root@mail.acme.example"]);
    assert.ok(m.text.includes("ça nous intéresse"));
    assert.equal(m.date.toISOString(), "2024-03-04T10:30:00.000Z");
  });

  it("derives text from HTML-only mail and keeps folded List-Unsubscribe", async () => {
    const m = await parseRawEmail({ source: eml("newsletter.eml"), mailbox: "INBOX" });
    assert.ok(m.text.includes("Three new features shipped"));
    assert.ok(m.headers["list-unsubscribe"]?.includes("https://vendor.example/unsubscribe"));
  });
});

describe("mailboxesToScan", () => {
  it("adds the advertised Sent folder, or Gmail's default", () => {
    const imap = config().sources.imap;
    assert.deepEqual(mailboxesToScan(imap, "[Gmail]/Messages envoyés"), ["INBOX", "[Gmail]/Messages envoyés"]);
    assert.deepEqual(mailboxesToScan(imap, undefined), ["INBOX", "[Gmail]/Sent Mail"]);
    assert.deepEqual(mailboxesToScan({ ...imap, host: "imap.example.org" }, undefined), ["INBOX"]);
  });
});

describe("imapSource", () => {
  beforeEach(() => {
    process.env[PASSWORD_ENV] = "test-password";
  });
  afterEach(() => {
    delete process.env[PASSWORD_ENV];
  });

  it("is enabled only with user and password", () => {
    const src = createImapSource(() => new FakeMail({}));
    assert.equal(src.enabled(config()), true);
    delete process.env[PASSWORD_ENV];
    assert.equal(src.enabled(config()), false);
  });

  it("merges inbox and sent mail into one thread and logs out", async () => {
    const fake = new FakeMail({
      INBOX: [
        { source: eml("google-group.eml"), mailbox: "INBOX" },
        { source: eml("newsletter.eml"), mailbox: "INBOX" },
      ],
      "[Gmail]/Sent Mail": [{ source: eml("reply-fr.eml"), mailbox: "[Gmail]/Sent Mail" }],
    });
    const src = createImapSource(() => fake);
    const acts = await src.collect(ctx(config(), recordingLog()));
    assert.deepEqual(fake.fetched, ["INBOX", "[Gmail]/Sent Mail"]);
    assert.equal(fake.loggedOut, true);
    assert.equal(acts.length, 2);

    const thread = acts.find((a) => a.threadId === "imap:CAF1root@mail.acme.example");
    assert.ok(thread);
    assert.equal(thread.fromMe, true);
    assert.equal(thread.title, "Interested in a partnership");
    assert.ok(thread.text.startsWith("From: Jane Doe <jane@acme.example> | 2024-03-04T09:00:00.000Z"));
    assert.ok(thread.text.includes("Jeudi 14h ?"));
    assert.ok(!thread.text.includes("We run a logistics platform.\n"), "quoted history removed");
    assert.ok(!thread.text.includes("Head of Partnerships"), "signature removed");
    assert.equal(thread.meta?.viaGroup, "contact@mycorp.example");

    const digest = acts.find((a) => a.title === "Your weekly digest");
    assert.equal(digest?.meta?.listUnsubscribe, true);
    assert.equal(digest?.meta?.noReply, true);
  });

  it("filters messages outside the window precisely", async () => {
    const fake = new FakeMail({ INBOX: [{ source: eml("newsletter.eml"), mailbox: "INBOX" }] });
    const c = { ...ctx(config(), recordingLog()), since: new Date("2024-03-04T12:00:01Z") };
    assert.deepEqual(await createImapSource(() => fake).collect(c), []);
  });

  it("returns [] with a clear error when authentication fails, still logging out", async () => {
    const fake = new FakeMail({}, undefined, true);
    const log = recordingLog();
    assert.deepEqual(await createImapSource(() => fake).collect(ctx(config(), log)), []);
    assert.ok(log.lines.some((l) => l.startsWith("error imap: could not connect")));
    assert.equal(fake.loggedOut, true);
  });

  it("skips a broken mailbox and an unparseable message without throwing", async () => {
    const fake = new FakeMail({
      INBOX: new Error("Mailbox does not exist"),
      "[Gmail]/Sent Mail": [
        { source: Buffer.from("garbage without headers"), mailbox: "[Gmail]/Sent Mail" },
        { source: eml("reply-fr.eml"), mailbox: "[Gmail]/Sent Mail" },
      ],
    });
    const log = recordingLog();
    const acts = await createImapSource(() => fake).collect(ctx(config(), log));
    assert.equal(acts.length, 1);
    assert.ok(log.lines.some((l) => l.startsWith("warn imap: skipping mailbox INBOX")));
    assert.equal(fake.loggedOut, true);
  });
});
