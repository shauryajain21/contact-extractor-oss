import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Config } from "./types.js";

export const RUN_LABEL = "dev.worklog.run";
export const CATCHUP_LABEL = "dev.worklog.catchup";
export const CATCHUP_INTERVAL_S = 1800;
const SYSTEMD_NAME = "worklog";

export interface ScheduleSpec {
  /** Absolute node binary followed by loader flags and the absolute CLI entry. */
  program: string[];
  configPath: string;
  config: Config;
  /** Extra environment baked into the job (e.g. API keys when the user opts in). */
  env?: Record<string, string>;
  home?: string;
}

export interface GeneratedFile {
  label: string;
  path: string;
  content: string;
  /** Contains secrets, so keep it owner-only. */
  secret: boolean;
}

const LOADER_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader"]);

function isBare(spec: string): boolean {
  return !(spec.startsWith("/") || spec.startsWith(".") || spec.startsWith("file:") || isAbsolute(spec));
}

function resolveLoader(flag: string, spec: string): string {
  if (!isBare(spec)) return spec.startsWith(".") ? resolve(spec) : spec;
  try {
    if (flag === "--require" || flag === "-r") return createRequire(import.meta.url).resolve(spec);
    return import.meta.resolve(spec);
  } catch {
    return spec;
  }
}

/**
 * The command a scheduler should run: this exact node binary, any loader it
 * was started with (so `tsx src/cli.ts` keeps working without a shell or
 * cwd), and the CLI entry, all as absolute paths.
 */
export function programArgs(entry: string, execPath = process.execPath, execArgv = process.execArgv): string[] {
  const loaders: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]!;
    const eq = arg.indexOf("=");
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (!LOADER_FLAGS.has(flag)) continue;
    const value = eq > 0 ? arg.slice(eq + 1) : execArgv[++i];
    if (value) loaders.push(flag, resolveLoader(flag, value));
  }
  const absEntry = resolve(entry);
  if (/\.[cm]?ts$/.test(absEntry) && loaders.length === 0) {
    loaders.push("--import", resolveLoader("--import", "tsx"));
  }
  return [execPath, ...loaders, absEntry];
}

export function logDir(config: Config): string {
  return join(config.stateDir, "logs");
}

function jobPath(spec: ScheduleSpec): string {
  const nodeDir = dirname(spec.program[0]!);
  const dirs = [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs)].join(":");
}

function jobEnv(spec: ScheduleSpec): Record<string, string> {
  const xdg: Record<string, string> = {};
  for (const k of ["XDG_STATE_HOME", "XDG_CONFIG_HOME"]) {
    const v = process.env[k];
    if (v) xdg[k] = v;
  }
  return { PATH: jobPath(spec), WORKLOG_CONFIG: spec.configPath, ...xdg, ...(spec.env ?? {}) };
}

function commandFor(spec: ScheduleSpec, extra: string[]): string[] {
  return [...spec.program, "--config", spec.configPath, "run", ...extra];
}

