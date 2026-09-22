import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanBody,
  fitNewest,
  groupEmailThreads,
  normalizeMessageId,
  normalizeSubject,
  parseAddress,
  parseMessageIdList,
  resolveSender,
  stripQuotes,
  stripSignature,
  threadKey,
  type EmailMessage,
  type GroupOptions,
} from "../../src/sources/email-util.js";

const me = { name: "Alex Rivera", emails: ["alex@mycorp.example"], domains: ["mycorp.example"] };
const opts: GroupOptions = { me, ignoreDomains: ["mailer.example"], maxChars: 4000 };

function msg(p: Omit<Partial<EmailMessage>, "date"> & { messageId: string; date: string }): EmailMessage {
  return {
    references: [],
    replyTo: [],
    to: [],
    cc: [],
    text: "",
    headers: {},
    ...p,
    date: new Date(p.date),
  };
}

describe("message ids", () => {
  it("normalizes angle brackets and whitespace", () => {
    assert.equal(normalizeMessageId(" <abc@host.example> "), "abc@host.example");
    assert.equal(normalizeMessageId("abc@host.example"), "abc@host.example");
    assert.equal(normalizeMessageId(""), undefined);
  });

  it("parses reference lists", () => {
    assert.deepEqual(parseMessageIdList("<a@x> <b@x>\r\n <c@x>"), ["a@x", "b@x", "c@x"]);
    assert.deepEqual(parseMessageIdList(["<a@x>", "<b@x>"]), ["a@x", "b@x"]);
    assert.deepEqual(parseMessageIdList(undefined), []);
  });
});

describe("parseAddress", () => {
  it("handles quoted names, bare and parenthesised forms", () => {
    assert.deepEqual(parseAddress('"Doe, Jane" <Jane@Acme.example>'), { name: "Doe, Jane", email: "jane@acme.example" });
    assert.deepEqual(parseAddress("jane@acme.example"), { name: undefined, email: "jane@acme.example" });
    assert.deepEqual(parseAddress("jane@acme.example (Jane Doe)"), { name: "Jane Doe", email: "jane@acme.example" });
    assert.equal(parseAddress("not an address"), undefined);
  });
});

describe("stripQuotes", () => {
  it("cuts English attribution, even when wrapped over two lines", () => {
    const text = "Sounds good, Thursday works.\n\nOn Mon, Mar 4, 2024 at 10:02 AM Jane Doe <\njane@acme.example> wrote:\n> Can we meet?\n> Thanks";
    assert.equal(cleanBody(text), "Sounds good, Thursday works.");
  });

  it("cuts French attribution with a non-breaking space before the colon", () => {
    const text = "Merci, c'est noté.\n\nLe lun. 4 mars 2024 à 10:02, Jeanne Dupont <jeanne@acme.example> a écrit\u00a0:\n> Bonjour";
    assert.equal(cleanBody(text), "Merci, c'est noté.");
  });

  it("cuts German attribution", () => {
    const text = "Passt, bis Donnerstag.\n\nAm 04.03.2024 um 10:02 schrieb Hans Muster <hans@acme.example>:\n> Hallo";
    assert.equal(cleanBody(text), "Passt, bis Donnerstag.");
  });

  it("cuts Outlook-style header blocks and Original Message separators", () => {
    const outlook = "Approved.\n\nFrom: Jane Doe <jane@acme.example>\nSent: Monday, March 4, 2024 10:02 AM\nTo: Alex\nSubject: PO";
    assert.equal(cleanBody(outlook), "Approved.");
    const fr = "Validé.\n\nDe : Jeanne Dupont\nEnvoyé : lundi 4 mars 2024 10:02\nÀ : Alex";
    assert.equal(cleanBody(fr), "Validé.");
    const orig = "Ok.\n-----Original Message-----\nFrom: someone";
    assert.equal(cleanBody(orig), "Ok.");
  });

  it("drops stray > lines but keeps normal text starting with On", () => {
    const text = "On second thought, let's ship Friday.\n> quoted\nThanks";
    assert.equal(stripQuotes(text), "On second thought, let's ship Friday.\nThanks");
  });
});

