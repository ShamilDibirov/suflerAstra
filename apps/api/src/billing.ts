import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelTariff, ModelCallLog, Conversation } from '@sufler/shared';
import { store } from './store';

export const TariffInput = z.object({
  modelId: z.string().min(1).max(140),
  input: z.number().min(0).max(100000),
  output: z.number().min(0).max(100000),
  cached: z.number().min(0).max(100000),
  effectiveAt: z.string().datetime(),
});
export async function saveTariff(org: string, value: unknown) {
  const data = TariffInput.parse(value);
  if (Date.parse(data.effectiveAt) < Date.now() - 60000)
    throw new Error('Дата тарифа не может быть в прошлом');
  const tariff: ModelTariff = {
    ...data,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    currency: 'USD',
  };
  await store.put(org, 'tariff', tariff.id, tariff);
  return tariff;
}
export async function tariffAt(org: string, model: string, at: string) {
  return (
    (await store.list<ModelTariff>(org, 'tariff'))
      .filter((t) => t.modelId === model && t.effectiveAt <= at)
      .sort(
        (a, b) =>
          b.effectiveAt.localeCompare(a.effectiveAt) || b.createdAt.localeCompare(a.createdAt),
      )[0] || null
  );
}
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function usageOf(data: any) {
  const u = data?.usage;
  const inputTokens = count(u?.prompt_tokens ?? u?.input_tokens),
    outputTokens = count(u?.completion_tokens ?? u?.output_tokens);
  const cachedTokens = count(
    u?.prompt_tokens_details?.cached_tokens ??
      u?.input_tokens_details?.cached_tokens ??
      (inputTokens === null ? null : 0),
  );
  const reasoningTokens = count(
    u?.completion_tokens_details?.reasoning_tokens ??
      u?.output_tokens_details?.reasoning_tokens ??
      (outputTokens === null ? null : 0),
  );
  return { inputTokens, outputTokens, cachedTokens, reasoningTokens };
}
export function estimateCost(u: ReturnType<typeof usageOf>, t: ModelTariff | null) {
  if (
    !t ||
    u.inputTokens === null ||
    u.outputTokens === null ||
    u.cachedTokens === null ||
    u.cachedTokens > u.inputTokens
  )
    return null;
  return (
    ((u.inputTokens - u.cachedTokens) * t.input +
      u.cachedTokens * t.cached +
      u.outputTokens * t.output) /
    1000000
  );
}
export function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
export function summarize(calls: ModelCallLog[], conversations: Conversation[]) {
  const unique = [...new Map(calls.map((c) => [c.id, c])).values()];
  const untrackedConversations = conversations.filter(
    (c) =>
      (c.hints.length || c.segments.length) && !unique.some((call) => call.conversationId === c.id),
  ).length;
  const known = unique.filter((c) => typeof c.costUsd === 'number');
  const success = unique.filter((c) => c.status === 'ok').map((c) => c.latencyMs);
  const hints = conversations.flatMap((c) => {
    const chatIds = new Set(
      c.messages.filter((m) => m.role === 'assistant').map((m) => m.hint?.id),
    );
    return c.hints.filter((h) => !chatIds.has(h.id));
  });
  const pipeline = hints.flatMap((h) =>
    h.pipelineLatencyMs === undefined ? [] : [h.pipelineLatencyMs],
  );
  const costUsd = known.reduce((n, c) => n + c.costUsd!, 0);
  const group = (key: (c: ModelCallLog) => string) => {
    const groups: Record<
      string,
      { calls: number; costUsd: number; unknown: number; tokens: number }
    > = {};
    for (const c of unique) {
      const row = (groups[key(c)] ||= { calls: 0, costUsd: 0, unknown: 0, tokens: 0 });
      row.calls++;
      row.costUsd += c.costUsd ?? 0;
      row.unknown += c.costUsd == null ? 1 : 0;
      row.tokens += (c.inputTokens ?? 0) + (c.outputTokens ?? 0);
    }
    return groups;
  };
  return {
    calls: unique.length,
    errors: unique.filter((c) => c.status === 'error').length,
    cancelled: unique.filter((c) => c.status === 'cancelled').length,
    inputTokens: unique.reduce((n, c) => n + (c.inputTokens ?? 0), 0),
    outputTokens: unique.reduce((n, c) => n + (c.outputTokens ?? 0), 0),
    cachedTokens: unique.reduce((n, c) => n + (c.cachedTokens ?? 0), 0),
    reasoningTokens: unique.reduce((n, c) => n + (c.reasoningTokens ?? 0), 0),
    unknownUsage: unique.filter((c) => c.inputTokens == null || c.outputTokens == null).length,
    costUsd: known.length ? costUsd : null,
    costCoverage: unique.length ? known.length / unique.length : null,
    incomplete: known.length !== unique.length || untrackedConversations > 0,
    untrackedConversations,
    conversations: conversations.length,
    hints: hints.length,
    costPerConversation:
      known.length && conversations.length ? costUsd / conversations.length : null,
    costPerHint: known.length && hints.length ? costUsd / hints.length : null,
    providerP50: percentile(success, 0.5),
    providerP95: percentile(success, 0.95),
    pipelineP50: percentile(pipeline, 0.5),
    pipelineP95: percentile(pipeline, 0.95),
    byModel: group((c) => c.model),
    byType: group((c) => c.type),
    byProvider: group((c) => (c.reasoning === 'decision' ? 'Decision' : 'LLM')),
    byDay: group((c) => new Date(Date.parse(c.at) + 3 * 3600000).toISOString().slice(0, 10)),
  };
}