function parseTime(t: string): { hour: number; minute: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

function scheduleTimes(config: Config): Array<{ hour: number; minute: number }> {
  return config.schedule.times.map(parseTime).filter((t): t is { hour: number; minute: number } => t !== null);
}

// ---------- launchd ----------

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function plist(entries: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...entries,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

const key = (k: string) => `  <key>${xml(k)}</key>`;
const str = (v: string, indent = "  ") => `${indent}<string>${xml(v)}</string>`;

function stringArray(values: string[]): string[] {
  return ["  <array>", ...values.map((v) => str(v, "    ")), "  </array>"];
}

function envDict(env: Record<string, string>): string[] {
  return [
    "  <dict>",
    ...Object.entries(env).flatMap(([k, v]) => [`    <key>${xml(k)}</key>`, str(v, "    ")]),
    "  </dict>",
  ];
}

export function launchAgentsDir(home = homedir()): string {
  return join(home, "Library", "LaunchAgents");
}

export function launchdPlists(spec: ScheduleSpec): GeneratedFile[] {
  const dir = launchAgentsDir(spec.home);
  const logs = logDir(spec.config);
  const secret = Object.keys(spec.env ?? {}).length > 0;
  const common = (label: string, command: string[], logName: string) => [
    key("Label"),
    str(label),
    key("ProgramArguments"),
    ...stringArray(command),
    key("EnvironmentVariables"),
    ...envDict(jobEnv(spec)),
    key("WorkingDirectory"),
    str(spec.config.stateDir),
    key("StandardOutPath"),
    str(join(logs, `${logName}.out.log`)),
    key("StandardErrorPath"),
    str(join(logs, `${logName}.err.log`)),
    key("ProcessType"),
    str("Background"),
    key("LowPriorityIO"),
    "  <true/>",
  ];

  const calendar = [
    key("StartCalendarInterval"),
    "  <array>",
    ...scheduleTimes(spec.config).flatMap((t) => [
      "    <dict>",
      "      <key>Hour</key>",
      `      <integer>${t.hour}</integer>`,
      "      <key>Minute</key>",
      `      <integer>${t.minute}</integer>`,
      "    </dict>",
    ]),
    "  </array>",
    key("RunAtLoad"),
    "  <false/>",
  ];

  const catchup = [
    key("StartInterval"),
    `  <integer>${CATCHUP_INTERVAL_S}</integer>`,
    key("RunAtLoad"),
    "  <true/>",
  ];

  return [
    {
      label: RUN_LABEL,
      path: join(dir, `${RUN_LABEL}.plist`),
      content: plist([...common(RUN_LABEL, commandFor(spec, []), "run"), ...calendar]),
      secret,
    },
    {
      label: CATCHUP_LABEL,
      path: join(dir, `${CATCHUP_LABEL}.plist`),
      content: plist([...common(CATCHUP_LABEL, commandFor(spec, ["--if-stale"]), "catchup"), ...catchup]),
      secret,
    },
  ];
}

// ---------- systemd / cron ----------

function systemdQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\])/g, "\\$1")}"`;
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function systemdUserDir(home?: string): string {
  const base = home ? join(home, ".config") : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "systemd", "user");
}

