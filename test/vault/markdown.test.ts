import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendUnderHeading,
  blockLines,
  findBlock,
  mergeFrontmatter,
  normalizeLine,
  readFrontmatter,
  replaceBlock,
  sanitizeNoteName,
  upsertBlock,
} from "../../src/vault/markdown.js";

const USER_NOTE = `# My note

Some text I wrote.
  - an indented thing with trailing spaces   

<!-- worklog:begin x -->
- old
<!-- worklog:end x -->

## Footer
Written by me.`;

test("replacing a block preserves every byte outside it", () => {
  const out = replaceBlock(USER_NOTE, "x", "- new 1\n- new 2")!;
  const b = findBlock(out, "x")!;
  assert.equal(b.inner, "- new 1\n- new 2");
  assert.equal(out.slice(0, b.innerStart), USER_NOTE.slice(0, findBlock(USER_NOTE, "x")!.innerStart));
  assert.equal(out.slice(b.innerEnd), USER_NOTE.slice(findBlock(USER_NOTE, "x")!.innerEnd));
  // round trip back to the original
  assert.equal(replaceBlock(out, "x", "- old"), USER_NOTE);
});

test("upsertBlock appends a missing block at the end without touching the rest", () => {
  const out = upsertBlock(USER_NOTE, "y", "hello");
  assert.ok(out.startsWith(USER_NOTE));
  assert.deepEqual(blockLines(out, "y"), ["hello"]);
  assert.equal(upsertBlock(out, "y", "hello"), out);
});

test("appendUnderHeading creates the block at the end of the section, then appends to it", () => {
  const note = "## Progress\nmy own line\n\n## Noticed\nstuff\n";
  const once = appendUnderHeading(note, "## Progress", "progress", ["- a"]);
  assert.equal(
    once,
    "## Progress\nmy own line\n<!-- worklog:begin progress -->\n- a\n<!-- worklog:end progress -->\n\n## Noticed\nstuff\n"
  );
  const twice = appendUnderHeading(once, "## Progress", "progress", ["- b"]);
  assert.deepEqual(blockLines(twice, "progress"), ["- a", "- b"]);
  assert.ok(twice.includes("my own line\n"));
  assert.ok(twice.endsWith("## Noticed\nstuff\n"));
});

test("appendUnderHeading adds a missing heading at the end", () => {
  const out = appendUnderHeading("hello\n", "## People", "people", ["- [[A]]"]);
  assert.equal(out, "hello\n\n## People\n<!-- worklog:begin people -->\n- [[A]]\n<!-- worklog:end people -->\n");
});

test("frontmatter merge only touches worklog keys and keeps user tags", () => {
  const note = "---\ntitle: Mine\ntags:\n  - friend\nlast_seen: 2026-01-01\n---\nBody\n";
  const out = mergeFrontmatter(note, { last_seen: "2026-02-02", email: "a@b.co" }, ["worklog/person"]);
  assert.equal(out, "---\ntitle: Mine\ntags:\n  - friend\n  - worklog/person\nlast_seen: 2026-02-02\nemail: a@b.co\n---\nBody\n");
  const fm = readFrontmatter(out);
  assert.deepEqual(fm.tags, ["friend", "worklog/person"]);
  assert.equal(fm.title, "Mine");
  assert.equal(mergeFrontmatter(out, { last_seen: "2026-02-02" }, ["worklog/person"]), out);
});

test("frontmatter is created when missing and flow tag lists are extended", () => {
  assert.equal(mergeFrontmatter("Body\n", { status: "active" }), "---\nstatus: active\n---\nBody\n");
  const flow = mergeFrontmatter("---\ntags: [a, b]\n---\n", {}, ["worklog/company"]);
  assert.equal(flow, "---\ntags: [a, b, worklog/company]\n---\n");
  assert.equal(mergeFrontmatter("Body\n", {}), "Body\n");
});

test("normalizeLine ignores case, punctuation, list markers and link syntax", () => {
  assert.equal(normalizeLine("- Shipped [[Worklog CLI]]!"), normalizeLine("shipped worklog cli"));
  assert.equal(normalizeLine("* [x] Fixed [the bug](https://x.y/1)."), "fixed the bug");
  assert.equal(normalizeLine("[[Note|Alias]] done"), "alias done");
});

test("sanitizeNoteName strips unsafe characters and caps length", () => {
  assert.equal(sanitizeNoteName('Acme / Beta: "Q3" #1 [draft]?'), "Acme Beta Q3 1 draft");
  assert.equal(sanitizeNoteName("  a\\b*c|d<e>f^g  "), "a b c d e f g");
  assert.equal(sanitizeNoteName("x".repeat(200)).length, 120);
  assert.equal(sanitizeNoteName("///"), "Untitled");
});
