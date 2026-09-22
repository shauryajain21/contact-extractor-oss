import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cursorSource } from "../../src/sources/cursor.js";
import { promptFingerprint } from "../../src/sources/local-util.js";
import { ctx, removeTempDirs, tempDir, testConfig } from "./helpers.js";

after(removeTempDirs);

const TEMPLATE = (since: string) =>
  `# Nightly sync\n\nCollect everything since \`${since}\` and write it into the notes folder. ` +
  "Only include work the user is personally involved in. Read the chat transcripts, the team threads, and " +
  "the shared inbox; skip bot noise, welcome messages and channel joins. Nothing to report is a valid outcome.";

function writeChat(root: string, slug: string, id: string, query: string, at: string, mtime: Date): void {
  const dir = join(root, slug, "agent-transcripts", id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const lines = [
    { role: "user", message: { content: [{ type: "text", text: `<timestamp>${at}</timestamp>\n<user_query>\n${query}\n</user_query>` }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(file, mtime, mtime);
}

describe("automated chat filtering", () => {
  it("fingerprints only long prompts and ignores digits", () => {
    assert.equal(promptFingerprint("continue"), undefined);
    assert.equal(promptFingerprint(TEMPLATE("2026-01-01T08:00")), promptFingerprint(TEMPLATE("2026-01-02T12:00")));
  });

  it("drops chats that reuse a scheduled prompt and keeps the person's own chats", async () => {
    const root = tempDir();
    const now = new Date("2026-01-05T12:00:00Z");
    const earlier = new Date("2026-01-05T08:00:00Z");
    writeChat(root, "Users-x-Projects-ops", "aaaaaaaa-0000-4000-8000-000000000001", TEMPLATE("2026-01-01T08:00"), "Monday, Jan 5, 2026, 8:00 AM (UTC)", earlier);
    writeChat(root, "Users-x-Projects-ops", "aaaaaaaa-0000-4000-8000-000000000002", TEMPLATE("2026-01-05T12:00"), "Monday, Jan 5, 2026, 12:00 PM (UTC)", now);
    writeChat(root, "Users-x-Projects-ops", "aaaaaaaa-0000-4000-8000-000000000003", "Fix the retry bug in the sync job", "Monday, Jan 5, 2026, 12:30 PM (UTC)", now);

    const config = testConfig((c) => {
      c.sources.cursor.path = root;
    });
    const since = new Date(now.getTime() - 3600_000).toISOString();
    const until = new Date(now.getTime() + 3600_000).toISOString();
    const out = await cursorSource.collect(ctx(config, since, until));
    assert.deepEqual(out.map((a) => a.title), ["Fix the retry bug in the sync job"]);
  });

  it("honours ignorePatterns", async () => {
    const root = tempDir();
    const now = new Date("2026-01-05T12:00:00Z");
    writeChat(root, "Users-x-Projects-app", "bbbbbbbb-0000-4000-8000-000000000001", "[bot] weekly report please", "Monday, Jan 5, 2026, 12:00 PM (UTC)", now);
    writeChat(root, "Users-x-Projects-app", "bbbbbbbb-0000-4000-8000-000000000002", "Ship the pricing page", "Monday, Jan 5, 2026, 12:10 PM (UTC)", now);
    const config = testConfig((c) => {
      c.sources.cursor.path = root;
      c.sources.cursor.ignorePatterns = ["^\\[bot\\]"];
    });
    const out = await cursorSource.collect(
      ctx(config, new Date(now.getTime() - 3600_000).toISOString(), new Date(now.getTime() + 3600_000).toISOString())
    );
    assert.deepEqual(out.map((a) => a.title), ["Ship the pricing page"]);
  });
});
