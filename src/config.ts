import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./types.js";

export const APP_NAME = "worklog";

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, APP_NAME, "config.json");
}

export function defaultStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(xdg, APP_NAME);
}

export function defaultConfig(): Config {
  return {
    vault: "~/Documents/Obsidian Vault",
    layout: {
      log: "Log",
      people: "People",
      companies: "Companies",
      projects: "Projects",
      dashboard: "Dashboard.md",
    },
    me: { name: "", emails: [], domains: [] },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    llm: { provider: "none" },
    sources: {
      cursor: { enabled: true, path: "~/.cursor/projects" },
      claudeCode: { enabled: true, path: "~/.claude/projects" },
      git: { enabled: true, roots: ["~/Projects"], maxDepth: 2 },
      slack: { enabled: false, tokenEnv: "SLACK_USER_TOKEN" },
      imap: {
        enabled: false,
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        user: "",
        passwordEnv: "IMAP_PASSWORD",
        mailboxes: ["INBOX"],
      },
      calendar: { enabled: false, icsUrls: [] },
    },
    filters: {
      dropCategories: ["spam", "newsletter", "hiring"],
      ignoreDomains: [],
    },
    limits: { maxActivityChars: 4000, batchChars: 60000 },
    schedule: { times: ["08:00", "12:00", "16:00", "20:00"] },
    stateDir: defaultStateDir(),
    envFile: join(dirname(defaultConfigPath()), ".env"),
  };
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]!] = value;
  }
  return out;
}

/** Keys taken from the env file on the last `loadEnvFile` call. */
export const envFileKeys = new Set<string>();

/** Fill unset variables from the env file. Values already in the environment win. */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const file = expandHome(path);
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(parseEnvFile(readFileSync(file, "utf8")))) {
    envFileKeys.add(k);
    if (env[k] === undefined || env[k] === "") {
      env[k] = v;
      loaded.push(k);
    }
  }
  return loaded;
}

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Arrays replace, objects merge. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlain(base) || !isPlain(override)) return (override ?? base) as T;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function resolvePaths(config: Config): Config {
  const s = config.sources;
  return {
    ...config,
    vault: resolve(expandHome(config.vault)),
    stateDir: resolve(expandHome(config.stateDir)),
    envFile: resolve(expandHome(config.envFile)),
    sources: {
      ...s,
      cursor: { ...s.cursor, path: expandHome(s.cursor.path) },
      claudeCode: { ...s.claudeCode, path: expandHome(s.claudeCode.path) },
      git: { ...s.git, roots: s.git.roots.map(expandHome) },
      calendar: { ...s.calendar, icsUrls: s.calendar.icsUrls.map(expandHome) },
    },
  };
}

export function validateConfig(config: Config): string[] {
  const problems: string[] = [];
  if (!config.vault) problems.push("`vault` is required");
  if (!config.me.name) problems.push("`me.name` is required");
  if (config.me.emails.length === 0) problems.push("`me.emails` should list at least one address");
  if (config.llm.provider !== "none" && config.llm.provider !== "ollama" && !config.llm.apiKeyEnv) {
    problems.push("`llm.apiKeyEnv` is required for provider " + config.llm.provider);
  }
  if (config.sources.imap.enabled && !config.sources.imap.user) {
    problems.push("`sources.imap.user` is required when IMAP is enabled");
  }
  for (const t of config.schedule.times) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) problems.push(`schedule time "${t}" is not HH:MM`);
  }
  return problems;
}

export function loadConfig(path = process.env.WORKLOG_CONFIG || defaultConfigPath()): Config {
  const file = expandHome(path);
  if (!existsSync(file)) {
    throw new Error(`No config at ${file}. Run \`${APP_NAME} init\` first.`);
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const config = resolvePaths(deepMerge(defaultConfig(), raw));
  loadEnvFile(config.envFile);
  return config;
}
