import type { Activity, Category, Digest, ExtractContext, Extractor, LlmProvider, LlmRequest } from "../types.js";
import { classifyActivity, domainMatches, emailDomain, externalParticipants, isOwnWork } from "./classify.js";
import { type DigestBody, emptyBody, finalize, mergeBodies, windowOf } from "./digest.js";
import { heuristicBody } from "./heuristic.js";
import { buildRepairRequest, buildSystemPrompt, buildUserPrompt, relevantThreads, splitIntoBatches } from "./prompts.js";
import { coerceBody, parseLlmJson } from "./validate.js";

export interface LlmExtractorOptions {
  maxTokens?: number;
}

export class LlmExtractor implements Extractor {
  constructor(
    private readonly provider: LlmProvider,
    private readonly opts: LlmExtractorOptions = {}
  ) {}

  async extract(activities: Activity[], ctx: ExtractContext): Promise<Digest> {
    const { config, log } = ctx;
    const drop = new Set(config.filters.dropCategories);
    const ruleCategory = new Map<string, Category | null>();
    const dropped: Record<string, number> = {};
    const kept: Activity[] = [];

    for (const a of activities) {
      const cat = classifyActivity(a, config);
      if (cat && drop.has(cat)) {
        dropped[cat] = (dropped[cat] ?? 0) + 1;
        continue;
      }
      if (!isOwnWork(a) && onlyIgnoredDomains(a, ctx)) {
        dropped.ignoredDomain = (dropped.ignoredDomain ?? 0) + 1;
        continue;
      }
      ruleCategory.set(a.id, cat);
      kept.push(a);
    }
    log.info("extract: rule filter", { total: activities.length, kept: kept.length, dropped });

    if (!kept.length) return { window: windowOf(ctx), ...finalize(emptyBody(), config) };

    const batches = splitIntoBatches(kept, config.limits.batchChars, config.limits.maxActivityChars);
    log.info(`extract: ${kept.length} activities in ${batches.length} batch(es) via ${this.provider.name}`);

    const system = buildSystemPrompt(config);
    const parts: DigestBody[] = [];
    for (const [index, batch] of batches.entries()) {
      parts.push(await this.runBatch(batch, { index, total: batches.length }, system, ruleCategory, ctx));
    }
    return { window: windowOf(ctx), ...finalize(mergeBodies(parts), config) };
  }

  private async runBatch(
    batch: Activity[],
    pos: { index: number; total: number },
    system: string,
    ruleCategory: Map<string, Category | null>,
    ctx: ExtractContext
  ): Promise<DigestBody> {
    const { log } = ctx;
    const label = `batch ${pos.index + 1}/${pos.total}`;
    const req: LlmRequest = {
      system,
      user: buildUserPrompt({
        activities: batch,
        knownThreads: relevantThreads(batch, ctx.knownThreads),
        window: ctx.window,
        batch: pos,
        maxTextChars: ctx.config.limits.maxActivityChars,
      }),
      json: true,
      maxTokens: this.opts.maxTokens ?? 8192,
    };
    const fallback = (reason: string) => {
      log.warn(`extract: ${label} ${reason}; using heuristic extraction for it`, { activities: batch.length });
      return heuristicBody(batch, ctx);
    };

    let parsed;
    try {
      parsed = parseLlmJson(await this.provider.complete(req));
      if (!parsed.ok) {
        log.warn(`extract: ${label} reply unusable (${parsed.error}); asking once more`);
        parsed = parseLlmJson(await this.provider.complete(buildRepairRequest(req, parsed.error)));
      }
    } catch (err) {
      return fallback(`failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!parsed.ok) return fallback(`reply unusable again (${parsed.error})`);

    const body = coerceBody(parsed.value, {
      config: ctx.config,
      activities: batch,
      knownThreads: ctx.knownThreads,
      ruleCategory,
    });
    log.debug(`extract: ${label} done`, {
      projects: body.projects.length,
      contacts: body.contacts.length,
      threads: body.threads.length,
    });
    return body;
  }
}

function onlyIgnoredDomains(a: Activity, ctx: ExtractContext): boolean {
  const ignore = ctx.config.filters.ignoreDomains;
  if (!ignore.length) return false;
  const outside = externalParticipants(a, ctx.config);
  return (
    outside.length > 0 &&
    outside.every((p) => {
      const d = emailDomain(p.email);
      return !!d && domainMatches(d, ignore);
    })
  );
}
