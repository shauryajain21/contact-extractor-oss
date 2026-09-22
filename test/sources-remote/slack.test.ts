import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { defaultConfig } from "../../src/config.js";
import {
  SlackApiError,
  buildPermalink,
  createSlackClient,
  createSlackSource,
  isHumanMessage,
  renderSlackText,
  threadTsFromPermalink,
  type SlackClient,
  type SlackParams,
} from "../../src/sources/slack.js";
import type { Activity, CollectContext, Config, Logger } from "../../src/types.js";

const TOKEN_ENV = "WORKLOG_TEST_SLACK_TOKEN";
const WS = "https://acme-test.slack.com";

const TH1 = "1709420000.000100"; // thread parent, before the window
const T1 = "1709540000.000200";
const T2 = "1709541000.000300";
const BOT = "1709541500.000400";
const JOIN = "1709541600.000500";
const LATE = "1709600000.000600"; // after the window
const DM1 = "1709550000.000100";
const DM2 = "1709551000.000200";
const M3 = "1709560000.000100";

const channels: Record<string, Record<string, unknown>> = {
  C1: { id: "C1", name: "eng", is_ext_shared: false },
  C2: { id: "C2", name: "partners-acme", is_ext_shared: true },
  D1: { id: "D1", is_im: true, user: "UJANE" },
};

const users: Record<string, Record<string, unknown>> = {
  UME: { id: "UME", name: "alex", real_name: "Alex Rivera", profile: { email: "alex@mycorp.example" } },
  UJANE: { id: "UJANE", name: "jane", real_name: "Jane Doe", profile: { email: "jane@acme.example" } },
};

function fakeClient(calls: Array<[string, SlackParams]>, overrides: Record<string, () => unknown> = {}): SlackClient {
  const responses: Record<string, (p: SlackParams) => unknown> = {
    "auth.test": () => ({ ok: true, user_id: "UME", team: "Acme Test", url: `${WS}/` }),
    "search.messages": (p) =>
      String(p.query).startsWith("from:")
        ? {
            messages: {
              matches: [
                {
                  ts: T1,
                  user: "UME",
                  text: "I can take this",
                  channel: { id: "C1", name: "eng" },
                  permalink: `${WS}/archives/C1/p${T1.replace(".", "")}?thread_ts=${TH1}&cid=C1`,
                },
                { ts: DM1, user: "UME", text: "Did you see the proposal?", channel: { id: "D1", name: "UJANE", is_im: true } },
                { ts: M3, user: "UME", text: "Kicking off the pilot today", channel: { id: "C2", name: "partners-acme" } },
              ],
              paging: { pages: 1 },
            },
          }
        : {
            messages: {
              matches: [{ ts: T2, user: "UJANE", text: "thanks <@UME>", thread_ts: TH1, channel: { id: "C1", name: "eng" } }],
              paging: { pages: 1 },
            },
          },
    "conversations.replies": (p) =>
      p.channel === "C1"
        ? {
            messages: [
              { ts: TH1, thread_ts: TH1, reply_count: 5, user: "UJANE", text: "Who can review the *deploy* script?\nIt's urgent" },
              { ts: T1, thread_ts: TH1, user: "UME", text: "I can take this" },
              { ts: T2, thread_ts: TH1, user: "UJANE", text: "thanks <@UME>, loop in <@UBOB> &amp; see <https://example.com/pr/1|the PR>" },
              { ts: BOT, thread_ts: TH1, bot_id: "B1", subtype: "bot_message", text: "CI passed" },
              { ts: JOIN, thread_ts: TH1, user: "UBOB", subtype: "channel_join", text: "<@UBOB> has joined" },
              { ts: LATE, thread_ts: TH1, user: "UJANE", text: "tomorrow's message" },
            ],
          }
        : { messages: [{ ts: M3, user: "UME", text: "Kicking off the pilot today" }] },
    "conversations.history": () => ({
      messages: [
        { ts: DM2, user: "UJANE", text: "Yes, looks good. Can you send the contract?" },
        { ts: DM1, user: "UME", text: "Did you see the proposal?" },
      ],
    }),
    "conversations.info": (p) => ({ channel: channels[String(p.channel)] }),
    "users.info": (p) => {
      const u = users[String(p.user)];
      if (!u) throw new SlackApiError("users.info", "user_not_found");
      return { user: u };
    },
    "chat.getPermalink": (p) => ({ permalink: `${WS}/archives/${p.channel}/p${String(p.message_ts).replace(".", "")}` }),
  };
  return {
    async call<T>(method: string, params: SlackParams = {}): Promise<T> {
      calls.push([method, params]);
      const override = overrides[method];
      if (override) return override() as T;
      const r = responses[method];
      if (!r) throw new SlackApiError(method, "unknown_method");
      return r(params) as T;
    },
  };
}

