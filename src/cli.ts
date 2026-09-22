#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  defaultConfig,
  defaultConfigPath,
  envFileKeys,
  expandHome,
  loadConfig,
  resolvePaths,
  validateConfig,
} from "./config.js";
import { createLogger } from "./log.js";
import { runOnce, staleAfterMs, type RunResult } from "./run.js";
import {
  expectedScheduleFiles,
  installedScheduleFiles,
  installSchedule,
  programArgs,
  renderSchedule,
  requiredEnvNames,
  uninstallSchedule,
  type ScheduleSpec,
} from "./schedule.js";
import { allSources } from "./sources/index.js";
import { StateStore } from "./state.js";
import type { Config, LlmProviderName, ThreadState } from "./types.js";
import { daysBetween, isValidTimeZone, localDate, localDateTime } from "./vault/dates.js";

const CLI_ENTRY = fileURLToPath(import.meta.url);

export const EXIT = { ok: 0, failed: 1, usage: 2, locked: 3 } as const;

export class UsageError extends Error {}

export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
}

const defaultIo: Io = {
  out: (t) => process.stdout.write(t.endsWith("\n") ? t : t + "\n"),
  err: (t) => process.stderr.write(t.endsWith("\n") ? t : t + "\n"),
  env: process.env,
};

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `4h`, `2d`, `30m`, `1w` (that long before `now`) or any ISO 8601 date/time. */
export function parseWhen(value: string, now: Date = new Date()): Date {
  const v = value.trim();
  const rel = /^(\d+)\s*(m|min|mins|h|hr|hrs|d|w)$/i.exec(v);
  if (rel) {
    const unit = rel[2]!.toLowerCase()[0]!;
    return new Date(now.getTime() - Number(rel[1]) * UNIT_MS[unit]!);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new UsageError(`Can't read "${value}" as a time. Use an ISO date like 2026-09-01T09:00 or a duration like 4h, 2d, 30m.`);
}

// ---------- help ----------

const HELP: Record<string, string> = {
  main: `worklog: turn your chats, commits, mail and Slack into Obsidian notes.

Usage: worklog <command> [options]

Commands:
  init                 Create a config interactively (or --yes with flags)
  run                  Collect, extract and write into the vault
  status               Last run, open threads, enabled sources
  doctor               Check config, sources, vault and schedule
  schedule <action>    install | uninstall | print the background schedule

Global options:
  --config <path>      Config file (default: $WORKLOG_CONFIG or ${defaultConfigPath()})
  -h, --help           Help for a command
  --version            Print the version

Exit codes: 0 ok or skipped, 1 failed, 2 usage error, 3 another run holds the lock.`,
  init: `Usage: worklog init [options]

Asks for your name, emails, work domains, vault path, LLM provider and which
sources to read, then writes the config. API keys are never stored: you give
the name of the environment variable that holds each one.

Options:
  -y, --yes              Don't ask; use flags and auto-detected defaults
  --name <name>          Your name
  --email <addr>         Your email (repeatable)
  --domain <domain>      A work domain (repeatable)
  --vault <path>         Obsidian vault folder
  --llm <provider>       none | openai | anthropic | ollama
  --model <model>        Model name for the provider
  --api-key-env <NAME>   Env var holding the API key
  --timezone <zone>      IANA zone for daily note dates
  --force                Overwrite an existing config`,
  run: `Usage: worklog run [options]

Options:
  --since <when>   Window start: ISO time or a duration back from now (4h, 2d, 30m).
                   Default: end of the last successful run, else 24h ago.
  --until <when>   Window end (default: now)
  --dry-run        Show what would be written; change nothing
  --if-stale       Skip unless the last run is older than the schedule gap + 30 min
  --json           Print the digest as JSON
  --timeout <dur>  Give up after this long (default 15m)`,
  status: `Usage: worklog status

Shows the last run, the window it covered, open threads (waiting on you first)
and which sources are enabled.`,
  doctor: `Usage: worklog doctor

Checks the config, each enabled source, the LLM key, the vault and the
schedule. Exits 1 if anything needs fixing.`,
  schedule: `Usage: worklog schedule <install|uninstall|print> [--pass-env]

macOS: two launchd agents in ~/Library/LaunchAgents. dev.worklog.run fires at
each schedule time; dev.worklog.catchup runs \`run --if-stale\` every 30 min,
because launchd skips calendar slots missed while the Mac sleeps.
Linux: a systemd user timer with Persistent=true, or crontab lines.

Options:
  --pass-env   Copy the current values of the API key/token env vars into the
               job definition (file is written owner-only). Schedulers don't
               see variables exported in your shell profile.`,
};

// ---------- arg parsing ----------

interface Global {
  configPath: string;
  help: boolean;
  version: boolean;
  command?: string;
  rest: string[];
}

function splitGlobal(argv: string[], env: NodeJS.ProcessEnv): Global {
  let configPath = env.WORKLOG_CONFIG || "";
  let help = false;
  let version = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") {
      const v = argv[++i];
      if (!v) throw new UsageError("--config needs a path");
      configPath = v;
    } else if (a.startsWith("--config=")) {
      configPath = a.slice("--config=".length);
    } else if (a === "-h" || a === "--help") {
      help = true;
    } else if (a === "--version") {
      version = true;
    } else {
      rest.push(a);
    }
  }
  const [command, ...tail] = rest;
  return {
    configPath: resolve(expandHome(configPath || defaultConfigPath())),
    help,
    version,
    command,
    rest: tail,
  };
}

