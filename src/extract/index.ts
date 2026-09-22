import type { Config, Extractor, Logger } from "../types.js";
import { LlmExtractor } from "./extract.js";
import { HeuristicExtractor } from "./heuristic.js";
import { createLlmProvider } from "./llm.js";

export { createLlmProvider, extractJsonObject, LlmError, DEFAULT_MODELS } from "./llm.js";
export type { FetchLike, ProviderOptions } from "./llm.js";
export {
  classifyActivity,
  companyFromEmail,
  emailDomain,
  FREEMAIL_DOMAINS,
  isFreemail,
  isJobInquiry,
  isNewsletter,
  isSolicitation,
} from "./classify.js";
export { HeuristicExtractor } from "./heuristic.js";
export { LlmExtractor } from "./extract.js";
export type { LlmExtractorOptions } from "./extract.js";
export { buildSystemPrompt, buildUserPrompt, serializeActivity, splitIntoBatches } from "./prompts.js";

/** LLM-backed when a provider is configured, otherwise rule-based. Throws if the configured API key is missing. */
export function createExtractor(config: Config, log: Logger): Extractor {
  const provider = createLlmProvider(config);
  if (!provider) {
    log.debug("extract: no LLM configured, using heuristic extraction");
    return new HeuristicExtractor();
  }
  log.debug(`extract: using ${provider.name} (${config.llm.model ?? "default model"})`);
  return new LlmExtractor(provider);
}
