import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Contact, ThreadState } from "../../src/types.js";
import { writeDigest } from "../../src/vault/index.js";
import { blockLines, readFrontmatter } from "../../src/vault/markdown.js";
import { digest, read, tempDir, testConfig } from "./helpers.js";

const NOW = new Date("2026-09-22T16:00:00Z");

const anna: Contact = {
  name: "Anna Lee",
  email: "anna@globex.com",
  company: "Globex",
  domain: "globex.com",
  category: "customer",
  summary: "Asked for the Q4 renewal quote",
  lastSeen: "2026-09-22T14:00:00Z",
  refs: [{ activityId: "imap:1", source: "imap", url: "https://mail.example/1" }],
};

test("daily note is created with header and sections, and a second run adds only new lines", (t) => {
  const config = testConfig(tempDir(t));
  const first = writeDigest(
    digest({ progress: ["Shipped the importer", "Fixed login bug"], actions: ["Replied to Anna"], contacts: [anna] }),
    { config, now: NOW, threads: {} }
  );
  assert.ok(first.created.includes("Log/2026-09-22.md"));
  const note1 = read(config, "Log/2026-09-22.md");
  assert.ok(note1.startsWith("Week [[2026-W39]] · [[Dashboard]]\n"));
  for (const h of ["## Progress", "## Actions taken", "## Open questions", "## Noticed", "## People"]) {
    assert.ok(note1.includes(`\n${h}\n`), h);
  }
  assert.deepEqual(blockLines(note1, "progress"), ["- Shipped the importer", "- Fixed login bug"]);
  assert.deepEqual(blockLines(note1, "people"), ["- [[Anna Lee]] (Globex) — Asked for the Q4 renewal quote"]);

  const second = writeDigest(
    digest({
      progress: ["fixed login bug.", "Wrote the dashboard"],
      actions: ["Replied to Anna"],
      contacts: [{ ...anna, summary: "Sent the signed contract" }],
    }),
    { config, now: new Date("2026-09-22T20:00:00Z"), threads: {} }
  );
  assert.ok(second.updated.includes("Log/2026-09-22.md"));
  const note2 = read(config, "Log/2026-09-22.md");
  assert.deepEqual(blockLines(note2, "progress"), ["- Shipped the importer", "- Fixed login bug", "- Wrote the dashboard"]);
  assert.deepEqual(blockLines(note2, "actions"), ["- Replied to Anna"]);
  assert.equal(blockLines(note2, "people").length, 1);
});

test("a line the user wrote themselves prevents the duplicate and is left as is", (t) => {
  const config = testConfig(tempDir(t));
  mkdirSync(join(config.vault, "Log"));
  const mine = "My own heading\n\n## Progress\n- Talked to **Globex** about pricing!\n\nfree text\n";
  writeFileSync(join(config.vault, "Log/2026-09-22.md"), mine);
  writeDigest(digest({ progress: ["talked to Globex about pricing", "New thing"] }), { config, now: NOW, threads: {} });
  const note = read(config, "Log/2026-09-22.md");
  assert.ok(note.startsWith("My own heading\n\n## Progress\n- Talked to **Globex** about pricing!\n"));
  assert.deepEqual(blockLines(note, "progress"), ["- New thing"]);
  assert.ok(note.includes("\nfree text\n"));
});

