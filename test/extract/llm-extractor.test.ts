import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmExtractor } from "../../src/extract/extract.js";
import { HeuristicExtractor } from "../../src/extract/heuristic.js";
import { buildSystemPrompt, serializeActivity, splitIntoBatches } from "../../src/extract/prompts.js";
import type { Activity, LlmRequest, ThreadState } from "../../src/types.js";
import { mixedFixture } from "./fixtures.js";
import { FakeProvider, ctxFor, inboundEmail, outboundEmail, recordingLogger, testConfig } from "./helpers.js";

const config = testConfig();

const goodReply = JSON.stringify({
  projects: [
    {
      name: "worklog",
      status: "active",
      summary: "IMAP source landed",
      progress: ["Added IMAP source", "Fixed thread merge"],
      refs: ["git:worklog:a1", "git:worklog:a2"],
    },
  ],
  contacts: [
    {
      name: "Ana Garcia",
      email: "ana@acme-labs.io",
      company: "Acme Labs",
      role: "Head of Ops",
      category: "prospect",
      summary: "Asked for a 20-seat quote; sent $40/seat",
      refs: ["imap:1", "imap:2"],
    },
  ],
  companies: [
    { name: "Acme Labs", domain: "acme-labs.io", category: "prospect", summary: "20-seat quote out", contacts: ["Ana Garcia"], refs: ["imap:1"] },
  ],
  threads: [
    { id: "t-acme", title: "Pricing for 20 seats", counterpart: "Ana Garcia", company: "Acme Labs", category: "prospect", waitingOn: "them", refs: ["imap:1", "imap:2"] },
    { id: "t-north", title: "Seat expansion", counterpart: "Dana Lee", category: "customer", waitingOn: "me", refs: ["imap:3"] },
  ],
  progress: ["worklog: IMAP source landed"],
  actions: ["Quoted Ana Garcia (Acme Labs) 20 seats at $40"],
  openQuestions: ["Dana Lee (Northwind) wants 20 more seats — owe pricing"],
  noticed: [],
});

