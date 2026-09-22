import { clean } from "../redact.js";
import type { Activity, CollectContext, Logger, Participant, Source } from "../types.js";
import { fitNewest } from "./email-util.js";

export type SlackParams = Record<string, string | number | boolean | undefined>;

export interface SlackClient {
  call<T = Record<string, unknown>>(method: string, params?: SlackParams): Promise<T>;
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`slack ${method}: ${code}`);
  }
}

export interface SlackClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseUrl?: string;
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createSlackClient(token: string, opts: SlackClientOptions = {}): SlackClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? sleepMs;
  const maxRetries = opts.maxRetries ?? 5;
  const base = opts.baseUrl ?? "https://slack.com/api";
  return {
    async call<T>(method: string, params: SlackParams = {}): Promise<T> {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
      for (let attempt = 0; ; attempt++) {
        const res = await doFetch(`${base}/${method}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        if (res.status === 429) {
          if (attempt >= maxRetries) throw new SlackApiError(method, "ratelimited");
          const retryAfter = Number(res.headers.get("retry-after"));
          await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1, 60) * 1000);
          continue;
        }
        if (!res.ok) throw new SlackApiError(method, `http_${res.status}`);
        const json = (await res.json()) as { ok?: boolean; error?: string };
        if (!json.ok) throw new SlackApiError(method, json.error ?? "unknown_error");
        return json as T;
      }
    },
  };
}

interface SlackFile {
  name?: string;
  title?: string;
}

export interface SlackMessage {
  ts: string;
  user?: string;
  username?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
  thread_ts?: string;
  reply_count?: number;
  files?: SlackFile[];
}

interface SlackChannel {
  id: string;
  name?: string;
  user?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_ext_shared?: boolean;
}

interface SearchMatch extends SlackMessage {
  channel?: SlackChannel;
  permalink?: string;
}

interface SearchResponse {
  messages?: { matches?: SearchMatch[]; paging?: { pages?: number } };
}

interface ListResponse {
  messages?: SlackMessage[];
  response_metadata?: { next_cursor?: string };
}

interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  profile?: { real_name?: string; display_name?: string; email?: string };
}

interface UserInfo {
  name?: string;
  email?: string;
}

export type SlackClientFactory = (token: string) => SlackClient;

const ALLOWED_SUBTYPES = new Set(["thread_broadcast", "file_share", "me_message"]);
const MAX_SEARCH_PAGES = 10;
const MAX_LIST_PAGES = 10;
const MAX_THREADS = 200;

export function tsToDate(ts: string): Date {
  return new Date(Math.round(Number(ts) * 1000));
}

export function isHumanMessage(m: SlackMessage): boolean {
  if (m.bot_id || !m.user) return false;
  if (m.subtype && !ALLOWED_SUBTYPES.has(m.subtype)) return false;
  return !!m.text?.trim() || !!m.files?.length;
}

export function threadTsFromPermalink(permalink: string | undefined): string | undefined {
  if (!permalink) return undefined;
  try {
    return new URL(permalink).searchParams.get("thread_ts") ?? undefined;
  } catch {
    return undefined;
  }
}

export function buildPermalink(workspaceUrl: string, channel: string, ts: string, threadTs?: string): string {
  const base = workspaceUrl.replace(/\/+$/, "");
  const url = `${base}/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${url}?thread_ts=${threadTs}&cid=${channel}` : url;
}

export function dayKey(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function mentionedUserIds(text: string | undefined): string[] {
  return [...(text ?? "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!);
}

/** Turn Slack mrkdwn escapes into plain text, with user mentions resolved to names. */
export function renderSlackText(text: string, names: Map<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `@${names.get(id) ?? label ?? id}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, label?: string) => label ?? "@team")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function createSlackSource(factory: SlackClientFactory = (t) => createSlackClient(t)): Source {
  return {
    name: "slack",
    enabled(config) {
      return config.sources.slack.enabled && !!process.env[config.sources.slack.tokenEnv];
    },
    async collect(ctx) {
      const token = process.env[ctx.config.sources.slack.tokenEnv];
      if (!token) {
        ctx.log.error(`slack: ${ctx.config.sources.slack.tokenEnv} is not set`);
        return [];
      }
      return new SlackCollector(factory(token), ctx).run();
    },
  };
}

class SlackCollector {
  private readonly log: Logger;
  private readonly sinceMs: number;
  private readonly untilMs: number;
  private readonly store = new Map<string, Map<string, SlackMessage>>();
  private readonly searchChannels = new Map<string, SlackChannel>();
  private readonly channelCache = new Map<string, SlackChannel>();
  private readonly permalinks = new Map<string, string>();
  private readonly userCache = new Map<string, Promise<UserInfo>>();
  private me = "";
  private team?: string;
  private authUrl?: string;

  constructor(
    private readonly api: SlackClient,
    private readonly ctx: CollectContext,
  ) {
    this.log = ctx.log;
    this.sinceMs = ctx.since.getTime();
    this.untilMs = ctx.until.getTime();
  }

  private inWindow(ts: string): boolean {
    const t = Number(ts) * 1000;
    return t >= this.sinceMs && t < this.untilMs;
  }

  private put(channel: string, msg: SlackMessage): void {
    const byTs = this.store.get(channel) ?? new Map<string, SlackMessage>();
    const prev = byTs.get(msg.ts);
    byTs.set(msg.ts, prev ? { ...prev, ...msg, thread_ts: msg.thread_ts ?? prev.thread_ts } : msg);
    this.store.set(channel, byTs);
  }

  async run(): Promise<Activity[]> {
    const { config } = this.ctx;
    try {
      const auth = await this.api.call<{ user_id?: string; team?: string; url?: string }>("auth.test");
      this.me = config.me.slackUserId || auth.user_id || "";
      this.team = auth.team;
      this.authUrl = auth.url;
    } catch (err) {
      this.log.error("slack: authentication failed, check the user token", { error: String(err) });
      return [];
    }
    if (!this.me) {
      this.log.error("slack: could not determine your Slack user id");
      return [];
    }

    const threadRoots = new Set<string>();
    const historyChannels = new Set(config.sources.slack.channels ?? []);
    const after = dayKey(new Date(this.sinceMs - 86_400_000), config.timezone);

    for (const query of [`from:<@${this.me}> after:${after}`, `<@${this.me}> after:${after}`]) {
      for (const match of await this.search(query)) {
        const ch = match.channel?.id;
        if (!ch || !this.inWindow(match.ts)) continue;
        if (!this.searchChannels.has(ch)) this.searchChannels.set(ch, match.channel!);
        const threadTs = match.thread_ts ?? threadTsFromPermalink(match.permalink);
        const { channel: _c, permalink, ...msg } = match;
        this.put(ch, { ...msg, thread_ts: threadTs });
        if (permalink) this.permalinks.set(`${ch} ${match.ts}`, permalink);
        if (threadTs) threadRoots.add(`${ch} ${threadTs}`);
        else if (match.channel?.is_im || match.channel?.is_mpim) historyChannels.add(ch);
        // A top-level message may still have a thread under it; replies tells us.
        else threadRoots.add(`${ch} ${match.ts}`);
      }
    }

    for (const ch of historyChannels) {
      for (const msg of await this.history(ch)) {
        this.put(ch, msg);
        if ((msg.reply_count ?? 0) > 0) threadRoots.add(`${ch} ${msg.thread_ts ?? msg.ts}`);
      }
    }

    let fetched = 0;
    for (const key of threadRoots) {
      if (fetched++ >= MAX_THREADS) {
        this.log.warn(`slack: more than ${MAX_THREADS} threads, skipping the rest`);
        break;
      }
      const [ch, ts] = key.split(" ") as [string, string];
      const replies = await this.replies(ch, ts);
      const threaded = replies.length > 1 || (replies[0]?.reply_count ?? 0) > 0;
      for (const msg of replies) {
        if (msg.ts !== ts && !this.inWindow(msg.ts)) continue;
        this.put(ch, threaded ? { ...msg, thread_ts: msg.thread_ts ?? ts } : msg);
      }
    }

    const out: Activity[] = [];
    for (const [ch, byTs] of this.store) {
      try {
        out.push(...(await this.groupChannel(ch, [...byTs.values()])));
      } catch (err) {
        this.log.warn(`slack: skipping channel ${ch}`, { error: String(err) });
      }
    }
    this.log.info(`slack: ${out.length} conversations`);
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  private async search(query: string): Promise<SearchMatch[]> {
    const out: SearchMatch[] = [];
    for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
      let res: SearchResponse;
      try {
        res = await this.api.call<SearchResponse>("search.messages", {
          query,
          count: 100,
          page,
          sort: "timestamp",
          sort_dir: "desc",
        });
      } catch (err) {
        this.log.error("slack: search failed", { query, error: String(err) });
        break;
      }
      const matches = res.messages?.matches ?? [];
      out.push(...matches);
      const oldest = matches[matches.length - 1];
      if (!oldest || Number(oldest.ts) * 1000 < this.sinceMs) break;
      if (page >= (res.messages?.paging?.pages ?? 1)) break;
    }
    return out;
  }

  private async paginate(method: string, params: SlackParams): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await this.api.call<ListResponse>(method, { ...params, limit: 200, cursor });
      out.push(...(res.messages ?? []));
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return out;
  }

  private async history(channel: string): Promise<SlackMessage[]> {
    try {
      return await this.paginate("conversations.history", {
        channel,
        oldest: (this.sinceMs / 1000).toFixed(6),
        latest: (this.untilMs / 1000).toFixed(6),
        inclusive: true,
      });
    } catch (err) {
      this.log.warn(`slack: could not read history of ${channel}`, { error: String(err) });
      return [];
    }
  }

  private async replies(channel: string, ts: string): Promise<SlackMessage[]> {
    try {
      return await this.paginate("conversations.replies", { channel, ts });
    } catch (err) {
      this.log.warn(`slack: could not read thread ${channel}/${ts}`, { error: String(err) });
      return [];
    }
  }

  private async channelInfo(id: string): Promise<SlackChannel> {
    const cached = this.channelCache.get(id);
    if (cached) return cached;
    let info: SlackChannel = { ...this.searchChannels.get(id), id };
    try {
      const res = await this.api.call<{ channel?: SlackChannel }>("conversations.info", { channel: id });
      if (res.channel) info = { ...info, ...res.channel };
    } catch (err) {
      this.log.debug(`slack: conversations.info failed for ${id}`, { error: String(err) });
    }
    this.channelCache.set(id, info);
    return info;
  }

  private user(id: string): Promise<UserInfo> {
    let p = this.userCache.get(id);
    if (!p) {
      p = this.api
        .call<{ user?: SlackUser }>("users.info", { user: id })
        .then(({ user }) => ({
          name: user?.real_name || user?.profile?.real_name || user?.profile?.display_name || user?.name || undefined,
          email: user?.profile?.email || undefined,
        }))
        .catch((err: unknown) => {
          this.log.debug(`slack: users.info failed for ${id}`, { error: String(err) });
          return {};
        });
      this.userCache.set(id, p);
    }
    return p;
  }

  private async permalink(channel: string, ts: string, threadTs?: string): Promise<string | undefined> {
    const ws = this.ctx.config.sources.slack.workspaceUrl;
    if (ws) return buildPermalink(ws, channel, ts, threadTs);
    const known = this.permalinks.get(`${channel} ${ts}`);
    if (known) return known;
    try {
      const res = await this.api.call<{ permalink?: string }>("chat.getPermalink", { channel, message_ts: ts });
      if (res.permalink) return res.permalink;
    } catch (err) {
      this.log.debug("slack: chat.getPermalink failed", { channel, ts, error: String(err) });
    }
    return this.authUrl ? buildPermalink(this.authUrl, channel, ts, threadTs) : undefined;
  }

  private async groupChannel(ch: string, all: SlackMessage[]): Promise<Activity[]> {
    const msgs = all.filter(isHumanMessage).sort((a, b) => Number(a.ts) - Number(b.ts));
    if (!msgs.some((m) => this.inWindow(m.ts))) return [];
    const info = await this.channelInfo(ch);
    const isDm = !!(info.is_im || info.is_mpim);
    const withReplies = new Set(msgs.filter((m) => m.thread_ts && m.thread_ts !== m.ts).map((m) => m.thread_ts!));

    const threads = new Map<string, SlackMessage[]>();
    const days = new Map<string, SlackMessage[]>();
    for (const m of msgs) {
      const t = m.thread_ts;
      if (t && (t !== m.ts || withReplies.has(t) || (m.reply_count ?? 0) > 0)) {
        threads.set(t, [...(threads.get(t) ?? []), m]);
      } else if (this.inWindow(m.ts)) {
        const day = dayKey(tsToDate(m.ts), this.ctx.config.timezone);
        days.set(day, [...(days.get(day) ?? []), m]);
      }
    }

    const out: Activity[] = [];
    for (const [threadTs, group] of threads) {
      const inWin = group.filter((m) => this.inWindow(m.ts));
      if (!inWin.length) continue;
      const root = group.find((m) => m.ts === threadTs && !this.inWindow(m.ts));
      out.push(
        await this.buildActivity(ch, info, isDm, root ? [root, ...inWin] : inWin, {
          threadId: `slack:${ch}:${threadTs}`,
          idPrefix: `slack:${ch}:${threadTs}`,
          threadTs,
          grouping: "thread",
        }),
      );
    }
    for (const [day, group] of days) {
      out.push(
        await this.buildActivity(ch, info, isDm, group, {
          threadId: isDm ? `slack:${ch}` : `slack:${ch}:${day}`,
          idPrefix: `slack:${ch}:${day}`,
          grouping: "day",
        }),
      );
    }
    return out;
  }

  private async buildActivity(
    ch: string,
    info: SlackChannel,
    isDm: boolean,
    msgs: SlackMessage[],
    g: { threadId: string; idPrefix: string; threadTs?: string; grouping: "thread" | "day" },
  ): Promise<Activity> {
    const { config } = this.ctx;
    const authorIds = [...new Set(msgs.map((m) => m.user!))];
    const mentionIds = [...new Set(msgs.flatMap((m) => mentionedUserIds(m.text)))];
    const ids = [...new Set([...authorIds, ...mentionIds, ...(info.is_im && info.user ? [info.user] : [])])];
    const users = new Map<string, UserInfo>();
    for (const id of ids) users.set(id, await this.user(id));
    const names = new Map<string, string>();
    for (const [id, u] of users) if (u.name) names.set(id, u.name);
    for (const m of msgs) if (m.user && m.username && !names.has(m.user)) names.set(m.user, m.username);

    const render = (m: SlackMessage) => {
      const files = (m.files ?? []).map((f) => `[file: ${f.title ?? f.name ?? "attachment"}]`);
      return [renderSlackText(m.text ?? "", names).trim(), ...files].filter(Boolean).join(" ");
    };
    const lines = msgs.map((m) => {
      const prefix = this.inWindow(m.ts) ? "" : "(earlier) ";
      return `${prefix}${names.get(m.user!) ?? m.user}: ${clean(render(m), config.limits.maxActivityChars)}`;
    });

    const label = (id: string) => `@${names.get(id) ?? id}`;
    const channelName = info.is_im
      ? label(info.user ?? info.name ?? ch)
      : info.is_mpim
        ? authorIds.filter((id) => id !== this.me).map(label).join(", ") || `#${info.name ?? ch}`
        : info.name
          ? `#${info.name}`
          : ch;
    const first = msgs.find((m) => this.inWindow(m.ts)) ?? msgs[0]!;
    const firstLine = render(first).split("\n")[0]!.slice(0, 120);

    const participants: Participant[] = [];
    for (const id of authorIds) participants.push({ handle: id, ...users.get(id), role: "from" });
    for (const id of mentionIds) {
      if (!authorIds.includes(id)) participants.push({ handle: id, ...users.get(id), role: "mention" });
    }
    if (info.is_im && info.user && !authorIds.includes(info.user) && !mentionIds.includes(info.user)) {
      participants.push({ handle: info.user, ...users.get(info.user), role: "to" });
    }

    const last = msgs[msgs.length - 1]!;
    const lastSpeakerIsMe = last.user === this.me;
    return {
      id: `${g.idPrefix}:${last.ts}`,
      source: "slack",
      kind: "message",
      at: tsToDate(last.ts).toISOString(),
      title: clean(`${channelName}: ${firstLine}`, 200),
      text: clean(fitNewest(lines, config.limits.maxActivityChars, "\n"), config.limits.maxActivityChars),
      url: await this.permalink(ch, last.ts, g.threadTs),
      threadId: g.threadId,
      participants,
      fromMe: lastSpeakerIsMe,
      meta: {
        ...(this.team ? { workspace: this.team } : {}),
        channelId: ch,
        channelName: isDm ? channelName : info.name,
        isDm,
        isExternal: !!info.is_ext_shared,
        lastSpeakerIsMe,
        grouping: g.grouping,
      },
    };
  }
}

export const slackSource: Source = createSlackSource();
