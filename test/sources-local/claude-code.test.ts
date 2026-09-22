import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { claudeCodeSource, projectFromCwd, userTextOf } from "../../src/sources/claude-code.js";
import { ctx, FAKE_KEY, removeTempDirs, tempCopy, testConfig } from "./helpers.js";

after(removeTempDirs);

const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function setup() {
  const root = tempCopy("claude", new Date("2026-09-04T19:05:00Z"));
  return testConfig((c) => {
    c.sources.claudeCode.path = root;
  });
}

describe("claude-code userTextOf", () => {
  it("skips tool results, meta, sidechain and command wrapper turns", () => {
    assert.equal(userTextOf({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }), undefined);
    assert.equal(userTextOf({ type: "user", isMeta: true, message: { content: "hi" } }), undefined);
    assert.equal(userTextOf({ type: "user", isSidechain: true, message: { content: "hi" } }), undefined);
    assert.equal(userTextOf({ type: "user", message: { content: "<command-name>/clear</command-name>" } }), undefined);
    assert.equal(userTextOf({ type: "user", message: { content: "<local-command-stdout>ok</local-command-stdout>" } }), undefined);
    assert.equal(userTextOf({ type: "user", message: { content: "[Request interrupted by user]" } }), undefined);
    assert.equal(userTextOf({ type: "assistant", message: { content: "hi" } }), undefined);
  });

  it("accepts string and text-block content and strips system reminders", () => {
    assert.equal(userTextOf({ type: "user", message: { content: "Fix the bug" } }), "Fix the bug");
    assert.equal(
      userTextOf({ type: "user", message: { content: [{ type: "text", text: "<system-reminder>x</system-reminder>\nShip it" }] } }),
      "Ship it",
    );
  });
});

describe("claude-code projectFromCwd", () => {
  it("uses the cwd basename but not the home dir", () => {
    assert.equal(projectFromCwd("/Users/jane/Projects/api-server", "/Users/jane"), "api-server");
    assert.equal(projectFromCwd("/Users/jane", "/Users/jane"), undefined);
    assert.equal(projectFromCwd(undefined), undefined);
  });
});

describe("claudeCodeSource.collect", () => {
  it("emits in-window user turns plus the last reply, skipping harness noise", async () => {
    const out = await claudeCodeSource.collect(ctx(setup(), "2026-09-04T16:00:00Z", "2026-09-04T18:00:00Z"));
    assert.equal(out.length, 1);
    const [a] = out;
    assert.ok(a);
    assert.equal(a.id, `claude-code:${SESSION}:2026-09-04T16:30:00.000Z`);
    assert.equal(a.source, "claude-code");
    assert.equal(a.kind, "chat");
    assert.equal(a.threadId, SESSION);
    assert.equal(a.project, "api-server");
    assert.equal(a.fromMe, true);
    assert.deepEqual(a.meta, { userTurns: 1 });
    assert.match(a.text, /^USER: Now add tests, token \[redacted:api-key\]/);
    assert.match(a.text, /ASSISTANT: Tests added\.$/);
    assert.ok(!a.text.includes(FAKE_KEY));
    assert.ok(!a.title?.includes(FAKE_KEY));
    for (const leak of ["TOOL_OUTPUT", "COMMAND_OUTPUT", "REMINDER_SHOULD", "SIDECHAIN", "Caveat", "/clear", "private chain"]) {
      assert.ok(!a.text.includes(leak), `${leak} must not appear`);
    }
  });

  it("attributes replies that follow tool calls to the right user turn", async () => {
    const out = await claudeCodeSource.collect(ctx(setup(), "2026-09-04T14:00:00Z", "2026-09-04T18:00:00Z"));
    const [a] = out;
    assert.ok(a);
    assert.equal(a.title, "Refactor the auth middleware");
    assert.deepEqual(a.meta, { userTurns: 2 });
    assert.match(a.text, /USER: Refactor the auth middleware\n\nUSER: Now add tests/);
    assert.match(a.text, /ASSISTANT: Tests added\.$/);
  });

  it("returns nothing outside the window", async () => {
    const out = await claudeCodeSource.collect(ctx(setup(), "2026-09-05T00:00:00Z", "2026-09-06T00:00:00Z"));
    assert.deepEqual(out, []);
  });

  it("returns [] when the directory is missing", async () => {
    const config = testConfig((c) => {
      c.sources.claudeCode.path = "/definitely/not/here";
    });
    assert.equal(claudeCodeSource.enabled(config), false);
    assert.deepEqual(await claudeCodeSource.collect(ctx(config, "2026-09-04T00:00:00Z", "2026-09-05T00:00:00Z")), []);
  });
});
