import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { clean } from "../redact.js";
import type { Activity, CollectContext, Config, Source } from "../types.js";
import { isDir, mapLimit, oneLine } from "./local-util.js";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const RS = "\x1e";
const FS = "\x1f";
const LOG_FORMAT = `${RS}%H${FS}%aI${FS}%an${FS}%ae${FS}%s${FS}%b`;
const SKIP_DIRS = new Set(["node_modules", "vendor", "target", "dist", "build", "__pycache__"]);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

const gitDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Depth 0 is the root itself. Stops descending once a `.git` entry is found. */
export async function findRepos(root: string, maxDepth: number): Promise<string[]> {
  const repos: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (existsSync(join(dir, ".git"))) {
      repos.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      await walk(join(dir, e.name), depth + 1);
    }
  };
  await walk(root, 0);
  return repos;
}

/** `git@github.com:o/r.git`, `ssh://git@host/o/r`, `https://user@host/o/r.git` → `https://host/o/r`. GitHub/GitLab only. */
export function remoteWebBase(remote: string): string | undefined {
  const r = remote.trim();
  let host: string | undefined;
  let path: string | undefined;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(r);
  const url = /^(?:ssh|git|https?):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/.exec(r);
  if (url) [, host, path] = url;
  else if (scp) [, host, path] = scp;
  if (!host || !path) return undefined;
  if (!/(^|\.)(github|gitlab)\./i.test(host)) return undefined;
  path = path.replace(/\/+$/, "").replace(/\.git$/, "");
  if (!/^[^/]+\/.+/.test(path)) return undefined;
  return `https://${host.toLowerCase()}/${path}`;
}

export function commitUrl(remote: string | undefined, sha: string): string | undefined {
  const base = remote ? remoteWebBase(remote) : undefined;
  return base ? `${base}/commit/${sha}` : undefined;
}

export interface RawCommit {
  sha: string;
  at: string;
  name: string;
  email: string;
  subject: string;
  body: string;
}

export function parseGitLog(stdout: string): RawCommit[] {
  const out: RawCommit[] = [];
  for (const rec of stdout.split(RS)) {
    if (!rec.trim()) continue;
    const [sha, at, name, email, subject, ...rest] = rec.split(FS);
    if (!sha || !at) continue;
    out.push({
      sha: sha.trim(),
      at: at.trim(),
      name: name ?? "",
      email: email ?? "",
      subject: subject ?? "",
      body: rest.join(FS).trim(),
    });
  }
  return out;
}

export function authorMatcher(config: Config): ((c: Pick<RawCommit, "name" | "email">) => boolean) | undefined {
  const emails = new Set(config.me.emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const authors = new Set((config.me.gitAuthors ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean));
  if (emails.size === 0 && authors.size === 0) return undefined;
  return (c) => {
    const email = c.email.trim().toLowerCase();
    const name = c.name.trim().toLowerCase();
    return emails.has(email) || authors.has(email) || authors.has(name);
  };
}

async function collectRepo(
  repo: string,
  ctx: CollectContext,
  isMine: (c: RawCommit) => boolean,
  seen: Set<string>,
): Promise<Activity[]> {
  const repoName = basename(repo);
  const stdout = await git(repo, [
    "log",
    "--all",
    "--no-merges",
    `--since=${gitDate(ctx.since)}`,
    `--until=${gitDate(ctx.until)}`,
    `--format=${LOG_FORMAT}`,
  ]);
  let remote: string | undefined;
  try {
    remote = (await git(repo, ["config", "--get", "remote.origin.url"])).trim() || undefined;
  } catch {
    remote = undefined;
  }
  const max = ctx.config.limits.maxActivityChars;
  const out: Activity[] = [];
  for (const c of parseGitLog(stdout)) {
    const t = Date.parse(c.at);
    if (Number.isNaN(t) || t < ctx.since.getTime() || t >= ctx.until.getTime()) continue;
    if (!isMine(c)) continue;
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    out.push({
      id: `git:${repoName}:${c.sha}`,
      source: "git",
      kind: "commit",
      at: new Date(t).toISOString(),
      title: oneLine(c.subject, 200),
      text: clean(c.body ? `${c.subject}\n\n${c.body}` : c.subject, max),
      url: commitUrl(remote, c.sha),
      project: repoName,
      threadId: `git:${repoName}`,
      participants: [],
      fromMe: true,
      meta: { sha: c.sha, repo },
    });
  }
  return out;
}

export const gitSource: Source = {
  name: "git",
  enabled(config) {
    return config.sources.git.enabled && config.sources.git.roots.some((r) => isDir(r));
  },
  async collect(ctx) {
    const { roots, maxDepth } = ctx.config.sources.git;
    const isMine = authorMatcher(ctx.config);
    if (!isMine) {
      ctx.log.warn("git: me.emails and me.gitAuthors are both empty, skipping commits");
      return [];
    }
    const repos = new Set<string>();
    for (const root of roots) {
      if (!isDir(root)) continue;
      try {
        for (const r of await findRepos(root, maxDepth)) repos.add(r);
      } catch (err) {
        ctx.log.warn("git: failed to scan root", { root, error: String(err) });
      }
    }
    const seen = new Set<string>();
    const results = await mapLimit([...repos], 8, async (repo) => {
      try {
        return await collectRepo(repo, ctx, isMine, seen);
      } catch (err) {
        ctx.log.warn("git: skipping repo", { repo, error: String(err).slice(0, 300) });
        return [];
      }
    });
    return results.flat();
  },
};
