import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deepMerge, defaultConfig, loadEnvFile, parseEnvFile, validateConfig } from "../../src/config.js";
import { clean, redact } from "../../src/redact.js";
import { StateStore, mergeThreads } from "../../src/state.js";
import type { ThreadState } from "../../src/types.js";

test("redact strips common credential shapes", () => {
  const input = [
    "key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
    "gh ghp_abcdefghijklmnopqrstuvwxyz0123",
    "slack xoxp-1234567890-abcdefghij",
    "OPENAI_API_KEY=supersecretvalue123",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
  ].join("\n");
  const out = redact(input);
  assert.doesNotMatch(out, /sk-proj-abcdef/);
  assert.doesNotMatch(out, /ghp_abcdef/);
  assert.doesNotMatch(out, /xoxp-1234/);
  assert.doesNotMatch(out, /supersecretvalue/);
  assert.doesNotMatch(out, /Bearer abcdef/);
});

test("clean truncates after redacting", () => {
  const out = clean("a".repeat(50), 10);
  assert.ok(out.startsWith("aaaaaaaaaa\n…[truncated 40 chars]"));
});

test("deepMerge replaces arrays and merges objects", () => {
  const merged = deepMerge(defaultConfig(), {
    me: { name: "Ada", emails: ["ada@example.com"] },
    sources: { git: { roots: ["/code"] } },
  });
  assert.equal(merged.me.name, "Ada");
  assert.deepEqual(merged.sources.git.roots, ["/code"]);
  assert.equal(merged.sources.git.maxDepth, 2);
  assert.equal(merged.sources.cursor.enabled, true);
});

test("env file fills only unset variables", () => {
  const dir = mkdtempSync(join(tmpdir(), "worklog-env-"));
  try {
    const file = join(dir, ".env");
    writeFileSync(file, '# keys\nexport A_KEY="one"\nB_KEY=two # trailing\nC_KEY=\'three\'\nnot a line\n');
    const env: NodeJS.ProcessEnv = { B_KEY: "already" };
    const loaded = loadEnvFile(file, env);
    assert.deepEqual(loaded.sort(), ["A_KEY", "C_KEY"]);
    assert.equal(env.A_KEY, "one");
    assert.equal(env.B_KEY, "already");
    assert.equal(env.C_KEY, "three");
    assert.deepEqual(parseEnvFile("X=1 # c"), { X: "1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateConfig flags missing identity and bad schedule", () => {
  const c = defaultConfig();
  c.schedule.times = ["8am"];
  const problems = validateConfig(c);
  assert.ok(problems.some((p) => p.includes("me.name")));
  assert.ok(problems.some((p) => p.includes("8am")));
});

test("state store round-trips watermark and guards the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "worklog-state-"));
  try {
    const store = new StateStore(dir);
    assert.equal(store.readWatermark(), null);
    store.writeWatermark(new Date("2026-01-01T00:00:00Z"));
    assert.equal(store.readWatermark()?.until, "2026-01-01T00:00:00.000Z");

    const release = store.acquireLock();
    assert.ok(release);
    assert.equal(store.acquireLock(), null);
    release();
    const again = store.acquireLock();
    assert.ok(again);
    again();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeThreads keeps the original since while the waiting side holds", () => {
  const base: ThreadState = {
    id: "t1",
    title: "Pricing",
    counterpart: "Jo",
    category: "prospect",
    waitingOn: "me",
    since: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
  };
  const same = mergeThreads({ t1: base }, [{ ...base, since: "2026-01-03T00:00:00Z", lastActivityAt: "2026-01-03T00:00:00Z" }]);
  assert.equal(same.t1?.since, "2026-01-01T00:00:00Z");
  assert.equal(same.t1?.lastActivityAt, "2026-01-03T00:00:00Z");

  const flipped = mergeThreads({ t1: base }, [{ ...base, waitingOn: "them", since: "2026-01-04T00:00:00Z" }]);
  assert.equal(flipped.t1?.since, "2026-01-04T00:00:00Z");
});