function parse<T extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: T, positionals = false) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: positionals });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function version(): string {
  for (const p of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "worklog" && pkg.version) return pkg.version;
    } catch {
      // try the next location
    }
  }
  return "0.0.0";
}

function loadOrExplain(path: string, io: Io): Config | null {
  try {
    return loadConfig(path);
  } catch (err) {
    io.err((err as Error).message);
    return null;
  }
}

// ---------- formatting ----------

function ago(from: Date, now: Date): string {
  const mins = Math.round((now.getTime() - from.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 90) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function threadAge(t: ThreadState, config: Config, now: Date): number {
  const since = localDate(t.since, config.timezone);
  return since ? Math.max(0, daysBetween(since, localDate(now, config.timezone))) : 0;
}

function openThreadsFor(config: Config, threads: Record<string, ThreadState>, now: Date) {
  const drop = new Set(config.filters.dropCategories);
  const today = localDate(now, config.timezone);
  return Object.values(threads)
    .filter((t) => t.waitingOn !== "nobody" && !drop.has(t.category))
    .filter((t) => {
      const last = localDate(t.lastActivityAt || t.since, config.timezone);
      return last !== "" && daysBetween(last, today) <= 30;
    })
    .map((t) => ({ t, age: threadAge(t, config, now) }))
    .sort((a, b) => (a.t.waitingOn === b.t.waitingOn ? b.age - a.age : a.t.waitingOn === "me" ? -1 : 1));
}

export function formatRunSummary(result: RunResult, config: Config, dryRun: boolean): string {
  const lines: string[] = [];
  const tz = config.timezone;
  lines.push(`worklog run${dryRun ? " (dry run)" : ""}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
  if (result.window) {
    const s = localDateTime(new Date(result.window.since), tz);
    const u = localDateTime(new Date(result.window.until), tz);
    lines.push(`Window: ${s} → ${u} (${tz})`);
  }
  const names = Object.keys(result.counts);
  if (names.length) {
    const parts = names.map((n) => (result.errors?.[n] ? `${n} FAILED (${result.errors[n]})` : `${n} ${result.counts[n]}`));
    lines.push(`Sources: ${parts.join(" · ")}`);
  }
  const d = result.digest;
  if (d) {
    lines.push(`Projects (${d.projects.length})`);
    for (const p of d.projects) lines.push(`  ${p.name} [${p.status}] ${p.summary}`);
    lines.push(`Contacts (${d.contacts.length})`);
    for (const c of d.contacts) {
      const meta = [c.company, c.category].filter(Boolean).join(", ");
      lines.push(`  ${c.name}${meta ? ` (${meta})` : ""}${c.summary ? ` — ${c.summary}` : ""}`);
    }
    lines.push(`Threads (${d.threads.length})`);
    for (const t of d.threads) lines.push(`  waiting on ${t.waitingOn}: ${t.counterpart} — ${t.title}`);
    lines.push(
      `Daily log: ${d.progress.length} progress, ${d.actions.length} actions, ${d.openQuestions.length} questions, ${d.noticed.length} noticed`
    );
  }
  const r = result.report;
  if (r) {
    lines.push(dryRun ? "Planned writes:" : "Writes:");
    for (const p of r.created) lines.push(`  create ${p}`);
    for (const p of r.updated) lines.push(`  update ${p}`);
    if (r.unchanged.length) lines.push(`  (${r.unchanged.length} unchanged)`);
    if (!r.created.length && !r.updated.length) lines.push("  nothing to change");
  }
  return lines.join("\n");
}

// ---------- commands ----------

async function cmdRun(g: Global, io: Io): Promise<number> {
  const { values } = parse(g.rest, {
    since: { type: "string" },
    until: { type: "string" },
    "dry-run": { type: "boolean" },
    "if-stale": { type: "boolean" },
    json: { type: "boolean" },
    timeout: { type: "string" },
  });
  const now = io.now?.() ?? new Date();
  const since = values.since ? parseWhen(values.since, now) : undefined;
  const until = values.until ? parseWhen(values.until, now) : undefined;
  let timeoutMs: number | undefined;
  if (values.timeout) {
    const m = /^(\d+)\s*(m|h|s)?$/.exec(values.timeout);
    if (!m) throw new UsageError(`--timeout wants a duration like 15m, got "${values.timeout}"`);
    timeoutMs = Number(m[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "m") as "s" | "m" | "h"]);
  }
  const config = loadOrExplain(g.configPath, io);
  if (!config) return EXIT.failed;
  const problems = validateConfig(config);
  if (problems.length) {
    io.err(`Config problems in ${g.configPath}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    return EXIT.failed;
  }
  const dryRun = !!values["dry-run"];
  const result = await runOnce({
    config,
    log: createLogger(),
    since,
    until,
    dryRun,
    ifStale: !!values["if-stale"],
    timeoutMs,
    now: io.now?.(),
  });
  if (values.json) {
    io.out(JSON.stringify(result.digest ?? { status: result.status, reason: result.reason }, null, 2));
  } else {
    io.out(formatRunSummary(result, config, dryRun));
  }
  return result.status === "failed" ? EXIT.failed : result.status === "locked" ? EXIT.locked : EXIT.ok;
}

function cmdStatus(g: Global, io: Io): number {
  parse(g.rest, {});
  const config = loadOrExplain(g.configPath, io);
  if (!config) return EXIT.failed;
  const now = io.now?.() ?? new Date();
  const tz = config.timezone;
  const state = new StateStore(config.stateDir);
  const wm = state.readWatermark();
  const lines: string[] = [`Config: ${g.configPath}`, `Vault: ${config.vault}`];
  if (wm) {
    const finished = new Date(wm.finishedAt);
    lines.push(`Last run: ${localDateTime(finished, tz)} (${ago(finished, now)})`);
    lines.push(`Covered through: ${localDateTime(new Date(wm.until), tz)}`);
    const stale = now.getTime() - finished.getTime() >= staleAfterMs(config);
    lines.push(`Catch-up due: ${stale ? "yes" : "no"}`);
  } else {
    lines.push("Last run: never");
  }
  const pidFile = join(config.stateDir, "lock", "pid");
  if (existsSync(pidFile)) lines.push(`Running now: pid ${readFileSync(pidFile, "utf8").trim()}`);

  const open = openThreadsFor(config, state.readThreads(), now);
  const mine = open.filter((o) => o.t.waitingOn === "me");
  const theirs = open.filter((o) => o.t.waitingOn === "them");
  const fmt = ({ t, age }: { t: ThreadState; age: number }) =>
    `  ${String(age).padStart(3)}d  ${t.counterpart}${t.company ? ` (${t.company})` : ""} — ${t.title}`;
  lines.push("", `Waiting on you (${mine.length})`, ...(mine.length ? mine.map(fmt) : ["  nothing"]));
  lines.push("", `Waiting on them (${theirs.length})`, ...(theirs.length ? theirs.map(fmt) : ["  nothing"]));

  const enabled = allSources.filter((s) => {
    try {
      return s.enabled(config);
    } catch {
      return false;
    }
  });
  lines.push("", `Sources: ${enabled.map((s) => s.name).join(", ") || "none enabled"}`);
  const spec = scheduleSpec(config, g.configPath);
  const installed = installedScheduleFiles(spec);
  lines.push(`Schedule: ${installed.length ? `installed (${config.schedule.times.join(", ")})` : "not installed"}`);
  io.out(lines.join("\n"));
  return EXIT.ok;
}

function envSet(env: NodeJS.ProcessEnv, name?: string): boolean {
  return !!name && !!env[name];
}

function cmdDoctor(g: Global, io: Io): number {
  parse(g.rest, {});
  const lines: string[] = [];
  let bad = 0;
  const ok = (m: string) => lines.push(`  ok    ${m}`);
  const warn = (m: string) => lines.push(`  warn  ${m}`);
  const fail = (m: string) => {
    bad++;
    lines.push(`  FAIL  ${m}`);
  };

  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) ok(`node ${process.versions.node}`);
  else fail(`node ${process.versions.node} is too old; worklog needs 22+`);

  if (!existsSync(g.configPath)) {
    fail(`no config at ${g.configPath}; run \`worklog init\``);
    io.out(["worklog doctor", ...lines].join("\n"));
    return EXIT.failed;
  }
  let config: Config;
  try {
    config = loadConfig(g.configPath);
    ok(`config ${g.configPath}`);
  } catch (err) {
    fail(`config ${g.configPath}: ${(err as Error).message}`);
    io.out(["worklog doctor", ...lines].join("\n"));
    return EXIT.failed;
  }
  for (const p of validateConfig(config)) fail(`config: ${p}`);
  if (isValidTimeZone(config.timezone)) ok(`timezone ${config.timezone}`);
  else fail(`timezone "${config.timezone}" is not an IANA zone`);

  const s = config.sources;
  const pathCheck = (label: string, enabled: boolean, path: string) => {
    if (!enabled) return lines.push(`  -     ${label}: disabled`);
    return existsSync(path) ? ok(`${label}: ${path}`) : fail(`${label}: ${path} does not exist`);
  };
  pathCheck("cursor", s.cursor.enabled, s.cursor.path);
  pathCheck("claude-code", s.claudeCode.enabled, s.claudeCode.path);
  if (!s.git.enabled) lines.push("  -     git: disabled");
  else {
    const missing = s.git.roots.filter((r) => !existsSync(r));
    if (s.git.roots.length === 0) fail("git: no roots configured");
    else if (missing.length) fail(`git: missing roots ${missing.join(", ")}`);
    else ok(`git: ${s.git.roots.join(", ")}`);
  }
  if (!s.slack.enabled) lines.push("  -     slack: disabled");
  else if (envSet(io.env, s.slack.tokenEnv)) ok(`slack: $${s.slack.tokenEnv} set`);
  else fail(`slack: $${s.slack.tokenEnv} is not set`);
  if (!s.imap.enabled) lines.push("  -     imap: disabled");
  else if (!s.imap.user) fail("imap: no user");
  else if (envSet(io.env, s.imap.passwordEnv)) ok(`imap: ${s.imap.user}@${s.imap.host}, $${s.imap.passwordEnv} set`);
  else fail(`imap: $${s.imap.passwordEnv} is not set`);
  if (!s.calendar.enabled) lines.push("  -     calendar: disabled");
  else if (s.calendar.icsUrls.length) ok(`calendar: ${s.calendar.icsUrls.length} feed(s)`);
  else fail("calendar: no icsUrls");

  const llm = config.llm;
  if (llm.provider === "none") warn("llm: none (heuristic extraction only)");
  else if (llm.provider === "ollama") ok(`llm: ollama${llm.model ? ` ${llm.model}` : ""}`);
  else if (envSet(io.env, llm.apiKeyEnv)) ok(`llm: ${llm.provider}${llm.model ? ` ${llm.model}` : ""}, $${llm.apiKeyEnv} set`);
  else fail(`llm: $${llm.apiKeyEnv ?? "(apiKeyEnv)"} is not set`);

  if (!existsSync(config.vault)) fail(`vault: ${config.vault} does not exist`);
  else {
    try {
      accessSync(config.vault, constants.W_OK);
      ok(`vault: ${config.vault} is writable`);
    } catch {
      fail(`vault: ${config.vault} is not writable`);
    }
    for (const dir of [config.layout.log, config.layout.people, config.layout.companies, config.layout.projects]) {
      if (!existsSync(join(config.vault, dir))) warn(`vault: folder ${dir}/ will be created on first run`);
    }
  }

  const spec = scheduleSpec(config, g.configPath);
  const installed = installedScheduleFiles(spec);
  const expected = expectedScheduleFiles(spec);
  if (expected.length === 0) warn("schedule: unsupported platform; use `worklog schedule print` for crontab lines");
  else if (installed.length === expected.length) {
    ok(`schedule: installed (${config.schedule.times.join(", ")})`);
    const needed = requiredEnvNames(config);
    const contents = installed.map((f) => readFileSync(f, "utf8")).join("\n");
    const missing = needed.filter((n) => !contents.includes(n) && !envFileKeys.has(n));
    if (missing.length) {
      warn(
        `schedule: jobs won't see ${missing.map((n) => `$${n}`).join(", ")}; put them in ${config.envFile}`
      );
    }
    const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (machineZone && machineZone !== config.timezone) {
      warn(`schedule: times fire in the machine zone ${machineZone}, not ${config.timezone}`);
    }
  } else if (installed.length) warn(`schedule: partially installed (${installed.join(", ")}); run \`worklog schedule install\``);
  else warn("schedule: not installed; run `worklog schedule install`");

  io.out(["worklog doctor", ...lines, "", bad ? `${bad} problem(s) found.` : "All good."].join("\n"));
  return bad ? EXIT.failed : EXIT.ok;
}

function scheduleSpec(config: Config, configPath: string, env?: Record<string, string>): ScheduleSpec {
  return { program: programArgs(CLI_ENTRY), configPath, config, env };
}

function cmdSchedule(g: Global, io: Io): number {
  const { values, positionals } = parse(g.rest, { "pass-env": { type: "boolean" } }, true);
  const action = positionals[0];
  if (!action || !["install", "uninstall", "print"].includes(action) || positionals.length > 1) {
    throw new UsageError("schedule wants one of: install, uninstall, print");
  }
  const config = loadOrExplain(g.configPath, io);
  if (!config) return EXIT.failed;
  const needed = requiredEnvNames(config);
  let env: Record<string, string> | undefined;
  if (values["pass-env"]) {
    env = {};
    for (const n of needed) {
      const v = io.env[n];
      if (v) env[n] = v;
      else io.err(`warning: $${n} is not set, so the scheduled job won't have it`);
    }
  }
  const spec = scheduleSpec(config, g.configPath, env);
  if (action === "print") {
    const redacted = env ? { ...spec, env: Object.fromEntries(Object.keys(env).map((k) => [k, "<redacted>"])) } : spec;
    io.out(renderSchedule(redacted));
    return EXIT.ok;
  }
  const run = action === "install" ? installSchedule : uninstallSchedule;
  const problems = run(spec, { out: (l) => io.out(l) });
  for (const p of problems) io.err(p);
  if (action === "install" && !problems.length) {
    io.out(`Runs at ${config.schedule.times.join(", ")} (machine time); logs in ${join(config.stateDir, "logs")}`);
    const notInFile = needed.filter((n) => !envFileKeys.has(n));
    if (notInFile.length && !env) {
      io.err(
        `note: scheduled jobs don't inherit your shell environment. Put ${notInFile.map((n) => `${n}=…`).join(", ")} ` +
          `in ${config.envFile} (chmod 600), or rerun with --pass-env.`
      );
    }
  }
  return problems.length ? EXIT.failed : EXIT.ok;
}

// ---------- init ----------

function gitConfig(key: string): string {
  const r = spawnSync("git", ["config", "--global", key], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function hasGitRepo(dir: string, depth = 2): boolean {
  if (existsSync(join(dir, ".git"))) return true;
  if (depth === 0) return false;
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (d) => d.isDirectory() && !d.name.startsWith(".") && hasGitRepo(join(dir, d.name), depth - 1)
    );
  } catch {
    return false;
  }
}

export interface Detected {
  name: string;
  email: string;
  cursor: boolean;
  claudeCode: boolean;
  gitRoots: string[];
}

export function detectEnvironment(home = homedir()): Detected {
  const tilde = (p: string) => (p.startsWith(home + "/") ? "~/" + p.slice(home.length + 1) : p);
  return {
    name: gitConfig("user.name"),
    email: gitConfig("user.email"),
    cursor: existsSync(join(home, ".cursor", "projects")),
    claudeCode: existsSync(join(home, ".claude", "projects")),
    gitRoots: ["Projects", "code", "src", "Developer"]
      .map((d) => join(home, d))
      .filter((d) => hasGitRepo(d))
      .map(tilde),
  };
}

const PROVIDERS: LlmProviderName[] = ["none", "openai", "anthropic", "ollama"];
const KEY_ENV: Partial<Record<LlmProviderName, string>> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

function splitList(v: string): string[] {
  return v
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function cmdInit(g: Global, io: Io): Promise<number> {
  const { values } = parse(g.rest, {
    yes: { type: "boolean", short: "y" },
    force: { type: "boolean" },
    name: { type: "string" },
    email: { type: "string", multiple: true },
    domain: { type: "string", multiple: true },
    vault: { type: "string" },
    llm: { type: "string" },
    model: { type: "string" },
    "api-key-env": { type: "string" },
    timezone: { type: "string" },
  });
  if (values.llm && !PROVIDERS.includes(values.llm as LlmProviderName)) {
    throw new UsageError(`--llm must be one of ${PROVIDERS.join(", ")}`);
  }
  if (existsSync(g.configPath) && !values.force) {
    io.err(`A config already exists at ${g.configPath}. Use --force to overwrite it.`);
    return EXIT.failed;
  }

  const detected = detectEnvironment();
  const base = defaultConfig();
  const emails = (values.email ?? []).flatMap(splitList);
  const domains = (values.domain ?? []).flatMap(splitList);
  const answers = {
    name: values.name ?? (detected.name || userInfo().username),
    emails: emails.length ? emails : detected.email ? [detected.email] : [],
    domains: domains.length ? domains : [],
    vault: values.vault ?? base.vault,
    timezone: values.timezone ?? base.timezone,
    provider: (values.llm as LlmProviderName | undefined) ?? "none",
    model: values.model,
    apiKeyEnv: values["api-key-env"],
    cursor: detected.cursor,
    claudeCode: detected.claudeCode,
    gitRoots: detected.gitRoots,
    slack: false,
    slackTokenEnv: base.sources.slack.tokenEnv,
    imap: false,
    imapHost: base.sources.imap.host,
    imapUser: "",
    imapPasswordEnv: base.sources.imap.passwordEnv,
    calendar: false,
    icsUrls: [] as string[],
  };
  if (answers.domains.length === 0) {
    const d = answers.emails[0]?.split("@")[1];
    if (d && !/^(gmail|googlemail|outlook|hotmail|icloud|me|yahoo|proton|protonmail)\./.test(d)) answers.domains = [d];
  }

  if (!values.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ask = async (q: string, def = ""): Promise<string> => {
      const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
      return a || def;
    };
    const yes = async (q: string, def: boolean): Promise<boolean> => {
      const a = (await ask(`${q} (y/n)`, def ? "y" : "n")).toLowerCase();
      return a.startsWith("y");
    };
    try {
      answers.name = await ask("Your name", answers.name);
      answers.emails = splitList(await ask("Your email address(es), comma separated", answers.emails.join(", ")));
      answers.domains = splitList(await ask("Work domains (teammates, not contacts)", answers.domains.join(", ")));
      answers.vault = await ask("Obsidian vault folder", answers.vault);
      answers.timezone = await ask("Timezone for daily notes", answers.timezone);
      let provider = "";
      while (!PROVIDERS.includes(provider as LlmProviderName)) {
        provider = await ask(`LLM provider (${PROVIDERS.join("/")})`, answers.provider);
      }
      answers.provider = provider as LlmProviderName;
      if (answers.provider !== "none") {
        answers.model = (await ask("Model (blank for the default)", answers.model ?? "")) || undefined;
        if (answers.provider !== "ollama") {
          answers.apiKeyEnv = await ask(
            "Name of the env var that holds the API key (the key itself is never stored)",
            answers.apiKeyEnv ?? KEY_ENV[answers.provider] ?? ""
          );
        }
      }
      answers.cursor = await yes(`Read Cursor chats (~/.cursor/projects)${detected.cursor ? "" : " [not found]"}`, detected.cursor);
      answers.claudeCode = await yes(
        `Read Claude Code chats (~/.claude/projects)${detected.claudeCode ? "" : " [not found]"}`,
        detected.claudeCode
      );
      answers.gitRoots = splitList(
        await ask("Folders to scan for git repos, comma separated (blank to skip)", answers.gitRoots.join(", "))
      );
      answers.slack = await yes("Read Slack (needs a user token)", false);
      if (answers.slack) answers.slackTokenEnv = await ask("Env var holding the Slack token", answers.slackTokenEnv);
      answers.imap = await yes("Read email over IMAP", false);
      if (answers.imap) {
        answers.imapHost = await ask("IMAP host", answers.imapHost);
        answers.imapUser = await ask("IMAP user", answers.emails[0] ?? "");
        answers.imapPasswordEnv = await ask("Env var holding the IMAP (app) password", answers.imapPasswordEnv);
      }
      answers.calendar = await yes("Read calendars from ICS URLs", false);
      if (answers.calendar) answers.icsUrls = splitList(await ask("ICS URLs, comma separated"));
    } finally {
      rl.close();
    }
  } else if (answers.provider !== "none" && answers.provider !== "ollama" && !answers.apiKeyEnv) {
    answers.apiKeyEnv = KEY_ENV[answers.provider];
  }

  if (!isValidTimeZone(answers.timezone)) throw new UsageError(`"${answers.timezone}" is not an IANA timezone`);

  const config: Config = {
    ...base,
    vault: answers.vault,
    timezone: answers.timezone,
    me: { name: answers.name, emails: answers.emails, domains: answers.domains },
    llm: {
      provider: answers.provider,
      ...(answers.model ? { model: answers.model } : {}),
      ...(answers.apiKeyEnv && answers.provider !== "none" ? { apiKeyEnv: answers.apiKeyEnv } : {}),
    },
    sources: {
      ...base.sources,
      cursor: { ...base.sources.cursor, enabled: answers.cursor },
      claudeCode: { ...base.sources.claudeCode, enabled: answers.claudeCode },
      git: { ...base.sources.git, enabled: answers.gitRoots.length > 0, roots: answers.gitRoots.length ? answers.gitRoots : base.sources.git.roots },
      slack: { ...base.sources.slack, enabled: answers.slack, tokenEnv: answers.slackTokenEnv },
      imap: {
        ...base.sources.imap,
        enabled: answers.imap,
        host: answers.imapHost,
        user: answers.imapUser,
        passwordEnv: answers.imapPasswordEnv,
      },
      calendar: { enabled: answers.calendar && answers.icsUrls.length > 0, icsUrls: answers.icsUrls },
    },
  };
  const { stateDir: _stateDir, ...stored } = config;

  const problems = validateConfig(config);
  mkdirSync(dirname(g.configPath), { recursive: true });
  writeFileSync(g.configPath, JSON.stringify(stored, null, 2) + "\n");
  io.out(`Wrote ${g.configPath}`);

  const resolved = resolvePaths(config);
  for (const dir of [resolved.layout.log, resolved.layout.people, resolved.layout.companies, resolved.layout.projects]) {
    const full = join(resolved.vault, dir);
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true });
      io.out(`Created ${full}`);
    }
  }
  for (const p of problems) io.err(`warning: ${p}`);
  io.out("Next: `worklog doctor`, then `worklog run --dry-run`, then `worklog schedule install`.");
  return EXIT.ok;
}

