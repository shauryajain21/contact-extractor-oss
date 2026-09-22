/**
 * Shared contracts. Sources produce Activity, the extractor turns a window of
 * activity into a Digest, and the vault writer renders the Digest into notes.
 */

export type SourceName = "cursor" | "claude-code" | "git" | "slack" | "imap" | "calendar";

export type ActivityKind = "chat" | "message" | "email" | "commit" | "event";

export type ParticipantRole = "from" | "to" | "cc" | "attendee" | "mention";

export interface Participant {
  name?: string;
  email?: string;
  /** Slack user id, git author handle, or similar. */
  handle?: string;
  role: ParticipantRole;
}

export interface Activity {
  /** Stable across runs, prefixed by source, e.g. `git:<repo>:<sha>`. */
  id: string;
  source: SourceName;
  kind: ActivityKind;
  /** ISO 8601. */
  at: string;
  /** Chat title, email subject, commit subject, event title. */
  title?: string;
  /** Body after redaction, capped at `limits.maxActivityChars`. */
  text: string;
  /** Link back to the original, when the source has one. */
  url?: string;
  /** Repo or workspace name, when known. */
  project?: string;
  /** Groups messages into a conversation: email thread, Slack thread, chat id. */
  threadId?: string;
  participants: Participant[];
  /** True when the configured user wrote it. */
  fromMe: boolean;
  meta?: ActivityMeta;
}

/**
 * Keys shared between sources and the classifier. Sources may add their own;
 * these are the ones something downstream reads.
 */
export interface ActivityMeta {
  /** Email: a List-Unsubscribe header was present. */
  listUnsubscribe?: boolean;
  /** Email: Precedence bulk/list/junk. */
  precedenceBulk?: boolean;
  /** Email: an outside sender is a no-reply / notifications address. */
  noReply?: boolean;
  /** Email: attachment filenames. */
  attachments?: string[];
  /** Detected language code, when it isn't English. */
  language?: string;
  /** Slack: a direct message conversation. */
  isDm?: boolean;
  /** Slack: a conversation shared with another organisation. */
  isExternal?: boolean;
  /** Slack workspace name. Kept out of `project`, which always means a real project. */
  workspace?: string;
  /** Email and Slack: the configured user spoke last. */
  lastSpeakerIsMe?: boolean;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export interface CollectContext {
  since: Date;
  until: Date;
  config: Config;
  log: Logger;
}

export interface Source {
  name: SourceName;
  enabled(config: Config): boolean;
  collect(ctx: CollectContext): Promise<Activity[]>;
}

/** How a conversation is classified. Drives filtering and which folder a note lands in. */
export type Category =
  | "customer"
  | "prospect"
  | "partnership"
  | "vendor"
  | "hiring"
  | "internal"
  | "personal"
  | "newsletter"
  | "spam"
  | "other";

/** Pointer back to the activity an item came from. */
export interface Ref {
  activityId: string;
  source: SourceName;
  url?: string;
}

export interface Contact {
  name: string;
  email?: string;
  company?: string;
  domain?: string;
  role?: string;
  category: Category;
  /** One line: who they are and what the latest exchange was about. */
  summary: string;
  lastSeen: string;
  refs: Ref[];
}

export interface Company {
  name: string;
  domain?: string;
  category: Category;
  summary: string;
  /** Contact names, matching `Contact.name`. */
  contacts: string[];
  refs: Ref[];
}

export type ProjectStatus = "active" | "blocked" | "shipped" | "paused";

export interface ProjectUpdate {
  name: string;
  status: ProjectStatus;
  summary: string;
  /** One line each. */
  progress: string[];
  refs: Ref[];
}

export type WaitingOn = "me" | "them" | "nobody";

/** A conversation with someone outside, and who owes the next move. */
export interface ThreadState {
  /** `Activity.threadId` when there is one, otherwise the first activity id. */
  id: string;
  title: string;
  counterpart: string;
  company?: string;
  category: Category;
  waitingOn: WaitingOn;
  /** ISO, when the current waiting state began. */
  since: string;
  lastActivityAt: string;
  url?: string;
  refs?: Ref[];
}

export interface Digest {
  window: { since: string; until: string };
  projects: ProjectUpdate[];
  contacts: Contact[];
  companies: Company[];
  threads: ThreadState[];
  /** Daily log sections, one line per item. */
  progress: string[];
  actions: string[];
  openQuestions: string[];
  noticed: string[];
}

export interface ExtractContext {
  config: Config;
  log: Logger;
  window: { since: Date; until: Date };
  /** Previously known threads, so waiting state carries across runs. */
  knownThreads: Record<string, ThreadState>;
}

export interface Extractor {
  extract(activities: Activity[], ctx: ExtractContext): Promise<Digest>;
}

export interface LlmRequest {
  system: string;
  user: string;
  /** Ask the provider for a JSON object response. */
  json?: boolean;
  maxTokens?: number;
}

export interface LlmProvider {
  name: string;
  complete(req: LlmRequest): Promise<string>;
}

export interface WriteReport {
  created: string[];
  updated: string[];
  unchanged: string[];
}

// ---------- config ----------

export interface MeConfig {
  name: string;
  emails: string[];
  /** Work domains. Senders on these are teammates, not contacts. */
  domains: string[];
  slackUserId?: string;
  gitAuthors?: string[];
}

export type LlmProviderName = "openai" | "anthropic" | "ollama" | "none";

export interface LlmConfig {
  provider: LlmProviderName;
  model?: string;
  /** Any OpenAI-compatible endpoint works with provider `openai`. */
  baseUrl?: string;
  /** Name of the env var holding the key, never the key itself. */
  apiKeyEnv?: string;
}

export interface SourcesConfig {
  /**
   * `ignorePatterns` are case-insensitive regexes tested against a chat's first
   * prompt. Chats opening with the same long prompt as another are skipped as
   * scheduled jobs regardless.
   */
  cursor: { enabled: boolean; path: string; ignorePatterns?: string[] };
  claudeCode: { enabled: boolean; path: string; ignorePatterns?: string[] };
  git: { enabled: boolean; roots: string[]; maxDepth: number };
  slack: { enabled: boolean; tokenEnv: string; channels?: string[]; workspaceUrl?: string };
  imap: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    passwordEnv: string;
    mailboxes: string[];
  };
  calendar: { enabled: boolean; icsUrls: string[] };
}

export interface VaultLayout {
  log: string;
  people: string;
  companies: string;
  projects: string;
  dashboard: string;
}

export interface Config {
  vault: string;
  layout: VaultLayout;
  me: MeConfig;
  /** IANA zone used for daily note dates. */
  timezone: string;
  llm: LlmConfig;
  sources: SourcesConfig;
  filters: {
    /** Conversations in these categories are dropped before writing. */
    dropCategories: Category[];
    /** Sender domains always ignored, e.g. no-reply senders. */
    ignoreDomains: string[];
  };
  limits: {
    maxActivityChars: number;
    /** Activity is split into LLM batches of roughly this many characters. */
    batchChars: number;
  };
  /** Times fire in the machine's local zone, which may differ from `timezone`. */
  schedule: { times: string[] };
  stateDir: string;
  /**
   * KEY=value file loaded at startup for variables not already set. Scheduled
   * jobs don't inherit a shell profile, so this is where keys and tokens go.
   */
  envFile: string;
}
