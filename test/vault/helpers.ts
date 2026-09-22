import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config.js";
import type { Config, Digest } from "../../src/types.js";

export function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "worklog-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function testConfig(root: string, overrides: Partial<Config> = {}): Config {
  const base = defaultConfig();
  const vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  return {
    ...base,
    vault,
    stateDir: join(root, "state"),
    timezone: "America/New_York",
    me: { name: "Sam Doe", emails: ["sam@acme.dev"], domains: ["acme.dev"] },
    sources: {
      ...base.sources,
      cursor: { ...base.sources.cursor, enabled: false },
      claudeCode: { ...base.sources.claudeCode, enabled: false },
      git: { ...base.sources.git, enabled: false },
    },
    ...overrides,
  };
}

export function digest(partial: Partial<Digest> = {}): Digest {
  return {
    window: { since: "2026-09-21T12:00:00.000Z", until: "2026-09-22T12:00:00.000Z" },
    projects: [],
    contacts: [],
    companies: [],
    threads: [],
    progress: [],
    actions: [],
    openQuestions: [],
    noticed: [],
    ...partial,
  };
}

export function read(config: Config, rel: string): string {
  return readFileSync(join(config.vault, rel), "utf8");
}
