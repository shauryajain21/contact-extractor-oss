import { cpSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../../src/config.js";
import { silentLogger } from "../../src/log.js";
import type { CollectContext, Config, Logger } from "../../src/types.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "local");
export const FAKE_KEY = "sk-proj-FAKEfakeFAKEfake1234567890abcd";

const temps: string[] = [];

export function tempDir(prefix = "worklog-local-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tempCopy(fixtureDir: string, mtime: Date): string {
  const dest = tempDir();
  cpSync(join(FIXTURES, fixtureDir), dest, { recursive: true });
  touchAll(dest, mtime);
  return dest;
}

export function touchAll(dir: string, mtime: Date): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) touchAll(p, mtime);
    else if (statSync(p).isFile()) utimesSync(p, mtime, mtime);
  }
}

export function testConfig(patch: (c: Config) => void = () => {}): Config {
  const c = defaultConfig();
  c.me = { name: "Test User", emails: [], domains: [] };
  patch(c);
  return c;
}

export function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return { ...silentLogger, warn: (m: string) => void warnings.push(m), warnings };
}

export function ctx(config: Config, since: string, until: string, log: Logger = silentLogger): CollectContext {
  return { config, since: new Date(since), until: new Date(until), log };
}