test("people, company and project notes", (t) => {
  const config = testConfig(tempDir(t));
  const d = digest({
    contacts: [anna],
    companies: [
      {
        name: "Globex",
        domain: "globex.com",
        category: "customer",
        summary: "Renewal in Q4",
        contacts: ["Anna Lee"],
        refs: [],
      },
    ],
    projects: [
      { name: "Worklog CLI", status: "active", summary: "Vault writer done", progress: ["Wrote vault writer"], refs: [] },
    ],
  });
  writeDigest(d, { config, now: NOW, threads: {} });

  const person = read(config, "People/Anna Lee.md");
  const pfm = readFrontmatter(person);
  assert.equal(pfm.email, "anna@globex.com");
  assert.equal(pfm.company, "Globex");
  assert.equal(pfm.category, "customer");
  assert.equal(pfm.last_seen, "2026-09-22");
  assert.deepEqual(pfm.tags, ["worklog/person"]);
  assert.ok(person.includes("\nCompany: [[Globex]]\n"));
  assert.deepEqual(blockLines(person, "timeline"), [
    "- 2026-09-22 · Asked for the Q4 renewal quote · [imap](https://mail.example/1)",
  ]);

  const company = read(config, "Companies/Globex.md");
  assert.equal(readFrontmatter(company).domain, "globex.com");
  assert.deepEqual(readFrontmatter(company).tags, ["worklog/company"]);
  assert.deepEqual(blockLines(company, "people"), ["- [[Anna Lee]]"]);
  assert.deepEqual(blockLines(company, "timeline"), ["- 2026-09-22 · Renewal in Q4"]);

  const project = read(config, "Projects/Worklog CLI.md");
  assert.equal(readFrontmatter(project).status, "active");
  assert.equal(readFrontmatter(project).last_update, "2026-09-22");
  assert.deepEqual(blockLines(project, "status"), ["**active** — Vault writer done"]);
  assert.deepEqual(blockLines(project, "progress"), ["- 2026-09-22 · Wrote vault writer"]);

  // user edits outside blocks survive, timeline stays deduped and newest first
  writeFileSync(join(config.vault, "People/Anna Lee.md"), person + "\nMy private notes about Anna.\n");
  writeDigest(
    digest({ contacts: [{ ...anna, lastSeen: "2026-09-24T15:00:00Z", summary: "Signed" }, anna] }),
    { config, now: new Date("2026-09-24T16:00:00Z"), threads: {} }
  );
  const person2 = read(config, "People/Anna Lee.md");
  assert.ok(person2.includes("\nMy private notes about Anna.\n"));
  assert.equal(readFrontmatter(person2).last_seen, "2026-09-24");
  assert.deepEqual(blockLines(person2, "timeline"), [
    "- 2026-09-24 · Signed · [imap](https://mail.example/1)",
    "- 2026-09-22 · Asked for the Q4 renewal quote · [imap](https://mail.example/1)",
  ]);
});

test("dashboard tables come from the merged threads map with ages, oldest first", (t) => {
  const config = testConfig(tempDir(t));
  const thread = (id: string, over: Partial<ThreadState>): ThreadState => ({
    id,
    title: `Thread ${id}`,
    counterpart: "Anna Lee",
    company: "Globex",
    category: "customer",
    waitingOn: "me",
    since: "2026-09-20T15:00:00Z",
    lastActivityAt: "2026-09-21T15:00:00Z",
    ...over,
  });
  const threads: Record<string, ThreadState> = {
    a: thread("a", { since: "2026-09-20T15:00:00Z", url: "https://mail.example/a" }),
    b: thread("b", { since: "2026-09-15T15:00:00Z", counterpart: "Bob Roe", company: undefined }),
    c: thread("c", { waitingOn: "them", counterpart: "Cara Poe" }),
    nobody: thread("nobody", { waitingOn: "nobody" }),
    old: thread("old", { since: "2026-07-01T15:00:00Z", lastActivityAt: "2026-07-02T15:00:00Z" }),
    spam: thread("spam", { category: "spam" }),
  };
  writeDigest(digest(), { config, now: NOW, threads });
  const dash = read(config, "Dashboard.md");
  const inner = blockLines(dash, "dashboard").join("\n");
  const mine = inner.slice(inner.indexOf("### Waiting on me"), inner.indexOf("### Waiting on them"));
  assert.match(mine, /\| \[\[Bob Roe\]\] \|  \| Thread b \| 2026-09-15 \| 7 \|/);
  assert.match(mine, /\| \[\[Anna Lee\]\] \| \[\[Globex\]\] \| \[Thread a\]\(https:\/\/mail.example\/a\) \| 2026-09-20 \| 2 \|/);
  assert.ok(mine.indexOf("Bob Roe") < mine.indexOf("Anna Lee"), "oldest first");
  assert.ok(!inner.includes("Thread nobody") && !inner.includes("Thread old") && !inner.includes("Thread spam"));
  const theirs = inner.slice(inner.indexOf("### Waiting on them"), inner.indexOf("### Active projects"));
  assert.match(theirs, /Cara Poe/);
  const people = inner.slice(inner.indexOf("### People this week"));
  assert.match(people, /\[\[Anna Lee\]\]/);
  assert.match(people, /\[\[Cara Poe\]\]/);

  // user text around the block is preserved on rewrite
  writeFileSync(join(config.vault, "Dashboard.md"), `# My dashboard\n\n${dash}\nMy footer\n`);
  writeDigest(digest(), { config, now: NOW, threads: {} });
  const dash2 = read(config, "Dashboard.md");
  assert.ok(dash2.startsWith("# My dashboard\n\n"));
  assert.ok(dash2.endsWith("\nMy footer\n"));
  assert.match(blockLines(dash2, "dashboard").join("\n"), /Nothing waiting on you/);
});