describe("stripSignature", () => {
  it("cuts at the standard delimiter and mobile footers", () => {
    assert.equal(stripSignature("Hi there\n-- \nJane Doe\nCEO").trim(), "Hi there");
    assert.equal(stripSignature("Quick yes\n\nSent from my iPhone").trim(), "Quick yes");
    assert.equal(stripSignature("Oui\n\nEnvoyé de mon iPhone").trim(), "Oui");
  });
});

describe("resolveSender", () => {
  const groupFrom = { name: "'Jane Doe' via Contact", email: "contact@mycorp.example" };

  it("prefers X-Original-From", () => {
    const r = resolveSender(groupFrom, [], { "x-original-from": "Jane Doe <jane@acme.example>" });
    assert.deepEqual(r.sender, { name: "Jane Doe", email: "jane@acme.example" });
    assert.equal(r.viaGroup, "contact@mycorp.example");
  });

  it("falls back to Reply-To with the name from the via pattern", () => {
    const r = resolveSender(groupFrom, [{ email: "jane@acme.example" }], {});
    assert.deepEqual(r.sender, { name: "Jane Doe", email: "jane@acme.example" });
  });

  it("keeps only the name when the real address is unknown", () => {
    const r = resolveSender(groupFrom, [], {});
    assert.deepEqual(r.sender, { name: "Jane Doe" });
  });

  it("leaves ordinary senders alone", () => {
    const from = { name: "Jane Doe", email: "jane@acme.example" };
    assert.deepEqual(resolveSender(from, [], {}).sender, from);
  });
});

describe("subjects and fitting", () => {
  it("strips reply/forward prefixes in several languages", () => {
    assert.equal(normalizeSubject("Re: RE: Fwd: Pricing"), "Pricing");
    assert.equal(normalizeSubject("AW: WG: Angebot"), "Angebot");
    assert.equal(normalizeSubject("TR: Devis"), "Devis");
  });

  it("keeps the newest blocks when over budget", () => {
    const blocks = ["a".repeat(500), "b".repeat(500), "c".repeat(500)];
    const out = fitNewest(blocks, 1150);
    assert.ok(out.endsWith("c".repeat(500)));
    assert.ok(out.includes("b".repeat(500)));
    assert.ok(out.startsWith("[1 earlier message omitted]"));
    const trimmed = fitNewest(blocks, 1400);
    assert.ok(trimmed.startsWith("a".repeat(100)));
    assert.ok(trimmed.includes("…[truncated]"));
    assert.ok(trimmed.length <= 1400);
  });
});

