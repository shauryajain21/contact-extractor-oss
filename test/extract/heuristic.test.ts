import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeuristicExtractor } from "../../src/extract/heuristic.js";
import type { Activity, ThreadState } from "../../src/types.js";
import { mixedFixture } from "./fixtures.js";
import { ctxFor, testConfig } from "./helpers.js";

describe("HeuristicExtractor", () => {
  const config = testConfig();
  const known: Record<string, ThreadState> = {
    "t-north": {
      id: "t-north",
      title: "Seat expansion",
      counterpart: "Dana Lee",
      category: "other",
      waitingOn: "me",
      since: "2026-09-19T08:00:00Z",
      lastActivityAt: "2026-09-19T08:00:00Z",
    },
    "t-acme": {
      id: "t-acme",
      title: "Pricing for 20 seats",
      counterpart: "Ana Garcia",
      category: "prospect",
      waitingOn: "me",
      since: "2026-09-18T08:00:00Z",
      lastActivityAt: "2026-09-18T08:00:00Z",
    },
  };

  it("builds a digest from mixed activity", async () => {
    const d = await new HeuristicExtractor().extract(mixedFixture(), ctxFor(config, known));

    assert.deepEqual(d.window, { since: "2026-09-21T00:00:00.000Z", until: "2026-09-22T00:00:00.000Z" });

    assert.deepEqual(
      d.projects.map((p) => [p.name, p.status, p.progress]),
      [
        ["billing-api", "active", ["Debug Stripe webhook retries"]],
        ["worklog", "active", ["Add IMAP source", "Fix thread merge", "Design digest schema"]],
      ]
    );
    assert.equal(d.projects.find((p) => p.name === "worklog")?.refs.length, 4);

    const byEmail = new Map(d.contacts.map((c) => [c.email, c]));
    assert.deepEqual([...byEmail.keys()].sort(), [
      "ana@acme-labs.io",
      "chris.park@gmail.com",
      "dana@northwind.io",
      "omar@globex.com",
    ]);
    const anaC = byEmail.get("ana@acme-labs.io")!;
    assert.equal(anaC.company, "Acme Labs");
    assert.equal(anaC.domain, "acme-labs.io");
    assert.equal(anaC.lastSeen, "2026-09-21T10:00:00Z");
    assert.equal(anaC.summary, "Re: Pricing for 20 seats");
    assert.equal(anaC.refs.length, 2);
    assert.equal(byEmail.get("chris.park@gmail.com")!.company, undefined, "freemail sender has no company");
    assert.equal(byEmail.get("omar@globex.com")!.summary, "Globex intro call");
    assert.ok(!d.contacts.some((c) => c.email === "kai@worklog.dev"), "teammates are not contacts");
    assert.ok(!d.contacts.some((c) => c.email?.includes("priya") || c.email?.includes("rankboost")), "dropped categories");

    assert.deepEqual(d.companies.map((c) => c.name), ["Acme Labs", "Globex", "Northwind"]);
    assert.deepEqual(d.companies.find((c) => c.name === "Acme Labs")?.contacts, ["Ana Garcia"]);

    const threads = new Map(d.threads.map((t) => [t.id, t]));
    assert.deepEqual([...threads.keys()].sort(), ["t-acme", "t-chris", "t-north"]);
    const acme = threads.get("t-acme")!;
    assert.equal(acme.waitingOn, "them");
    assert.equal(acme.since, "2026-09-21T10:00:00Z", "waiting side changed, so since resets");
    assert.equal(acme.company, "Acme Labs");
    assert.equal(acme.title, "Pricing for 20 seats");
    assert.equal(acme.url, "https://mail.example/2");
    const north = threads.get("t-north")!;
    assert.equal(north.waitingOn, "me");
    assert.equal(north.since, "2026-09-19T08:00:00Z", "unchanged waiting side keeps the known since");

    assert.deepEqual(d.progress, [
      "billing-api: 1 chat — Debug Stripe webhook retries",
      "worklog: 3 commits, 1 chat — Add IMAP source; Fix thread merge; Design digest schema",
    ]);
    assert.deepEqual(d.actions, ["Replied to Ana Garcia re: Pricing for 20 seats"]);
    assert.deepEqual(d.openQuestions, [
      "Reply to Chris Park re: Dinner Friday? — waiting since 2026-09-21",
      "Reply to Dana Lee (Northwind) re: Seat expansion — waiting since 2026-09-19",
    ]);
    assert.deepEqual(d.noticed, []);
  });

  it("handles thread-shaped email and external Slack from the real sources", async () => {
    const acts: Activity[] = [
      {
        id: "imap:k:2",
        source: "imap",
        kind: "email",
        at: "2026-09-21T10:00:00Z",
        title: "Pilot next steps",
        text: "From: Ana <ana@acme-labs.io> | 2026-09-21T09:00:00.000Z\nCan we start Monday?\n\nFrom: Sam <sam@worklog.dev> | 2026-09-21T10:00:00.000Z\nYes, Monday works.",
        threadId: "imap:k",
        participants: [
          { name: "Ana Garcia", email: "ana@acme-labs.io", role: "from" },
          { name: "Sam Rivera", email: "sam@worklog.dev", role: "from" },
        ],
        fromMe: true,
      },
      {
        id: "slack:C9:1",
        source: "slack",
        kind: "message",
        at: "2026-09-21T11:00:00Z",
        title: "#globex-shared: SSO question",
        text: "Omar: does SSO support Okta?",
        threadId: "slack:C9:1",
        participants: [
          { name: "Omar Haddad", handle: "U_OMAR", email: "omar@globex.com", role: "from" },
          { name: "Kai", handle: "U_KAI", email: "kai@worklog.dev", role: "mention" },
        ],
        fromMe: false,
        meta: { isExternal: true, isDm: false, workspace: "Worklog HQ" },
      },
      {
        id: "slack:C2:1",
        source: "slack",
        kind: "message",
        at: "2026-09-21T12:00:00Z",
        title: "#eng: deploy",
        text: "Kai: deploying",
        participants: [{ name: "Kai", handle: "U_KAI", email: "kai@kai.me", role: "from" }],
        fromMe: false,
        meta: { isExternal: false, isDm: false, workspace: "Worklog HQ" },
      },
    ];
    const d = await new HeuristicExtractor().extract(acts, ctxFor(testConfig()));
    assert.deepEqual(d.projects, [], "the Slack workspace is not a project");
    assert.deepEqual(d.contacts.map((c) => c.name), ["Ana Garcia", "Omar Haddad"]);
    assert.deepEqual(d.actions, ["Replied to Ana Garcia re: Pilot next steps"]);
    assert.deepEqual(
      d.threads.map((t) => [t.id, t.waitingOn, t.counterpart]),
      [
        ["slack:C9:1", "me", "Omar Haddad"],
        ["imap:k", "them", "Ana Garcia"],
      ]
    );
  });

  it("honours ignoreDomains and keeps hiring when it is not dropped", async () => {
    const cfg = testConfig({ filters: { dropCategories: ["spam"], ignoreDomains: ["northwind.io"] } });
    const d = await new HeuristicExtractor().extract(mixedFixture(), ctxFor(cfg));
    assert.ok(!d.contacts.some((c) => c.domain === "northwind.io"));
    assert.equal(d.contacts.find((c) => c.email === "priya.n@gmail.com")?.category, "hiring");
    assert.ok(!d.contacts.some((c) => c.email?.includes("rankboost")));
  });
});