function config(): Config {
  const c = defaultConfig();
  c.me = { name: "Alex Rivera", emails: ["alex@mycorp.example"], domains: ["mycorp.example"] };
  c.timezone = "UTC";
  c.sources.slack = { enabled: true, tokenEnv: TOKEN_ENV };
  return c;
}

function recordingLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (msg: string) => void lines.push(`${level} ${msg}`);
  return { lines, debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
}

function ctx(c: Config, log: Logger = recordingLog()): CollectContext {
  return { config: c, log, since: new Date("2024-03-04T00:00:00Z"), until: new Date("2024-03-05T00:00:00Z") };
}

describe("slack helpers", () => {
  it("renders mentions, channels, links and entities", () => {
    const names = new Map([["U1", "Jane Doe"]]);
    const out = renderSlackText("hi <@U1>, see <#C9|general> and <https://x.example|docs> &lt;3 <!here> <@U2|bob>", names);
    assert.equal(out, "hi @Jane Doe, see #general and docs (https://x.example) <3 @here @bob");
  });

  it("filters bots and join/leave subtypes", () => {
    assert.equal(isHumanMessage({ ts: "1", user: "U1", text: "hi" }), true);
    assert.equal(isHumanMessage({ ts: "1", user: "U1", text: "hi", subtype: "thread_broadcast" }), true);
    assert.equal(isHumanMessage({ ts: "1", bot_id: "B1", text: "hi" }), false);
    assert.equal(isHumanMessage({ ts: "1", user: "U1", text: "joined", subtype: "channel_join" }), false);
    assert.equal(isHumanMessage({ ts: "1", user: "U1", text: " " }), false);
  });

  it("builds and reads permalinks", () => {
    assert.equal(buildPermalink(`${WS}/`, "C1", "1709540000.000200"), `${WS}/archives/C1/p1709540000000200`);
    const reply = buildPermalink(WS, "C1", "1709540000.000200", "1709420000.000100");
    assert.equal(reply, `${WS}/archives/C1/p1709540000000200?thread_ts=1709420000.000100&cid=C1`);
    assert.equal(threadTsFromPermalink(reply), "1709420000.000100");
  });
});

describe("createSlackClient", () => {
  it("retries 429 using Retry-After and surfaces ok:false errors", async () => {
    const slept: number[] = [];
    let n = 0;
    const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
      n++;
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer xoxp-test");
      if (n === 1) return new Response("", { status: 429, headers: { "Retry-After": "2" } });
      if (String(url).endsWith("auth.test")) return Response.json({ ok: true, user_id: "UME" });
      return Response.json({ ok: false, error: "missing_scope" });
    }) as typeof fetch;
    const client = createSlackClient("xoxp-test", { fetch: fetchFake, sleep: async (ms) => void slept.push(ms) });
    assert.deepEqual(await client.call("auth.test"), { ok: true, user_id: "UME" });
    assert.deepEqual(slept, [2000]);
    await assert.rejects(client.call("search.messages", { query: "x" }), (e: unknown) => {
      return e instanceof SlackApiError && e.code === "missing_scope" && e.method === "search.messages";
    });
  });

  it("gives up after maxRetries", async () => {
    const fetchFake = (async () => new Response("", { status: 429 })) as typeof fetch;
    const client = createSlackClient("xoxp-test", { fetch: fetchFake, sleep: async () => {}, maxRetries: 2 });
    await assert.rejects(client.call("auth.test"), /ratelimited/);
  });
});

