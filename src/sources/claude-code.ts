import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Activity, Config, Source } from "../types.js";
import {
  buildChatActivity,
  type ChatCandidate,
  dropAutomatedChats,
  isDir,
  mapLimit,
  readJsonl,
  recentJsonl,
  selectInWindow,
  textBlocks,
  TurnLog,
} from "./local-util.js";

/** User turns that are harness output rather than something the person typed. */
const HARNESS_PREFIX_RE =
  /^\s*(?:<(?:command-[a-z]+|local-command-[a-z]+|task-notification|bash-(?:input|stdout|stderr)|user-memory-input)>|\[Request interrupted by user|Caveat: The messages below were generated)/;
const STRIP_RE = /<(system-reminder|system_reminder)>[\s\S]*?<\/\1>/g;

export function userTextOf(rec: Record<string, unknown>): string | undefined {
  if (rec.type !== "user" || rec.isMeta === true || rec.isSidechain === true) return undefined;
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  if (Array.isArray(content) && content.some((b) => (b as { type?: unknown })?.type === "tool_result")) return undefined;
  const text = textBlocks(content).join("\n").replace(STRIP_RE, "").trim();
  if (!text || HARNESS_PREFIX_RE.test(text)) return undefined;
  return text;
}

function assistantTextOf(rec: Record<string, unknown>): string | undefined {
  if (rec.type !== "assistant" || rec.isSidechain === true) return undefined;
  const text = textBlocks((rec.message as { content?: unknown } | undefined)?.content).join("\n").trim();
  return text || undefined;
}

export function projectFromCwd(cwd: string | undefined, home: string = homedir()): string | undefined {
  if (!cwd) return undefined;
  if (resolve(cwd) === resolve(home)) return undefined;
  return basename(cwd) || undefined;
}

export async function parseClaudeSession(
  file: string,
  mtime: Date,
  since: Date,
  until: Date,
  config: Config,
): Promise<Activity | undefined> {
  const turns = new TurnLog(config.limits.maxActivityChars);
  let sessionId: string | undefined;
  let cwd: string | undefined;
  await readJsonl(file, (rec) => {
    if (!sessionId && typeof rec.sessionId === "string") sessionId = rec.sessionId;
    if (typeof rec.cwd === "string" && rec.isSidechain !== true) cwd = rec.cwd;
    const user = userTextOf(rec);
    if (user) {
      const t = typeof rec.timestamp === "string" ? new Date(rec.timestamp) : undefined;
      turns.user(user, t && !Number.isNaN(t.getTime()) ? t : undefined);
      return;
    }
    const reply = assistantTextOf(rec);
    if (reply) turns.assistant(reply);
  });
  const inWindow = selectInWindow(turns.turns, since, until, mtime);
  return buildChatActivity({
    source: "claude-code",
    sessionId: sessionId ?? basename(file, ".jsonl"),
    project: projectFromCwd(cwd),
    turns: inWindow,
    config,
  });
}

export const claudeCodeSource: Source = {
  name: "claude-code",
  enabled(config) {
    return config.sources.claudeCode.enabled && isDir(config.sources.claudeCode.path);
  },
  async collect(ctx) {
    const root = ctx.config.sources.claudeCode.path;
    if (!isDir(root)) return [];
    const files: Array<{ file: string; mtime: Date }> = [];
    let slugs: string[] = [];
    try {
      slugs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (err) {
      ctx.log.warn("claude-code: cannot read projects dir", { root, error: String(err) });
      return [];
    }
    for (const slug of slugs) {
      let entries;
      try {
        entries = await readdir(join(root, slug), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
        const file = join(root, slug, e.name);
        try {
          const st = await stat(file);
          if (st.mtime.getTime() >= ctx.since.getTime()) files.push({ file, mtime: st.mtime });
        } catch {
          continue;
        }
      }
    }
    const results = await mapLimit(files, 8, async ({ file, mtime }): Promise<ChatCandidate | undefined> => {
      try {
        const activity = await parseClaudeSession(file, mtime, ctx.since, ctx.until, ctx.config);
        return activity && { activity, file, group: dirname(file) };
      } catch (err) {
        ctx.log.warn("claude-code: skipping unreadable session", { file, error: String(err) });
        return undefined;
      }
    });
    const { kept, dropped } = await dropAutomatedChats({
      candidates: results.filter((c): c is ChatCandidate => c !== undefined),
      siblings: (dir) => recentJsonl(dir, 14, ctx.until),
      pick: userTextOf,
      ignorePatterns: ctx.config.sources.claudeCode.ignorePatterns ?? [],
    });
    if (dropped) ctx.log.info("claude-code: skipped scheduled or ignored sessions", { dropped });
    return kept;
  },
};
