import assert from "node:assert/strict";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cursorSource, extractUserQuery, parseCursorTimestamp, projectFromSlug } from "../../src/sources/cursor.js";
import { ctx, FAKE_KEY, removeTempDirs, tempCopy, tempDir, testConfig } from "./helpers.js";

after(removeTempDirs);

const CHAT = "11111111-2222-4333-8444-555555555555";
const FLAT = "22222222-3333-4444-8555-666666666666";
const EMPTY = "33333333-4444-4555-8666-777777777777";

describe("parseCursorTimestamp", () => {
  it("parses the Cursor format with a UTC offset", () => {
    assert.equal(parseCursorTimestamp("Friday, Sep 4, 2026, 12:26 PM (UTC-4)")?.toISOString(), "2026-09-04T16:26:00.000Z");
    assert.equal(parseCursorTimestamp("Monday, Sep 21, 2026, 2:01 AM (UTC-4)")?.toISOString(), "2026-09-21T06:01:00.000Z");
  });

  it("handles 12 AM/PM, half-hour offsets and bare UTC", () => {
    assert.equal(parseCursorTimestamp("Sat, Jan 3, 2026, 12:05 AM (UTC+5:30)")?.toISOString(), "2026-01-02T18:35:00.000Z");
    assert.equal(parseCursorTimestamp("Sat, Jan 3, 2026, 12:05 PM (UTC)")?.toISOString(), "2026-01-03T12:05:00.000Z");
    assert.equal(parseCursorTimestamp("December 31, 2025, 11:59 PM (UTC+1)")?.toISOString(), "2025-12-31T22:59:00.000Z");
  });

  it("returns undefined for garbage", () => {
    assert.equal(parseCursorTimestamp("not a date"), undefined);
  });
});

describe("extractUserQuery", () => {
  it("keeps only the user_query body and strips wrapper tags", () => {
    const raw =
      "<timestamp>Friday, Sep 4, 2026, 12:26 PM (UTC-4)</timestamp>\n<attached_files>\n<file>x</file>\n</attached_files>\n" +
      "<system_reminder>hidden</system_reminder>\n<user_query>\nDo the thing\n<image_files>\na.png\n</image_files>\n</user_query>";
    assert.equal(extractUserQuery(raw), "Do the thing");
  });

  it("strips wrappers when there is no user_query tag", () => {
    assert.equal(extractUserQuery("<timestamp>x</timestamp>\n<side_chat_boundary>\nPlain request"), "Plain request");
  });

  it("keeps literal tag mentions inside the query", () => {
    const raw = "<user_query>\nwrap text in <user_query>…</user_query> please\n</user_query>";
    assert.equal(extractUserQuery(raw), "wrap text in <user_query>…</user_query> please");
  });
});

describe("projectFromSlug", () => {
  it("strips the home prefix and a container folder", () => {
    assert.equal(projectFromSlug("Users-jane-Projects-my-app", "/Users/jane", "/nonexistent-root"), "my-app");
    assert.equal(projectFromSlug("home-jane-code-api", "/home/jane", "/nonexistent-root"), "api");
    assert.equal(projectFromSlug("Users-jane-weird-place-app", "/Users/jane", "/nonexistent-root"), "weird-place-app");
  });

  it("strips a home prefix from another machine", () => {
    assert.equal(projectFromSlug("Users-bob-Projects-tool", "/Users/jane", "/nonexistent-root"), "tool");
  });

  it("returns undefined for empty-window and the home dir itself", () => {
    assert.equal(projectFromSlug("empty-window", "/Users/jane", "/nonexistent-root"), undefined);
    assert.equal(projectFromSlug("Users-jane", "/Users/jane", "/nonexistent-root"), undefined);
  });

  it("resolves against disk so dashed and spaced folder names survive", () => {
    const root = tempDir("worklog-slug-");
    mkdirSync(join(root, "Users", "jane", "Projects", "deep-eval", "results-ws"), { recursive: true });
    mkdirSync(join(root, "Users", "jane", "Documents", "Obsidian Vault"), { recursive: true });
    const home = join(root, "Users", "jane");
    assert.equal(projectFromSlug("Users-jane-Projects-deep-eval-results-ws", home, root), "results-ws");
    assert.equal(projectFromSlug("Users-jane-Projects-deep-eval", home, root), "deep-eval");
    assert.equal(projectFromSlug("Users-jane-Documents-Obsidian-Vault", home, root), "Obsidian Vault");
    assert.equal(projectFromSlug("Users-jane", home, root), undefined);
  });
});

