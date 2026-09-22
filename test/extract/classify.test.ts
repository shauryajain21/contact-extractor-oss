import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyActivity,
  companyFromEmail,
  isJobInquiry,
  isSolicitation,
} from "../../src/extract/classify.js";
import type { Activity } from "../../src/types.js";
import { chat, commit, inboundEmail, outboundEmail, testConfig } from "./helpers.js";

const config = testConfig();

describe("classifyActivity", () => {
  it("flags an English job application", () => {
    const a = inboundEmail(
      "e1",
      { name: "Priya N", email: "priya.n@gmail.com" },
      "Hello",
      "Hi Sam,\n\nI am currently looking for an internship in backend engineering and would love to join your team.\nPlease find attached my CV.\n\nBest, Priya"
    );
    assert.equal(classifyActivity(a, config), "hiring");
  });

  it("flags a French spontaneous application", () => {
    const a = inboundEmail(
      "e2",
      { name: "Léa Martin", email: "lea.martin@orange.fr" },
      "Candidature spontanée - développeuse full-stack",
      "Bonjour,\n\nJe me permets de vous contacter afin de postuler. Vous trouverez ci-joint mon CV."
    );
    assert.equal(classifyActivity(a, config), "hiring");
  });

  it("flags German and Spanish applicant phrasing", () => {
    assert.ok(isJobInquiry("Anfrage", "Sehr geehrte Damen und Herren,\n\nhiermit bewerbe mich als Werkstudent."));
    assert.ok(isJobInquiry("Hola", "Hola,\n\nEstoy buscando trabajo como desarrolladora y adjunto mi CV."));
  });

  it("reads past the per-message header of thread-shaped email text", () => {
    const a = inboundEmail(
      "imap:t:1",
      { name: "Tom B", email: "tom.b@gmail.com" },
      "Quick hello",
      "From: Tom B <tom.b@gmail.com> | 2026-09-21T08:00:00.000Z\nHi Sam,\n\nI'm currently looking for a new job as a data engineer and wondered about your team."
    );
    assert.equal(classifyActivity(a, config), "hiring");
  });

  it("uses a CV attachment only together with job wording", () => {
    const withCv = { meta: { attachments: ["Jane_Doe_CV.pdf"] } };
    const job = inboundEmail("e3", { email: "jane@gmail.com" }, "Backend role", "Hi,\n\nSee attached.", withCv);
    const invoice = inboundEmail("e4", { email: "jane@gmail.com" }, "Invoice", "Hi,\n\nSee attached.", withCv);
    assert.equal(classifyActivity(job, config), "hiring");
    assert.equal(classifyActivity(invoice, config), null);
  });

  it("does not flag a customer who mentions hiring in passing", () => {
    const a = inboundEmail(
      "e5",
      { name: "Dana Lee", email: "dana@northwind.io" },
      "Seat expansion",
      "Hi Sam,\n\nWe're hiring fast this quarter and will need 20 more seats next month. We also have many open positions, so onboarding matters.\n\nCan you send updated pricing? Also, can we resume our call on Thursday?\n\nDana"
    );
    assert.equal(classifyActivity(a, config), null);
  });

  it("flags SEO and dev-shop solicitations as spam", () => {
    const seo = inboundEmail(
      "e6",
      { name: "Mark", email: "mark@rankboost-agency.com" },
      "Quick question about worklog.dev",
      "Hi,\n\nI came across your website and noticed it is not on the first page of Google. We offer SEO services and high quality backlinks at an affordable price.\n\nReply YES for a free audit."
    );
    const devshop = inboundEmail(
      "e7",
      { email: "bd@softhouse.example" },
      "Your next app",
      "Hello, we can build your app in 6 weeks with our dedicated developers."
    );
    assert.equal(classifyActivity(seo, config), "spam");
    assert.equal(classifyActivity(devshop, config), "spam");
  });

  it("keeps a genuine prospect out of spam", () => {
    const text = "Hi Sam,\n\nI came across your website and we'd like to roll worklog out to our 40-person team. What does pricing look like?";
    assert.equal(isSolicitation("Pricing for 40 seats", text), false);
  });

  it("flags newsletters from list headers and bulk sender addresses", () => {
    const listed = inboundEmail("n1", { email: "team@producthunt.example" }, "Top products", "This week…", {
      meta: { listUnsubscribe: true },
    });
    const noreply = inboundEmail("n2", { email: "no-reply@stripe.example" }, "Your receipt", "Receipt #123");
    const notif = inboundEmail("n3", { email: "notifications@github.example" }, "[repo] PR merged", "Merged.");
    assert.equal(classifyActivity(listed, config), "newsletter");
    assert.equal(classifyActivity(noreply, config), "newsletter");
    assert.equal(classifyActivity(notif, config), "newsletter");
  });

  it("marks mail among teammates as internal", () => {
    const a = inboundEmail("i1", { name: "Kai", email: "kai@worklog.dev" }, "Standup notes", "Shipped the parser.");
    assert.equal(classifyActivity(a, config), "internal");
    const slack: Activity = {
      id: "slack:1",
      source: "slack",
      kind: "message",
      at: "2026-09-21T09:00:00Z",
      text: "deploying now",
      participants: [{ name: "Kai", handle: "U_KAI", role: "from" }],
      fromMe: false,
    };
    assert.equal(classifyActivity(slack, config), "internal");
    const withEmail = { ...slack, participants: [{ name: "Kai", handle: "U_KAI", email: "kai@kai.me", role: "from" as const }] };
    assert.equal(classifyActivity(withEmail, config), "internal", "non-shared Slack is internal whatever the email");
    assert.equal(classifyActivity({ ...slack, meta: { isExternal: true } }, config), null);
  });

  it("never classifies the user's own chats, commits or my outbound mail as spam/newsletter", () => {
    assert.equal(classifyActivity(chat("c1", "worklog", "SEO services and backlinks landing page"), config), null);
    assert.equal(classifyActivity(commit("g1", "worklog", "add guest post backlink checker"), config), null);
    const mine = outboundEmail("o1", { email: "x@acme.io" }, "Re: backlinks", "No thanks, we don't buy backlinks or guest posts.");
    assert.equal(classifyActivity(mine, config), null);
  });

  it("does not treat calendar events as spam or newsletter", () => {
    const ev: Activity = {
      id: "cal:1",
      source: "calendar",
      kind: "event",
      at: "2026-09-21T15:00:00Z",
      title: "SEO services and backlinks webinar",
      text: "noreply",
      participants: [
        { email: "sam@worklog.dev", role: "attendee" },
        { email: "no-reply@events.example", role: "attendee" },
      ],
      fromMe: false,
      meta: { listUnsubscribe: true },
    };
    assert.equal(classifyActivity(ev, config), null);
  });
});

describe("companyFromEmail", () => {
  it("derives a readable name from the registrable domain", () => {
    assert.deepEqual(companyFromEmail("ana@acme-labs.io"), { domain: "acme-labs.io", name: "Acme Labs" });
    assert.deepEqual(companyFromEmail("bob@mail.northwind.co.uk"), { domain: "northwind.co.uk", name: "Northwind" });
    assert.deepEqual(companyFromEmail("Eve@Globex.COM"), { domain: "globex.com", name: "Globex" });
  });

  it("returns null for freemail and malformed addresses", () => {
    for (const e of ["x@gmail.com", "x@outlook.com", "x@proton.me", "x@qq.com", "x@163.com", "x@yandex.ru", "x@icloud.com"]) {
      assert.equal(companyFromEmail(e), null, e);
    }
    assert.equal(companyFromEmail("not-an-email"), null);
    assert.equal(companyFromEmail("x@localhost"), null);
  });
});