// ---------- main ----------

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    const g = splitGlobal(argv, io.env);
    if (g.version) {
      io.out(version());
      return EXIT.ok;
    }
    if (!g.command || g.command === "help") {
      const topic = g.command === "help" ? g.rest[0] : undefined;
      io.out(HELP[topic ?? "main"] ?? HELP.main!);
      return g.command || g.help ? EXIT.ok : EXIT.usage;
    }
    if (g.help) {
      if (!HELP[g.command]) throw new UsageError(`Unknown command "${g.command}"`);
      io.out(HELP[g.command]!);
      return EXIT.ok;
    }
    switch (g.command) {
      case "init":
        return await cmdInit(g, io);
      case "run":
        return await cmdRun(g, io);
      case "status":
        return cmdStatus(g, io);
      case "doctor":
        return cmdDoctor(g, io);
      case "schedule":
        return cmdSchedule(g, io);
      default:
        throw new UsageError(`Unknown command "${g.command}". Try \`worklog --help\`.`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`worklog: ${err.message}`);
      return EXIT.usage;
    }
    io.err(`worklog: ${(err as Error).stack ?? String(err)}`);
    return EXIT.failed;
  }
}

function invokedDirectly(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(CLI_ENTRY);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    // A source that leaves a socket open must not keep a scheduled job alive.
    setTimeout(() => process.exit(code), 5000).unref();
  });
}