export function systemdUnits(spec: ScheduleSpec): GeneratedFile[] {
  const dir = systemdUserDir(spec.home);
  const logs = logDir(spec.config);
  const env = jobEnv(spec);
  const service = [
    "[Unit]",
    "Description=worklog: write recent activity into the Obsidian vault",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${commandFor(spec, []).map(systemdQuote).join(" ")}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`),
    `WorkingDirectory=${systemdQuote(spec.config.stateDir)}`,
    `StandardOutput=append:${join(logs, "run.out.log")}`,
    `StandardError=append:${join(logs, "run.err.log")}`,
    "TimeoutStartSec=20min",
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    "Description=worklog schedule",
    "",
    "[Timer]",
    ...scheduleTimes(spec.config).map((t) => `OnCalendar=*-*-* ${pad(t.hour)}:${pad(t.minute)}:00`),
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return [
    { label: `${SYSTEMD_NAME}.service`, path: join(dir, `${SYSTEMD_NAME}.service`), content: service, secret: !!spec.env && Object.keys(spec.env).length > 0 },
    { label: `${SYSTEMD_NAME}.timer`, path: join(dir, `${SYSTEMD_NAME}.timer`), content: timer, secret: false },
  ];
}

const pad = (n: number) => String(n).padStart(2, "0");

export function crontabLines(spec: ScheduleSpec): string[] {
  const log = shellQuote(join(logDir(spec.config), "cron.log"));
  const cmd = (extra: string[]) => commandFor(spec, extra).map(shellQuote).join(" ");
  return [
    `PATH=${jobPath(spec)}`,
    ...scheduleTimes(spec.config).map((t) => `${t.minute} ${t.hour} * * * ${cmd([])} >> ${log} 2>&1`),
    `*/30 * * * * ${cmd(["--if-stale"])} >> ${log} 2>&1`,
  ];
}

// ---------- side effects ----------

export type Exec = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

export const defaultExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.error ? 127 : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error?.message || "") };
};

export interface ScheduleEnv {
  platform?: NodeJS.Platform;
  exec?: Exec;
  uid?: number;
  out?: (line: string) => void;
}

function writeGenerated(f: GeneratedFile): void {
  mkdirSync(dirname(f.path), { recursive: true });
  writeFileSync(f.path, f.content, { mode: f.secret ? 0o600 : 0o644 });
  if (f.secret) chmodSync(f.path, 0o600);
}

function hasSystemd(exec: Exec): boolean {
  return exec("systemctl", ["--user", "--version"]).status === 0;
}

/** What `schedule print` shows for this platform. */
export function renderSchedule(spec: ScheduleSpec, platform: NodeJS.Platform = process.platform): string {
  const files = platform === "darwin" ? launchdPlists(spec) : platform === "linux" ? systemdUnits(spec) : [];
  const parts = files.map((f) => `# ${f.path}\n${f.content}`);
  if (platform !== "darwin") parts.push(`# crontab alternative (crontab -e)\n${crontabLines(spec).join("\n")}\n`);
  return parts.join("\n");
}

export function installSchedule(spec: ScheduleSpec, env: ScheduleEnv = {}): string[] {
  const platform = env.platform ?? process.platform;
  const exec = env.exec ?? defaultExec;
  const out = env.out ?? (() => {});
  mkdirSync(logDir(spec.config), { recursive: true });
  const problems: string[] = [];

  if (platform === "darwin") {
    const domain = `gui/${env.uid ?? process.getuid?.() ?? 501}`;
    for (const f of launchdPlists(spec)) {
      exec("launchctl", ["bootout", `${domain}/${f.label}`]);
      writeGenerated(f);
      const r = exec("launchctl", ["bootstrap", domain, f.path]);
      if (r.status !== 0) problems.push(`launchctl bootstrap ${f.label} failed: ${r.stderr.trim()}`);
      else out(`loaded ${f.label} (${f.path})`);
    }
    return problems;
  }

  if (platform === "linux" && hasSystemd(exec)) {
    for (const f of systemdUnits(spec)) {
      writeGenerated(f);
      out(`wrote ${f.path}`);
    }
    for (const args of [["--user", "daemon-reload"], ["--user", "enable", "--now", `${SYSTEMD_NAME}.timer`]]) {
      const r = exec("systemctl", args);
      if (r.status !== 0) problems.push(`systemctl ${args.join(" ")} failed: ${r.stderr.trim()}`);
    }
    return problems;
  }

  out("No launchd or systemd found. Add these lines with `crontab -e`:");
  for (const line of crontabLines(spec)) out(line);
  return problems;
}

export function uninstallSchedule(spec: ScheduleSpec, env: ScheduleEnv = {}): string[] {
  const platform = env.platform ?? process.platform;
  const exec = env.exec ?? defaultExec;
  const out = env.out ?? (() => {});
  const problems: string[] = [];

  if (platform === "darwin") {
    const domain = `gui/${env.uid ?? process.getuid?.() ?? 501}`;
    for (const f of launchdPlists(spec)) {
      exec("launchctl", ["bootout", `${domain}/${f.label}`]);
      if (existsSync(f.path)) {
        rmSync(f.path);
        out(`removed ${f.path}`);
      }
    }
    return problems;
  }

  if (platform === "linux" && hasSystemd(exec)) {
    exec("systemctl", ["--user", "disable", "--now", `${SYSTEMD_NAME}.timer`]);
    for (const f of systemdUnits(spec)) {
      if (existsSync(f.path)) {
        rmSync(f.path);
        out(`removed ${f.path}`);
      }
    }
    exec("systemctl", ["--user", "daemon-reload"]);
    return problems;
  }

  out("Remove the worklog lines with `crontab -e`.");
  return problems;
}

/** Scheduler files present on disk for this platform. */
export function installedScheduleFiles(spec: ScheduleSpec, platform: NodeJS.Platform = process.platform): string[] {
  const files = platform === "darwin" ? launchdPlists(spec) : platform === "linux" ? systemdUnits(spec) : [];
  return files.filter((f) => existsSync(f.path)).map((f) => f.path);
}

export function expectedScheduleFiles(spec: ScheduleSpec, platform: NodeJS.Platform = process.platform): string[] {
  const files = platform === "darwin" ? launchdPlists(spec) : platform === "linux" ? systemdUnits(spec) : [];
  return files.map((f) => f.path);
}

/** Env var names the job needs that a scheduler won't inherit from the login shell. */
export function requiredEnvNames(config: Config): string[] {
  const names: string[] = [];
  if (config.llm.provider !== "none" && config.llm.apiKeyEnv) names.push(config.llm.apiKeyEnv);
  if (config.sources.slack.enabled) names.push(config.sources.slack.tokenEnv);
  if (config.sources.imap.enabled) names.push(config.sources.imap.passwordEnv);
  return [...new Set(names.filter(Boolean))];
}
