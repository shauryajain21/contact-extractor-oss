import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WriteReport } from "../types.js";

interface Entry {
  original: string | null;
  current: string | null;
  written: boolean;
}

/**
 * Reads through to disk, buffers writes in memory, and flushes them at the
 * end so a dry run and a real run take exactly the same path.
 */
export class VaultFs {
  private readonly entries = new Map<string, Entry>();

  constructor(readonly root: string) {}

  private abs(rel: string): string {
    const full = resolve(this.root, rel);
    const back = relative(this.root, full);
    if (back === "" || back.startsWith("..") || isAbsolute(back)) {
      throw new Error(`Refusing to write outside the vault: ${rel}`);
    }
    return full;
  }

  private entry(rel: string): Entry {
    const key = toPosix(rel);
    let e = this.entries.get(key);
    if (!e) {
      const file = this.abs(key);
      const original = existsSync(file) ? readFileSync(file, "utf8") : null;
      e = { original, current: original, written: false };
      this.entries.set(key, e);
    }
    return e;
  }

  read(rel: string): string | null {
    return this.entry(rel).current;
  }

  write(rel: string, content: string): void {
    const e = this.entry(rel);
    e.current = content;
    e.written = true;
  }

  /** Markdown files directly inside `dir`, including ones only written in memory. */
  listNotes(dir: string): string[] {
    const prefix = toPosix(dir).replace(/\/$/, "");
    const names = new Set<string>();
    const full = join(this.root, prefix);
    if (existsSync(full)) {
      for (const d of readdirSync(full, { withFileTypes: true })) {
        if (d.isFile() && d.name.endsWith(".md")) names.add(`${prefix}/${d.name}`);
      }
    }
    for (const [key, e] of this.entries) {
      if (e.current !== null && dirname(key) === prefix && key.endsWith(".md")) names.add(key);
    }
    return [...names].sort();
  }

  report(): WriteReport {
    const out: WriteReport = { created: [], updated: [], unchanged: [] };
    for (const [key, e] of [...this.entries].sort(([a], [b]) => a.localeCompare(b))) {
      if (!e.written || e.current === null) continue;
      if (e.original === null) out.created.push(key);
      else if (e.original !== e.current) out.updated.push(key);
      else out.unchanged.push(key);
    }
    return out;
  }

  flush(): void {
    for (const [key, e] of this.entries) {
      if (e.current === null || e.current === e.original) continue;
      const file = this.abs(key);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.worklog-tmp`;
      writeFileSync(tmp, e.current);
      renameSync(tmp, file);
    }
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/").replace(/^\.\//, "");
}