describe("cursorSource.collect", () => {
  const since = "2026-09-04T16:00:00Z";
  const until = "2026-09-04T18:00:00Z";

  function setup() {
    const root = tempCopy("cursor", new Date("2026-09-04T22:15:00Z"));
    const flat = join(root, "Users-jane-Projects-my-app", "agent-transcripts", `${FLAT}.jsonl`);
    const flatMtime = new Date("2026-09-04T17:00:00Z");
    utimesSync(flat, flatMtime, flatMtime);
    const config = testConfig((c) => {
      c.sources.cursor.path = root;
    });
    return { root, config };
  }

  it("emits one activity per chat with only in-window user turns", async () => {
    const { config } = setup();
    const out = await cursorSource.collect(ctx(config, since, until));
    const chat = out.find((a) => a.threadId === CHAT);
    assert.ok(chat, "timestamped chat present");
    assert.equal(chat.id, `cursor:${CHAT}:2026-09-04T16:40:00.000Z`);
    assert.equal(chat.at, "2026-09-04T16:40:00.000Z");
    assert.equal(chat.kind, "chat");
    assert.equal(chat.source, "cursor");
    assert.equal(chat.fromMe, true);
    assert.equal(chat.project, "my-app");
    assert.deepEqual(chat.participants, []);
    assert.deepEqual(chat.meta, { userTurns: 2 });
    assert.match(chat.text, /USER: Wire the billing webhook/);
    assert.match(chat.text, /USER: Add retries to the webhook handler/);
    assert.match(chat.text, /ASSISTANT: Retries added with exponential backoff\./);
    assert.doesNotMatch(chat.text, /Set up the project skeleton|Write the README|README written|Skeleton ready/);
    assert.doesNotMatch(chat.text, /<timestamp>|<attached_files>|<image_files>|<system_reminder>|Internal harness note|screenshot-1/);
    assert.ok(chat.title?.startsWith("Wire the billing webhook"));
    assert.ok((chat.title?.length ?? 0) <= 100);
  });

  it("redacts keys in text and title", async () => {
    const { config } = setup();
    const out = await cursorSource.collect(ctx(config, since, until));
    for (const a of out) {
      assert.ok(!a.text.includes(FAKE_KEY), "key must not leak into text");
      assert.ok(!a.title?.includes(FAKE_KEY), "key must not leak into title");
    }
    assert.ok(out.some((a) => a.text.includes("[redacted:api-key]")));
  });

  it("falls back to mtime for flat transcripts without timestamps", async () => {
    const { config } = setup();
    const out = await cursorSource.collect(ctx(config, since, until));
    const flat = out.find((a) => a.threadId === FLAT);
    assert.ok(flat);
    assert.equal(flat.at, "2026-09-04T17:00:00.000Z");
    assert.match(flat.text, /USER: Flat layout chat without timestamps/);
    assert.match(flat.text, /ASSISTANT: Handled the flat layout\./);
  });

  it("maps empty-window to no project", async () => {
    const { config } = setup();
    const out = await cursorSource.collect(ctx(config, since, until));
    const empty = out.find((a) => a.threadId === EMPTY);
    assert.ok(empty);
    assert.equal(empty.project, undefined);
  });

  it("skips files last modified before the window", async () => {
    const { root, config } = setup();
    const file = join(root, "Users-jane-Projects-my-app", "agent-transcripts", CHAT, `${CHAT}.jsonl`);
    const old = new Date("2026-09-01T00:00:00Z");
    utimesSync(file, old, old);
    const out = await cursorSource.collect(ctx(config, since, until));
    assert.equal(out.find((a) => a.threadId === CHAT), undefined);
  });

  it("drops chats with no turns in the window", async () => {
    const { config } = setup();
    const out = await cursorSource.collect(ctx(config, "2026-09-04T23:00:00Z", "2026-09-05T00:00:00Z"));
    assert.equal(out.length, 0);
  });

  it("returns [] and is disabled when the directory is missing", async () => {
    const config = testConfig((c) => {
      c.sources.cursor.path = "/definitely/not/here";
    });
    assert.equal(cursorSource.enabled(config), false);
    assert.deepEqual(await cursorSource.collect(ctx(config, since, until)), []);
  });
});