describe("LlmExtractor", () => {
  it("drops rule-filtered activity before the LLM and returns the parsed digest", async () => {
    const provider = new FakeProvider([goodReply]);
    const log = recordingLogger();
    const known: Record<string, ThreadState> = {
      "t-north": {
        id: "t-north",
        title: "Seat expansion",
        counterpart: "Dana Lee",
        category: "customer",
        waitingOn: "me",
        since: "2026-09-19T08:00:00Z",
        lastActivityAt: "2026-09-19T08:00:00Z",
      },
      "t-old": {
        id: "t-old",
        title: "Unrelated",
        counterpart: "Zed",
        category: "other",
        waitingOn: "them",
        since: "2026-09-01T00:00:00Z",
        lastActivityAt: "2026-09-01T00:00:00Z",
      },
    };
    const d = await new LlmExtractor(provider).extract(mixedFixture(), ctxFor(config, known, log));

    assert.equal(provider.requests.length, 1);
    const req = provider.requests[0]!;
    assert.equal(req.json, true);
    assert.ok(!req.user.includes("imap:4"), "job application dropped before LLM");
    assert.ok(!req.user.includes("imap:5"), "SEO spam dropped before LLM");
    assert.ok(req.user.includes('"id":"imap:1"'));
    assert.ok(req.user.includes("from: Ana Garcia <ana@acme-labs.io>"));
    assert.ok(req.user.includes('"id":"t-north"'), "open known thread touched by the batch is included");
    assert.ok(!req.user.includes("t-old"), "untouched known threads are not sent");
    const filterLog = log.lines.find((l) => l.msg === "extract: rule filter");
    assert.deepEqual(filterLog?.extra?.dropped, { hiring: 1, spam: 1 });

    assert.equal(d.projects[0]?.name, "worklog");
    assert.deepEqual(d.projects[0]?.refs, [
      { activityId: "git:worklog:a1", source: "git" },
      { activityId: "git:worklog:a2", source: "git" },
    ]);
    const ana = d.contacts[0]!;
    assert.equal(ana.email, "ana@acme-labs.io");
    assert.equal(ana.domain, "acme-labs.io");
    assert.equal(ana.lastSeen, "2026-09-21T10:00:00Z");
    assert.deepEqual(ana.refs[1], { activityId: "imap:2", source: "imap", url: "https://mail.example/2" });
    assert.equal(d.companies[0]?.domain, "acme-labs.io");

    const north = d.threads.find((t) => t.id === "t-north")!;
    assert.equal(north.since, "2026-09-19T08:00:00Z", "known since carried over");
    const acme = d.threads.find((t) => t.id === "t-acme")!;
    assert.equal(acme.since, "2026-09-21T10:00:00Z");
    assert.equal(acme.lastActivityAt, "2026-09-21T10:00:00Z");
    assert.equal(acme.url, "https://mail.example/2");
    assert.deepEqual(d.actions, ["Quoted Ana Garcia (Acme Labs) 20 seats at $40"]);
  });

  it("coerces bad enums, unknown refs and invented fields", async () => {
    const acts: Activity[] = [
      inboundEmail("imap:1", { name: "Ana Garcia", email: "ana@acme-labs.io" }, "Pricing", "Quote for 20 seats please.", {
        threadId: "t-acme",
        url: "https://mail.example/1",
      }),
      {
        id: "git:worklog:a1",
        source: "git",
        kind: "commit",
        at: "2026-09-21T08:00:00Z",
        title: "Add IMAP source",
        text: "Add IMAP source",
        project: "worklog",
        participants: [],
        fromMe: true,
      },
      inboundEmail(
        "imap:9",
        { name: "Priya", email: "priya@gmail.com" },
        "Hello",
        "Hi,\n\nI am looking for an internship on your team."
      ),
    ];
    const reply = JSON.stringify({
      projects: [
        { name: "WORKLOG", status: "done", progress: ["- Added IMAP source", "Added IMAP source", 42], refs: ["git:worklog:a1", "nope"] },
        { name: "Ghost", status: "active", progress: ["x"], refs: ["nope"] },
        { status: "active", refs: ["git:worklog:a1"] },
      ],
      contacts: [
        { name: "  Ana   Garcia ", email: "ana@fake-domain.com", company: "Initech", category: "VIP", summary: "Wants a quote", refs: [{ activityId: "imap:1" }, "bogus"] },
        { name: "No Refs", category: "prospect", summary: "x", refs: [] },
        { name: "Ana Garcia", email: "ana@acme-labs.io", category: "prospect", summary: "second entry", refs: ["imap:1"] },
        { email: "ana@acme-labs.io", category: "other", summary: "nameless entry", refs: ["imap:1"] },
      ],
      companies: [
        { name: "Initech", category: "prospect", summary: "made up", contacts: [], refs: ["imap:1"] },
        { name: "Acme Labs", domain: "https://www.acme-labs.io/", category: "prospect", summary: "real", contacts: ["Ana Garcia"], refs: [] },
      ],
      threads: [
        { id: "made-up-id", title: "Pricing", counterpart: "Ana Garcia", category: "prospect", waitingOn: "maybe", refs: ["imap:1"] },
        { id: "t-none", title: "Nothing", counterpart: "Nobody", category: "other", waitingOn: "me", refs: [] },
        { id: "imap:9", title: "Internship", counterpart: "Priya", category: "prospect", waitingOn: "me", refs: ["imap:9"] },
      ],
      progress: ["* Shipped IMAP", "shipped imap", "", null],
      actions: "not an array",
      noticed: [{ text: "Ana is the 3rd Acme contact this month" }],
    });
    const cfg = testConfig({ filters: { dropCategories: ["spam"], ignoreDomains: [] } });
    const d = await new LlmExtractor(new FakeProvider([reply])).extract(acts, ctxFor(cfg));

    assert.deepEqual(d.projects, [
      {
        name: "worklog",
        status: "active",
        summary: "Added IMAP source",
        progress: ["Added IMAP source", "42"],
        refs: [{ activityId: "git:worklog:a1", source: "git" }],
      },
    ]);

    assert.equal(d.contacts.length, 1, "name-only and email duplicates merge; ref-less contacts drop");
    const ana = d.contacts[0]!;
    assert.equal(ana.name, "Ana Garcia");
    assert.equal(ana.email, "ana@acme-labs.io", "invented email dropped, real one merged in");
    assert.equal(ana.company, "Acme Labs", "ungrounded company replaced by the email domain's");
    assert.equal(ana.category, "prospect", "invalid enum clamps to other, merge prefers non-other");
    assert.deepEqual(ana.refs, [{ activityId: "imap:1", source: "imap", url: "https://mail.example/1" }]);

    assert.deepEqual(d.companies.map((c) => [c.name, c.domain, c.refs.length]), [["Acme Labs", "acme-labs.io", 1]]);

    const byId = new Map(d.threads.map((t) => [t.id, t]));
    assert.deepEqual([...byId.keys()].sort(), ["imap:9", "t-acme"]);
    assert.equal(byId.get("t-acme")!.waitingOn, "me", "invalid waitingOn derived from the last message");
    assert.equal(byId.get("imap:9")!.category, "hiring", "rule category wins over the LLM");

    assert.deepEqual(d.progress, ["Shipped IMAP"]);
    assert.deepEqual(d.actions, []);
    assert.deepEqual(d.noticed, ["Ana is the 3rd Acme contact this month"]);
  });

  it("repairs once, then falls back to the heuristic for that batch", async () => {
    const provider = new FakeProvider(["Sure! Here is your digest: none", "still not json"]);
    const log = recordingLogger();
    const ctx = ctxFor(config, {}, log);
    const d = await new LlmExtractor(provider).extract(mixedFixture(), ctx);
    const h = await new HeuristicExtractor().extract(
      mixedFixture().filter((a) => a.id !== "imap:4" && a.id !== "imap:5"),
      ctx
    );

    assert.equal(provider.requests.length, 2);
    assert.match(provider.requests[1]!.user, /could not be used \(no JSON object found/);
    assert.deepEqual(d, h);
    assert.ok(log.lines.some((l) => l.level === "warn" && /using heuristic/.test(l.msg)));
  });

  it("accepts JSON wrapped in prose or code fences on the first try", async () => {
    const provider = new FakeProvider(["```json\n" + goodReply + "\n```"]);
    const d = await new LlmExtractor(provider).extract(mixedFixture(), ctxFor(config));
    assert.equal(provider.requests.length, 1);
    assert.equal(d.contacts[0]?.name, "Ana Garcia");
  });

  it("falls back without a repair call when the provider throws", async () => {
    const provider = new FakeProvider([new Error("openai request failed with HTTP 500: boom")]);
    const log = recordingLogger();
    const d = await new LlmExtractor(provider).extract(mixedFixture(), ctxFor(config, {}, log));
    assert.equal(provider.requests.length, 1);
    assert.ok(d.projects.length > 0);
    assert.ok(log.lines.some((l) => l.level === "warn" && l.msg.includes("HTTP 500")));
  });

  it("splits into batches and merges duplicates across them", async () => {
    const ana = { name: "Ana Garcia", email: "ana@acme-labs.io" };
    const acts: Activity[] = [
      inboundEmail("imap:1", ana, "Pricing", "Quote for 20 seats? " + "x".repeat(300), { threadId: "t1", at: "2026-09-21T08:00:00Z" }),
      outboundEmail("imap:2", ana, "Re: Pricing", "20 seats at $40. " + "y".repeat(300), { threadId: "t1", at: "2026-09-21T09:00:00Z" }),
      inboundEmail("imap:3", ana, "Security review", "Can you fill our questionnaire? " + "z".repeat(300), {
        threadId: "t2",
        at: "2026-09-21T10:00:00Z",
      }),
    ];
    const replyFor = (req: LlmRequest) => {
      const first = req.user.includes('"id":"imap:1"');
      return JSON.stringify({
        projects: [{ name: "Sales", status: first ? "active" : "blocked", summary: "s", progress: [first ? "Quoted Acme" : "Security review started"], refs: [first ? "imap:1" : "imap:3"] }],
        contacts: [
          first
            ? { name: "Ana Garcia", email: "ana@acme-labs.io", category: "other", summary: "asked for pricing", refs: ["imap:1", "imap:2"] }
            : { name: "Ana Garcia", category: "prospect", summary: "sent security questionnaire", refs: ["imap:3"] },
        ],
        companies: [
          first
            ? { name: "Acme Labs", domain: "acme-labs.io", category: "prospect", summary: "quote", contacts: ["Ana Garcia"], refs: ["imap:1"] }
            : { name: "acme labs", category: "prospect", summary: "security review", contacts: ["Ana Garcia"], refs: ["imap:3"] },
        ],
        threads: first
          ? [{ id: "t1", title: "Pricing", counterpart: "Ana Garcia", category: "prospect", waitingOn: "them", refs: ["imap:1", "imap:2"] }]
          : [{ id: "t2", title: "Security review", counterpart: "Ana Garcia", category: "prospect", waitingOn: "me", refs: ["imap:3"] }],
        progress: [first ? "Quoted Acme 20 seats at $40" : "quoted acme 20 seats at $40"],
        actions: [],
        openQuestions: first ? [] : ["Ana Garcia wants the security questionnaire"],
        noticed: [],
      });
    };
    const cfg = testConfig({ limits: { maxActivityChars: 4000, batchChars: 1200 } });
    const batches = splitIntoBatches(acts, cfg.limits.batchChars);
    assert.deepEqual(batches.map((b) => b.map((a) => a.id)), [["imap:1", "imap:2"], ["imap:3"]], "thread stays together");

    const provider = new FakeProvider([replyFor]);
    const d = await new LlmExtractor(provider).extract(acts, ctxFor(cfg));
    assert.equal(provider.requests.length, 2);
    assert.match(provider.requests[0]!.user, /Batch 1 of 2/);

    assert.equal(d.contacts.length, 1);
    const c = d.contacts[0]!;
    assert.equal(c.email, "ana@acme-labs.io");
    assert.equal(c.category, "prospect");
    assert.equal(c.summary, "sent security questionnaire");
    assert.equal(c.lastSeen, "2026-09-21T10:00:00Z");
    assert.deepEqual(c.refs.map((r) => r.activityId), ["imap:1", "imap:2", "imap:3"]);

    assert.equal(d.companies.length, 1);
    assert.equal(d.companies[0]!.domain, "acme-labs.io");
    assert.equal(d.companies[0]!.refs.length, 2);

    assert.equal(d.projects.length, 1);
    assert.equal(d.projects[0]!.status, "blocked", "latest batch's status wins");
    assert.deepEqual(d.projects[0]!.progress, ["Quoted Acme", "Security review started"]);

    assert.deepEqual(d.threads.map((t) => [t.id, t.waitingOn]), [["t2", "me"], ["t1", "them"]]);
    assert.deepEqual(d.progress, ["Quoted Acme 20 seats at $40"]);
  });

  it("returns an empty digest without calling the LLM when everything is filtered", async () => {
    const provider = new FakeProvider([goodReply]);
    const spam = inboundEmail("imap:5", { email: "mark@rankboost-agency.com" }, "Rank #1", "SEO services and backlinks.");
    const d = await new LlmExtractor(provider).extract([spam], ctxFor(config));
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(d.contacts, []);
    assert.deepEqual(d.progress, []);
  });
});

describe("prompts", () => {
  it("carries the house style, categories and the user's identity", () => {
    const p = buildSystemPrompt(config);
    assert.match(p, /Sam Rivera/);
    assert.match(p, /sam@worklog\.dev/);
    assert.match(p, /worklog\.dev/);
    for (const c of ["customer", "prospect", "partnership", "vendor", "hiring", "internal", "personal", "newsletter", "spam", "other"]) {
      assert.match(p, new RegExp(`- ${c}: `));
    }
    assert.match(p, /translated from <Language>/);
    assert.match(p, /balance \$34, \+65% WoW/);
    assert.match(p, /Nothing to report is a valid answer/);
    assert.match(p, /"waitingOn": "me"\|"them"\|"nobody"/);
  });

  it("serializes compactly, labelling the Slack workspace and non-English mail", () => {
    const slack: Activity = {
      id: "slack:C1:1",
      source: "slack",
      kind: "message",
      at: "2026-09-21T09:00:00Z",
      title: "#acme-shared: can we get SSO?",
      text: "Ana: can we get SSO?",
      threadId: "slack:C1:1",
      participants: [{ name: "Ana Garcia", handle: "U_ANA", role: "from" }],
      fromMe: false,
      meta: { isExternal: true, workspace: "Worklog HQ" },
    };
    const line = JSON.parse(serializeActivity(slack)) as Record<string, unknown>;
    assert.equal(line.project, undefined);
    assert.equal(line.workspace, "Worklog HQ");
    assert.deepEqual(line.participants, ["from: Ana Garcia"]);
    assert.equal(line.url, undefined);

    const fr = inboundEmail("imap:fr", { name: "Luc", email: "luc@societe.fr" }, "Devis", "Bonjour, pouvez-vous…", {
      meta: { language: "fr" },
    });
    assert.equal((JSON.parse(serializeActivity(fr)) as { language?: string }).language, "fr");
    assert.equal(serializeActivity({ ...fr, text: "x".repeat(50) }, 10).includes("x".repeat(11)), false);
  });

  it("splits an oversized thread across batches in time order", () => {
    const long = (id: string, at: string) =>
      inboundEmail(id, { email: "a@b.io" }, "Long", "x".repeat(500), { threadId: "t", at });
    const batches = splitIntoBatches([long("m3", "2026-09-21T03:00:00Z"), long("m1", "2026-09-21T01:00:00Z"), long("m2", "2026-09-21T02:00:00Z")], 700);
    assert.deepEqual(batches.map((b) => b.map((a) => a.id)), [["m1"], ["m2"], ["m3"]]);
  });
});