describe("groupEmailThreads", () => {
  const root = msg({
    messageId: "<root@acme.example>",
    date: "2024-03-04T09:00:00Z",
    subject: "Partnership idea",
    from: { name: "Jane Doe", email: "jane@acme.example" },
    to: [{ name: "Alex Rivera", email: "alex@mycorp.example" }],
    cc: [{ email: "sam@acme.example" }],
    text: "Hi Alex, want to partner?\n-- \nJane",
  });
  const reply = msg({
    messageId: "<r1@mycorp.example>",
    inReplyTo: "<root@acme.example>",
    references: ["<root@acme.example>"],
    date: "2024-03-04T10:00:00Z",
    subject: "Re: Partnership idea",
    from: { name: "Alex Rivera", email: "alex@mycorp.example" },
    to: [{ email: "jane@acme.example" }],
    text: "Yes, let's talk.\n\nOn Mon, Mar 4, 2024 Jane Doe <jane@acme.example> wrote:\n> Hi Alex",
  });
  const followUpWithoutRefs = msg({
    messageId: "<r2@acme.example>",
    inReplyTo: "<r1@mycorp.example>",
    date: "2024-03-04T11:00:00Z",
    subject: "Re: Partnership idea",
    from: { name: "Jane Doe", email: "jane@acme.example" },
    text: "Great, Thursday?",
  });

  it("groups a thread by its root and orders blocks", () => {
    const [a, ...rest] = groupEmailThreads([followUpWithoutRefs, reply, root], opts);
    assert.equal(rest.length, 0);
    assert.ok(a);
    assert.equal(a.threadId, "imap:root@acme.example");
    assert.equal(a.id, "imap:root@acme.example:r2@acme.example");
    assert.equal(a.title, "Partnership idea");
    assert.equal(a.kind, "email");
    assert.equal(a.at, "2024-03-04T11:00:00.000Z");
    assert.equal(a.fromMe, false);
    assert.equal(a.meta?.lastSenderIsMe, false);
    assert.deepEqual(a.meta?.messageIds, ["root@acme.example", "r1@mycorp.example", "r2@acme.example"]);
    const blocks = a.text.split("\n\n");
    assert.equal(blocks[0], "From: Jane Doe <jane@acme.example> | 2024-03-04T09:00:00.000Z\nHi Alex, want to partner?");
    assert.equal(blocks[1], "From: Alex Rivera <alex@mycorp.example> | 2024-03-04T10:00:00.000Z\nYes, let's talk.");
    assert.ok(!a.text.includes("> Hi Alex"));
    const roles = Object.fromEntries(a.participants.map((p) => [p.email, p.role]));
    assert.deepEqual(roles, { "jane@acme.example": "from", "alex@mycorp.example": "from", "sam@acme.example": "cc" });
  });

  it("sets fromMe when I sent the last message", () => {
    const [a] = groupEmailThreads([root, reply], opts);
    assert.equal(a?.fromMe, true);
    assert.equal(a?.meta?.lastSenderIsMe, true);
  });

  it("prefers the Gmail thread id when present", () => {
    const withGm = [root, reply].map((m) => ({ ...m, gmThreadId: "1790000000000000001" }));
    assert.equal(threadKey(withGm), "gm:1790000000000000001");
    assert.equal(groupEmailThreads(withGm, opts)[0]?.threadId, "imap:gm:1790000000000000001");
  });

  it("dedupes the same message seen in two mailboxes", () => {
    const acts = groupEmailThreads([root, { ...root, mailbox: "[Gmail]/Sent Mail" }], opts);
    assert.equal(acts.length, 1);
    assert.equal(acts[0]?.meta?.messageCount, 1);
  });

  it("skips threads whose external senders are all on ignored domains", () => {
    const promo = msg({
      messageId: "<p@mailer.example>",
      date: "2024-03-04T09:00:00Z",
      from: { email: "news@news.mailer.example" },
      text: "Big sale",
    });
    assert.equal(groupEmailThreads([promo], opts).length, 0);
    const mine = msg({ messageId: "<m@mycorp.example>", date: "2024-03-04T09:00:00Z", from: me.emails.map((e) => ({ email: e }))[0], text: "cold outreach" });
    assert.equal(groupEmailThreads([mine], opts).length, 1);
  });

  it("flags newsletters and no-reply senders", () => {
    const n = msg({
      messageId: "<n@vendor.example>",
      date: "2024-03-04T09:00:00Z",
      from: { email: "no-reply@vendor.example" },
      headers: { "list-unsubscribe": "<mailto:u@vendor.example>", precedence: "bulk" },
      text: "Your weekly digest",
    });
    const [a] = groupEmailThreads([n], opts);
    assert.equal(a?.meta?.listUnsubscribe, true);
    assert.equal(a?.meta?.precedenceBulk, true);
    assert.equal(a?.meta?.noReply, true);
  });

  it("resolves Google Groups senders in participants and text", () => {
    const g = msg({
      messageId: "<g@groups.example>",
      date: "2024-03-04T09:00:00Z",
      from: { name: "'Jane Doe' via Contact", email: "contact@mycorp.example" },
      replyTo: [{ name: "Jane Doe", email: "jane@acme.example" }],
      text: "Hello from the contact form",
    });
    const [a] = groupEmailThreads([g], opts);
    assert.ok(a?.text.startsWith("From: Jane Doe <jane@acme.example>"));
    assert.deepEqual(a?.participants.find((p) => p.role === "from"), { name: "Jane Doe", email: "jane@acme.example", role: "from" });
    assert.equal(a?.meta?.viaGroup, "contact@mycorp.example");
    assert.deepEqual(a?.meta?.externalDomains, ["acme.example"]);
  });

  it("redacts secrets in bodies", () => {
    const s = msg({
      messageId: "<s@acme.example>",
      date: "2024-03-04T09:00:00Z",
      from: { email: "jane@acme.example" },
      text: "here is the key sk-proj-abcdefghijklmnopqrstuvwxyz0123",
    });
    const [a] = groupEmailThreads([s], opts);
    assert.ok(a?.text.includes("[redacted:api-key]"));
    assert.ok(!a?.text.includes("sk-proj-"));
  });
});
