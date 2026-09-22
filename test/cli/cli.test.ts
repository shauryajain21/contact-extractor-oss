import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main, parseWhen, UsageError, type Io } from "../../src/cli.js";
import { tempDir } from "../vault/helpers.js";

const NOW = new Date("2026-09-22T16:00:00Z");

test("parseWhen reads durations back from now and ISO times", () => {
  assert.equal(parseWhen("4h", NOW).toISOString(), "2026-09-22T12:00:00.000Z");
  assert.equal(parseWhen("2d", NOW).toISOString(), "2026-09-20T16:00:00.000Z");
  assert.equal(parseWhen("30m", NOW).toISOString(), "2026-09-22T15:30:00.000Z");
  assert.equal(parseWhen("1w", NOW).toISOString(), "2026-09-15T16:00:00.000Z");
  assert.equal(parseWhen("2026-09-01T09:00:00Z", NOW).toISOString(), "2026-09-01T09:00:00.000Z");
  assert.equal(parseWhen("2026-09-01", NOW).toISOString(), "2026-09-01T00:00:00.000Z");
  assert.throws(() => parseWhen("yesterday", NOW), UsageError);
  assert.throws(() => parseWhen("4x", NOW), UsageError);
  assert.throws(() => parseWhen("2026-13-45", NOW), UsageError);
});

function io(env: NodeJS.ProcessEnv = {}): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (t) => stdout.push(t), err: (t) => stderr.push(t), env, now: () => NOW };
}

test("usage errors exit 2, help exits 0", async () => {
  assert.equal(await main(["bogus"], io()), 2);
  assert.equal(await main(["run", "--nope"], io()), 2);
  assert.equal(await main(["run", "--since", "yesterday"], io()), 2);
  assert.equal(await main(["schedule", "explode"], io()), 2);
  const h = io();
  assert.equal(await main(["run", "--help"], h), 0);
  assert.match(h.stdout.join("\n"), /--if-stale/);
  assert.equal(await main(["--help"], io()), 0);
});

test("init --yes writes a config from flags and refuses to overwrite without --force", async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, "config.json");
  const vault = join(dir, "vault");
  const args = [
    "init",
    "--yes",
    "--config",
    configPath,
    "--name",
    "Sam Doe",
    "--email",
    "sam@acme.dev",
    "--vault",
    vault,
    "--llm",
    "anthropic",
    "--timezone",
    "Europe/Paris",
  ];
  const first = io();
  assert.equal(await main(args, first), 0, first.stderr.join("\n"));
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(config.me.name, "Sam Doe");
  assert.deepEqual(config.me.emails, ["sam@acme.dev"]);
  assert.deepEqual(config.me.domains, ["acme.dev"]);
  assert.equal(config.vault, vault);
  assert.equal(config.timezone, "Europe/Paris");
  assert.deepEqual(config.llm, { provider: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" });
  assert.equal(config.stateDir, undefined);
  assert.ok(!JSON.stringify(config).includes("sk-"));
  for (const d of ["Log", "People", "Companies", "Projects"]) assert.ok(existsSync(join(vault, d)), d);

  const again = io();
  assert.equal(await main(args, again), 1);
  assert.match(again.stderr.join("\n"), /--force/);
  assert.equal(await main([...args, "--force"], io()), 0);
});

test("WORKLOG_CONFIG is honoured and a missing config fails cleanly", async (t) => {
  const dir = tempDir(t);
  const r = io({ WORKLOG_CONFIG: join(dir, "nope.json") });
  assert.equal(await main(["status"], r), 1);
  assert.match(r.stderr.join("\n"), /nope\.json/);
});
