import { defaultConfig } from "../../src/config.js";
import type { Activity, Config, ExtractContext, LlmProvider, LlmRequest, Logger, ThreadState } from "../../src/types.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = defaultConfig();
  return {
    ...base,
    me: {
      name: "Sam Rivera",
      emails: ["sam@worklog.dev", "sam.rivera@gmail.com"],
      domains: ["worklog.dev"],
      slackUserId: "U_SAM",
      gitAuthors: ["samr"],
    },
    llm: { provider: "none" },
    stateDir: "/tmp/worklog-test-state",
    ...overrides,
  };
}

export interface RecordingLogger extends Logger {
  lines: Array<{ level: string; msg: string; extra?: Record<string, unknown> }>;
}

export function recordingLogger(): RecordingLogger {
  const lines: RecordingLogger["lines"] = [];
  const rec = (level: string) => (msg: string, extra?: Record<string, unknown>) => {
    lines.push({ level, msg, extra });
  };
  return { lines, debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") };
}

export function ctxFor(
  config: Config,
  knownThreads: Record<string, ThreadState> = {},
  log: Logger = recordingLogger()
): ExtractContext {
  return {
    config,
    log,
    window: { since: new Date("2026-09-21T00:00:00Z"), until: new Date("2026-09-22T00:00:00Z") },
    knownThreads,
  };
}

const ME = { name: "Sam Rivera", email: "sam@worklog.dev" };

export function inboundEmail(
  id: string,
  from: { name?: string; email: string },
  subject: string,
  text: string,
  extra: Partial<Activity> = {}
): Activity {
  return {
    id,
    source: "imap",
    kind: "email",
    at: "2026-09-21T09:00:00Z",
    title: subject,
    text,
    participants: [
      { ...from, role: "from" },
      { ...ME, role: "to" },
    ],
    fromMe: false,
    ...extra,
  };
}

export function outboundEmail(
  id: string,
  to: { name?: string; email: string },
  subject: string,
  text: string,
  extra: Partial<Activity> = {}
): Activity {
  return {
    id,
    source: "imap",
    kind: "email",
    at: "2026-09-21T10:00:00Z",
    title: subject,
    text,
    participants: [
      { ...ME, role: "from" },
      { ...to, role: "to" },
    ],
    fromMe: true,
    ...extra,
  };
}

export function commit(id: string, project: string, subject: string, at = "2026-09-21T11:00:00Z"): Activity {
  return {
    id,
    source: "git",
    kind: "commit",
    at,
    title: subject,
    text: subject,
    project,
    participants: [{ name: "Sam Rivera", handle: "samr", role: "from" }],
    fromMe: true,
  };
}

export function chat(id: string, project: string, title: string, at = "2026-09-21T12:00:00Z"): Activity {
  return {
    id,
    source: "cursor",
    kind: "chat",
    at,
    title,
    text: `User asked: ${title}`,
    project,
    participants: [],
    fromMe: true,
  };
}

/** Replays canned replies in order and records every request. */
export class FakeProvider implements LlmProvider {
  name = "fake";
  requests: LlmRequest[] = [];
  constructor(private readonly replies: Array<string | Error | ((req: LlmRequest) => string)>) {}
  async complete(req: LlmRequest): Promise<string> {
    this.requests.push(req);
    const next = this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)];
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(req);
    return next ?? "";
  }
}
