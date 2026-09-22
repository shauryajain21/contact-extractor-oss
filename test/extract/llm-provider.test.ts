import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type FetchLike, createLlmProvider, extractJsonObject } from "../../src/extract/llm.js";
import type { LlmConfig } from "../../src/types.js";
import { testConfig } from "./helpers.js";

const KEY = "sk-test-SECRET-0123456789abcdefghij";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(responses: Array<Response | Error | (() => Response)>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r() : r.clone();
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const openAiOk = (content: string) => json({ choices: [{ message: { content } }] });

function provider(llm: LlmConfig, f: FetchLike, sleeps: number[] = []) {
  return createLlmProvider(testConfig({ llm }), {
    fetch: f,
    env: { OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: KEY, MY_KEY: KEY },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

describe("createLlmProvider", () => {
  it("returns null for provider none", () => {
    assert.equal(createLlmProvider(testConfig({ llm: { provider: "none" } })), null);
  });

  it("fails clearly when the key is missing, naming the variable only", () => {
    assert.throws(
      () => createLlmProvider(testConfig({ llm: { provider: "anthropic", apiKeyEnv: "MY_KEY" } }), { env: {} }),
      /environment variable MY_KEY/
    );
  });

  it("openai: posts chat completions with json mode and the default model", async () => {
    const { fetch, calls } = fakeFetch([openAiOk('{"ok":true}')]);
    const p = provider({ provider: "openai", apiKeyEnv: "OPENAI_API_KEY" }, fetch)!;
    const out = await p.complete({ system: "sys", user: "usr", json: true, maxTokens: 100 });
    assert.equal(out, '{"ok":true}');
    assert.equal(calls[0]!.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.equal(calls[0]!.body.model, "gpt-4.1-mini");
    assert.deepEqual(calls[0]!.body.response_format, { type: "json_object" });
    assert.equal(calls[0]!.body.max_completion_tokens, 100);
    assert.deepEqual(calls[0]!.body.messages, [
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
  });

  it("openai-compatible: honours baseUrl and model", async () => {
    const { fetch, calls } = fakeFetch([openAiOk("hi")]);
    const p = provider({ provider: "openai", baseUrl: "https://llm.internal/v1/", model: "qwen3", apiKeyEnv: "MY_KEY" }, fetch)!;
    await p.complete({ system: "s", user: "u", maxTokens: 50 });
    assert.equal(calls[0]!.url, "https://llm.internal/v1/chat/completions");
    assert.equal(calls[0]!.body.model, "qwen3");
    assert.equal(calls[0]!.body.max_tokens, 50);
    assert.equal(calls[0]!.body.response_format, undefined);
  });

  it("ollama: local OpenAI-compatible endpoint without a key", async () => {
    const { fetch, calls } = fakeFetch([openAiOk("{}")]);
    const p = provider({ provider: "ollama" }, fetch)!;
    assert.equal(p.name, "ollama");
    await p.complete({ system: "s", user: "u", json: true });
    assert.equal(calls[0]!.url, "http://localhost:11434/v1/chat/completions");
    assert.equal(calls[0]!.body.model, "llama3.1");
    assert.equal(calls[0]!.headers.authorization, undefined);
  });

  it("anthropic: messages API headers, json instruction and first-object extraction", async () => {
    const { fetch, calls } = fakeFetch([
      json({ content: [{ type: "text", text: 'Here you go:\n{"a":{"b":"}"}}\nThanks' }] }),
    ]);
    const p = provider({ provider: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" }, fetch)!;
    const out = await p.complete({ system: "sys", user: "usr", json: true });
    assert.equal(out, '{"a":{"b":"}"}}');
    assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages");
    assert.equal(calls[0]!.headers["x-api-key"], KEY);
    assert.equal(calls[0]!.headers["anthropic-version"], "2023-06-01");
    assert.equal(calls[0]!.body.model, "claude-sonnet-4-5");
    assert.equal(typeof calls[0]!.body.max_tokens, "number");
    assert.match(String(calls[0]!.body.system), /^sys\n\n.*single JSON object/s);
  });

  it("retries 429 and 5xx with backoff, honouring Retry-After", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = fakeFetch([
      json({ error: { message: "slow down" } }, 429, { "retry-after": "2" }),
      json({ error: { message: "overloaded" } }, 503),
      openAiOk("done"),
    ]);
    const p = provider({ provider: "openai" }, fetch, sleeps)!;
    assert.equal(await p.complete({ system: "s", user: "u" }), "done");
    assert.equal(calls.length, 3);
    assert.equal(sleeps[0], 2000);
    assert.ok(sleeps[1]! >= 2000 && sleeps[1]! < 2500);
  });

  it("retries network errors and gives up after 3 retries with a key-free message", async () => {
    const sleeps: number[] = [];
    const err = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    const { fetch, calls } = fakeFetch([err]);
    const p = provider({ provider: "openai" }, fetch, sleeps)!;
    await assert.rejects(p.complete({ system: "s", user: "u" }), /openai request to .* failed: ECONNRESET/);
    assert.equal(calls.length, 4);
    assert.equal(sleeps.length, 3);
  });

  it("does not retry 4xx and never leaks the key in errors", async () => {
    const { fetch, calls } = fakeFetch([json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401)]);
    const p = provider({ provider: "openai" }, fetch)!;
    await assert.rejects(p.complete({ system: "s", user: "u" }), (e: Error) => {
      assert.match(e.message, /HTTP 401/);
      assert.ok(!e.message.includes(KEY), e.message);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("does not retry timeouts", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const { fetch, calls } = fakeFetch([timeout]);
    const p = createLlmProvider(testConfig({ llm: { provider: "ollama" } }), { fetch, timeoutMs: 5000 })!;
    await assert.rejects(p.complete({ system: "s", user: "u" }), /timed out after 5s/);
    assert.equal(calls.length, 1);
  });
});

describe("extractJsonObject", () => {
  it("finds the first balanced object and ignores braces in strings", () => {
    assert.equal(extractJsonObject('pre {"x":"{not}","y":[1,{"z":2}]} post {"later":1}'), '{"x":"{not}","y":[1,{"z":2}]}');
    assert.equal(extractJsonObject("{broken {\"ok\":1}"), '{"ok":1}');
    assert.equal(extractJsonObject("no json here"), null);
  });
});