test("active projects on the dashboard come from project notes", (t) => {
  const config = testConfig(tempDir(t));
  writeDigest(
    digest({
      projects: [
        { name: "Alpha", status: "active", summary: "going", progress: ["Did alpha things"], refs: [] },
        { name: "Beta", status: "shipped", summary: "done", progress: ["Shipped beta"], refs: [] },
      ],
    }),
    { config, now: NOW, threads: {} }
  );
  const inner = blockLines(read(config, "Dashboard.md"), "dashboard").join("\n");
  assert.match(inner, /\| \[\[Alpha\]\] \| active \| 2026-09-22 \| Did alpha things \|/);
  assert.ok(!inner.includes("[[Beta]]"));
  const weekly = read(config, "Log/2026-W39.md");
  assert.deepEqual(blockLines(weekly, "shipped"), ["- [[Beta]] — done", "- [[Beta]]: Shipped beta"]);
});

test("weekly note links the week's days and lists what is still open", (t) => {
  const config = testConfig(tempDir(t));
  writeDigest(digest({ progress: ["Monday work"] }), { config, now: new Date("2026-09-21T16:00:00Z"), threads: {} });
  writeDigest(digest({ progress: ["Tuesday work"], contacts: [anna] }), {
    config,
    now: NOW,
    threads: {
      x: {
        id: "x",
        title: "Quote",
        counterpart: "Anna Lee",
        category: "customer",
        waitingOn: "me",
        since: "2026-09-21T15:00:00Z",
        lastActivityAt: "2026-09-21T15:00:00Z",
      },
    },
  });
  const weekly = read(config, "Log/2026-W39.md");
  assert.deepEqual(blockLines(weekly, "days"), ["Days: [[2026-09-21]] · [[2026-09-22]] · [[Dashboard]]"]);
  assert.deepEqual(blockLines(weekly, "open"), ["- Waiting on me: [[Anna Lee]] — Quote (1d)"]);
  assert.deepEqual(blockLines(weekly, "people-week"), ["- [[Anna Lee]] (Globex)"]);
});

test("dropCategories never get notes", (t) => {
  const config = testConfig(tempDir(t));
  const spammer: Contact = { ...anna, name: "Spam Bot", category: "spam", company: "Spamco" };
  writeDigest(
    digest({
      contacts: [spammer],
      companies: [{ name: "Spamco", category: "spam", summary: "x", contacts: ["Spam Bot"], refs: [] }],
      progress: ["Real work"],
    }),
    { config, now: NOW, threads: {} }
  );
  assert.ok(!existsSync(join(config.vault, "People")));
  assert.ok(!existsSync(join(config.vault, "Companies")));
  assert.ok(!read(config, "Log/2026-09-22.md").includes("Spam Bot"));
});

test("dry run reports the same writes without touching disk; nothing lands at the vault root but the dashboard", (t) => {
  const config = testConfig(tempDir(t));
  const d = digest({ progress: ["A"], contacts: [anna] });
  const dry = writeDigest(d, { config, now: NOW, threads: {}, dryRun: true });
  assert.deepEqual(readdirSync(config.vault), []);
  const real = writeDigest(d, { config, now: NOW, threads: {} });
  assert.deepEqual(dry, real);
  assert.deepEqual(readdirSync(config.vault).filter((f) => f.endsWith(".md")), ["Dashboard.md"]);
  const again = writeDigest(d, { config, now: NOW, threads: {} });
  assert.ok(again.unchanged.includes("Log/2026-09-22.md"));
  assert.ok(again.unchanged.includes("People/Anna Lee.md"));
});

test("dates follow config.timezone at the day boundary", (t) => {
  const config = testConfig(tempDir(t));
  const report = writeDigest(digest({ progress: ["Late night"] }), {
    config,
    now: new Date("2026-01-05T02:00:00Z"),
    threads: {},
  });
  assert.ok(report.created.includes("Log/2026-01-04.md"));
  assert.ok(report.created.includes("Log/2026-W01.md"));
});