describe("slackSource", () => {
  beforeEach(() => {
    process.env[TOKEN_ENV] = "xoxp-test-token";
  });
  afterEach(() => {
    delete process.env[TOKEN_ENV];
  });

  it("requires config and token", () => {
    const src = createSlackSource(() => fakeClient([]));
    assert.equal(src.enabled(config()), true);
    delete process.env[TOKEN_ENV];
    assert.equal(src.enabled(config()), false);
  });

  it("groups threads, DMs and channel-days with resolved names", async () => {
    const calls: Array<[string, SlackParams]> = [];
    const acts = await createSlackSource(() => fakeClient(calls)).collect(ctx(config()));
    const byThread = new Map<string, Activity>(acts.map((a) => [a.threadId!, a]));
    assert.equal(acts.length, 3);

    const searches = calls.filter(([m]) => m === "search.messages").map(([, p]) => p.query);
    assert.deepEqual(searches, ["from:<@UME> after:2024-03-03", "<@UME> after:2024-03-03"]);

    const thread = byThread.get(`slack:C1:${TH1}`);
    assert.ok(thread);
    assert.equal(thread.id, `slack:C1:${TH1}:${T2}`);
    assert.equal(thread.kind, "message");
    assert.equal(thread.title, "#eng: I can take this");
    assert.equal(
      thread.text,
      [
        "(earlier) Jane Doe: Who can review the *deploy* script?\nIt's urgent",
        "Alex Rivera: I can take this",
        "Jane Doe: thanks @Alex Rivera, loop in @UBOB & see the PR (https://example.com/pr/1)",
      ].join("\n"),
    );
    assert.equal(thread.fromMe, false);
    assert.equal(thread.project, undefined);
    assert.deepEqual(thread.meta, {
      workspace: "Acme Test",
      channelId: "C1",
      channelName: "eng",
      isDm: false,
      isExternal: false,
      lastSpeakerIsMe: false,
      grouping: "thread",
    });
    assert.deepEqual(thread.participants, [
      { handle: "UJANE", name: "Jane Doe", email: "jane@acme.example", role: "from" },
      { handle: "UME", name: "Alex Rivera", email: "alex@mycorp.example", role: "from" },
      { handle: "UBOB", role: "mention" },
    ]);
    assert.equal(thread.url, `${WS}/archives/C1/p${T2.replace(".", "")}`);

    const dm = byThread.get("slack:D1");
    assert.ok(dm);
    assert.equal(dm.title, "@Jane Doe: Did you see the proposal?");
    assert.equal(dm.text, "Alex Rivera: Did you see the proposal?\nJane Doe: Yes, looks good. Can you send the contract?");
    assert.equal(dm.fromMe, false);
    assert.equal(dm.meta?.isDm, true);
    assert.equal(dm.meta?.grouping, "day");
    assert.equal(dm.id, `slack:D1:2024-03-04:${DM2}`);

    const ext = byThread.get("slack:C2:2024-03-04");
    assert.ok(ext);
    assert.equal(ext.fromMe, true);
    assert.equal(ext.meta?.isExternal, true);
    assert.equal(ext.meta?.lastSpeakerIsMe, true);

    assert.equal(calls.filter(([m, p]) => m === "users.info" && p.user === "UJANE").length, 1, "users.info is cached");
    assert.ok(calls.some(([m, p]) => m === "conversations.history" && p.channel === "D1"));
  });

  it("builds permalinks from workspaceUrl without calling chat.getPermalink", async () => {
    const calls: Array<[string, SlackParams]> = [];
    const c = config();
    c.sources.slack.workspaceUrl = WS;
    c.me.slackUserId = "UME";
    const acts = await createSlackSource(() => fakeClient(calls)).collect(ctx(c));
    assert.ok(!calls.some(([m]) => m === "chat.getPermalink"));
    const thread = acts.find((a) => a.threadId === `slack:C1:${TH1}`);
    assert.equal(thread?.url, `${WS}/archives/C1/p${T2.replace(".", "")}?thread_ts=${TH1}&cid=C1`);
  });

  it("reads configured channels via conversations.history", async () => {
    const calls: Array<[string, SlackParams]> = [];
    const c = config();
    c.sources.slack.channels = ["C2"];
    await createSlackSource(() => fakeClient(calls)).collect(ctx(c));
    const hist = calls.find(([m, p]) => m === "conversations.history" && p.channel === "C2");
    assert.ok(hist);
    assert.equal(hist[1].oldest, "1709510400.000000");
    assert.equal(hist[1].latest, "1709596800.000000");
  });

  it("returns [] with an error when auth fails", async () => {
    const log = recordingLog();
    const client = fakeClient([], {
      "auth.test": () => {
        throw new SlackApiError("auth.test", "invalid_auth");
      },
    });
    assert.deepEqual(await createSlackSource(() => client).collect(ctx(config(), log)), []);
    assert.ok(log.lines.some((l) => l.startsWith("error slack: authentication failed")));
  });

  it("keeps going when search and threads fail", async () => {
    const log = recordingLog();
    const client = fakeClient([], {
      "search.messages": () => {
        throw new SlackApiError("search.messages", "missing_scope");
      },
    });
    const c = config();
    c.sources.slack.channels = ["D1"];
    const acts = await createSlackSource(() => client).collect(ctx(c, log));
    assert.equal(acts.length, 1);
    assert.ok(log.lines.some((l) => l.startsWith("error slack: search failed")));
  });
});
