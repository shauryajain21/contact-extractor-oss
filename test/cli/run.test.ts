import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { silentLogger } from "../../src/log.js";
import { runOnce, smallestScheduleGapMs } from "../../src/run.js";
import { StateStore } from "../../src/state.js";
import type { Activity, Extractor, Source, SourceName } from "../../src/types.js";
import { digest, tempDir, testConfig } from "../vault/helpers.js";

const NOW = new Date("2026-09-22T16:00:00Z");

function activity(id: string, at: string, source: SourceName = "git"): Activity {
  return { id, source, kind: "commit", at, text: id, participants: [], fromMe: true };
}

function fakeSource(name: SourceName, items: Activity[] | Error): Source & { calls: Array<{ since: Date; until: Date }> } {
  const calls: Array<{ since: Date; until: Date }> = [];
  return {
    name,
    calls,
    enabled: () => true,
    async collect(ctx) {
      calls.push({ since: ctx.since, until: ctx.until });
      if (items instanceof Error) throw items;
      return items;
    },
  };
}

function fakeExtractor(): Extractor & { seen: Activity[][] } {
  const seen: Activity[][] = [];
  return {
    seen,
    async extract(activities, ctx) {
      seen.push(activities);
      return digest({
        window: { since: ctx.window.since.toISOString(), until: ctx.window.until.toISOString() },
        progress: activities.map((a) => `Did ${a.id}`),
        threads: [
          {
            id: "t1",
            title: "Quote",
            counterpart: "Anna Lee",
            category: "customer",
            waitingOn: "me",
            since: "2026-09-22T10:00:00Z",
            lastActivityAt: "2026-09-22T10:00:00Z",
          },
        ],
      });
    },
  };
}

test("a successful run writes the vault, threads and advances the watermark", async (t) => {
  const config = testConfig(tempDir(t));
  const git = fakeSource("git", [activity("b", "2026-09-22T12:00:00Z"), activity("a", "2026-09-22T11:00:00Z")]);
  const cursor = fakeSource("cursor", [activity("c", "2026-09-22T13:00:00Z", "cursor")]);
  const extractor = fakeExtractor();
  const result = await runOnce({ config, log: silentLogger, now: NOW }, { sources: [git, cursor], extractor });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.counts, { git: 2, cursor: 1 });
  assert.deepEqual(extractor.seen[0]!.map((a) => a.id), ["a", "b", "c"]);
  assert.equal(git.calls[0]!.since.toISOString(), "2026-09-21T16:00:00.000Z");
  assert.ok(result.report!.created.includes("Log/2026-09-22.md"));

  const state = new StateStore(config.stateDir);
  assert.equal(state.readWatermark()!.until, NOW.toISOString());
  assert.equal(state.readThreads().t1!.waitingOn, "me");
  assert.ok(!existsSync(join(config.stateDir, "lock")), "lock released");

  const later = new Date("2026-09-22T20:00:00Z");
  await runOnce({ config, log: silentLogger, now: later }, { sources: [git], extractor });
  assert.equal(git.calls[1]!.since.toISOString(), NOW.toISOString(), "next window starts at the watermark");
});

test("a failed source still writes but does not advance the watermark", async (t) => {
  const config = testConfig(tempDir(t));
  const state = new StateStore(config.stateDir);
  state.writeWatermark(new Date("2026-09-22T08:00:00Z"), new Date("2026-09-22T08:00:00Z"));
  const ok = fakeSource("git", [activity("a", "2026-09-22T11:00:00Z")]);
  const bad = fakeSource("slack", new Error("rate limited"));
  const result = await runOnce({ config, log: silentLogger, now: NOW }, { sources: [ok, bad], extractor: fakeExtractor() });

  assert.equal(result.status, "failed");
  assert.equal(result.errors?.slack, "rate limited");
  assert.deepEqual(result.counts, { git: 1, slack: 0 });
  assert.ok(result.report!.created.includes("Log/2026-09-22.md"));
  assert.equal(state.readWatermark()!.until, "2026-09-22T08:00:00.000Z");
  assert.ok(state.readThreads().t1);
  assert.ok(!existsSync(join(config.stateDir, "lock")));
});

test("a held lock returns locked without collecting", async (t) => {
  const config = testConfig(tempDir(t));
  mkdirSync(join(config.stateDir, "lock"), { recursive: true });
  writeFileSync(join(config.stateDir, "lock", "pid"), String(process.pid));
  const git = fakeSource("git", []);
  const result = await runOnce({ config, log: silentLogger, now: NOW }, { sources: [git], extractor: fakeExtractor() });
  assert.equal(result.status, "locked");
  assert.equal(git.calls.length, 0);
  assert.ok(existsSync(join(config.stateDir, "lock", "pid")), "someone else's lock is left alone");
});

test("ifStale skips a recent run and runs a stale one", async (t) => {
  const config = testConfig(tempDir(t), { schedule: { times: ["08:00", "12:00", "16:00", "20:00"] } });
  const state = new StateStore(config.stateDir);
  const git = fakeSource("git", []);
  const deps = { sources: [git], extractor: fakeExtractor() };

  state.writeWatermark(new Date("2026-09-22T12:00:00Z"), new Date("2026-09-22T12:00:00Z"));
  const fresh = await runOnce({ config, log: silentLogger, now: NOW, ifStale: true }, deps);
  assert.equal(fresh.status, "skipped");
  assert.equal(git.calls.length, 0);

  state.writeWatermark(new Date("2026-09-22T11:00:00Z"), new Date("2026-09-22T11:29:00Z"));
  const stale = await runOnce({ config, log: silentLogger, now: NOW, ifStale: true }, deps);
  assert.equal(stale.status, "ok");
  assert.equal(git.calls.length, 1);
});

test("dry run changes neither vault nor state", async (t) => {
  const config = testConfig(tempDir(t));
  const result = await runOnce(
    { config, log: silentLogger, now: NOW, dryRun: true },
    { sources: [fakeSource("git", [activity("a", "2026-09-22T11:00:00Z")])], extractor: fakeExtractor() }
  );
  assert.equal(result.status, "ok");
  assert.ok(result.report!.created.length > 0);
  assert.ok(!existsSync(join(config.vault, "Log")));
  const state = new StateStore(config.stateDir);
  assert.equal(state.readWatermark(), null);
  assert.deepEqual(state.readThreads(), {});
});

test("the run times out and releases the lock", async (t) => {
  const config = testConfig(tempDir(t));
  const hang: Source = { name: "git", enabled: () => true, collect: () => new Promise(() => {}) };
  const result = await runOnce({ config, log: silentLogger, now: NOW, timeoutMs: 50 }, { sources: [hang], extractor: fakeExtractor() });
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /exceeded/);
  assert.ok(!existsSync(join(config.stateDir, "lock")));
  assert.equal(new StateStore(config.stateDir).readWatermark(), null);
});

test("smallest schedule gap wraps past midnight", () => {
  const h = 3_600_000;
  assert.equal(smallestScheduleGapMs(["08:00", "12:00", "16:00", "20:00"]), 4 * h);
  assert.equal(smallestScheduleGapMs(["23:30", "00:30", "12:00"]), 1 * h);
  assert.equal(smallestScheduleGapMs(["09:00"]), 24 * h);
});
