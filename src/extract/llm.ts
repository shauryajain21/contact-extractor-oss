import { redact } from "../redact.js";
import type { Config, LlmProvider, LlmProviderName, LlmRequest } from "../types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ProviderOptions {
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Retries after the first attempt, on 429, 5xx and network errors. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MODELS: Record<Exclude<LlmProviderName, "none">, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-sonnet-4-5",
  ollama: "llama3.1",
};

const DEFAULT_KEY_ENV = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" } as const;
const OPENAI_BASE = "https://api.openai.com/v1";
const OLLAMA_BASE = "http://localhost:11434/v1";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MAX_TOKENS = 8192;
const JSON_INSTRUCTION =
  "\n\nRespond with a single JSON object and nothing else: no prose, no markdown code fences.";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export function createLlmProvider(config: Config, opts: ProviderOptions = {}): LlmProvider | null {
  const { provider } = config.llm;
  if (provider === "none") return null;
  const env = opts.env ?? process.env;
  const model = config.llm.model || DEFAULT_MODELS[provider];

  if (provider === "ollama") {
    return openAiCompatible("ollama", trimSlash(config.llm.baseUrl ?? OLLAMA_BASE), model, undefined, opts);
  }

  const keyEnv = config.llm.apiKeyEnv || DEFAULT_KEY_ENV[provider];
  const key = env[keyEnv]?.trim() || undefined;

  if (provider === "openai") {
    // Self-hosted OpenAI-compatible endpoints often run without auth.
    if (!key && !config.llm.baseUrl) throw missingKey(provider, keyEnv);
    return openAiCompatible("openai", trimSlash(config.llm.baseUrl ?? OPENAI_BASE), model, key, opts);
  }

  if (provider === "anthropic") {
    if (!key) throw missingKey(provider, keyEnv);
    return anthropic(model, key, opts);
  }

  throw new LlmError(`Unknown llm.provider "${String(provider)}"`);
}

function missingKey(provider: string, keyEnv: string): LlmError {
  return new LlmError(`llm.provider "${provider}" needs an API key in the environment variable ${keyEnv}, which is not set`);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function openAiCompatible(
  name: "openai" | "ollama",
  baseUrl: string,
  model: string,
  key: string | undefined,
  opts: ProviderOptions
): LlmProvider {
  const official = baseUrl === OPENAI_BASE;
  return {
    name,
    async complete(req: LlmRequest): Promise<string> {
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      };
      if (req.json) body.response_format = { type: "json_object" };
      // api.openai.com rejects max_tokens on newer models; compatible servers mostly only know max_tokens.
      if (req.maxTokens) body[official ? "max_completion_tokens" : "max_tokens"] = req.maxTokens;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (key) headers.authorization = `Bearer ${key}`;

      const data = await postJson(name, `${baseUrl}/chat/completions`, headers, body, key, opts);
      const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
        ?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new LlmError(`${name} returned no message content (model ${model})`);
      }
      return content;
    },
  };
}

function anthropic(model: string, key: string, opts: ProviderOptions): LlmProvider {
  return {
    name: "anthropic",
    async complete(req: LlmRequest): Promise<string> {
      const body = {
        model,
        max_tokens: req.maxTokens ?? ANTHROPIC_MAX_TOKENS,
        system: req.json ? req.system + JSON_INSTRUCTION : req.system,
        messages: [{ role: "user", content: req.user }],
      };
      const headers = {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      };
      const data = await postJson("anthropic", ANTHROPIC_URL, headers, body, key, opts);
      const blocks = (data as { content?: Array<{ type?: string; text?: unknown }> })?.content ?? [];
      const text = blocks
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      if (!text.trim()) throw new LlmError(`anthropic returned no text content (model ${model})`);
      if (!req.json) return text;
      return extractJsonObject(text) ?? text;
    },
  };
}

async function postJson(
  name: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  key: string | undefined,
  opts: ProviderOptions
): Promise<unknown> {
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const scrub = (s: string) => {
    const r = redact(s);
    return key ? r.split(key).join("[redacted]") : r;
  };

  let lastError: LlmError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let retryAfterMs: number | undefined;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          throw new LlmError(`${name} returned a non-JSON response body: ${scrub(snippet(raw))}`);
        }
      }
      const retryable = res.status === 429 || res.status >= 500;
      lastError = new LlmError(
        `${name} request to ${url} failed with HTTP ${res.status}: ${scrub(snippet(errorText(raw)))}`,
        res.status,
        retryable
      );
      retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    } catch (err) {
      if (err instanceof LlmError) throw err;
      const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
      // A timed-out generation is usually too slow or too big; repeating it just multiplies the wait.
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new LlmError(`${name} request to ${url} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      const detail = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
      lastError = new LlmError(`${name} request to ${url} failed: ${scrub(String(detail))}`, undefined, true);
    }
    if (!lastError.retryable || attempt === retries) break;
    await sleep(retryAfterMs ?? backoff(attempt));
  }
  throw lastError ?? new LlmError(`${name} request failed`);
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.min(60_000, Math.max(0, secs * 1000));
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.min(60_000, Math.max(0, at - Date.now()));
}

function errorText(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof j.error === "string") return j.error;
    if (j.error && typeof j.error.message === "string") return j.error.message;
    if (typeof j.message === "string") return j.message;
  } catch {
    // not JSON; fall through to the raw body
  }
  return raw;
}

function snippet(s: string, max = 300): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
}

/** First balanced `{...}` in the text, skipping braces inside strings. */
export function extractJsonObject(text: string): string | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}
