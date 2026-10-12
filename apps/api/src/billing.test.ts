import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { estimateCost, usageOf, tariffAt, summarize } from './billing';
import { newConversation } from '@sufler/shared/engine';
import { store } from './store';
import type { ModelTariff, ModelCallLog } from '@sufler/shared';
const tariff: ModelTariff = {
  id: 't',
  modelId: 'q',
  input: 2,
  output: 6,
  cached: 1,
  effectiveAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  currency: 'USD',
};
it('does not double count cache or reasoning, and never treats absent usage as zero', () => {
  const u = usageOf({
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens_details: { reasoning_tokens: 50 },
    },
  });
  expect(estimateCost(u, tariff)).toBeCloseTo(0.0022);
  expect(estimateCost(usageOf({}), tariff)).toBeNull();
  expect(estimateCost(u, null)).toBeNull();
  expect(estimateCost({ ...u, cachedTokens: 2000 }, tariff)).toBeNull();
  expect(estimateCost(usageOf({ usage: { input_tokens: 0, output_tokens: 0 } }), tariff)).toBe(0);
});
it('uses effective version and isolates organization tariffs', async () => {
  const org = randomUUID();
  await store.put(org, 'tariff', 't', tariff);
  await store.put(org, 'tariff', 'new', {
    ...tariff,
    id: 'new',
    input: 9,
    effectiveAt: '2026-10-10T00:00:00.000Z',
  });
  expect((await tariffAt(org, 'q', '2026-10-09T00:00:00.000Z'))?.input).toBe(2);
  expect((await tariffAt(org, 'q', '2026-10-11T00:00:00.000Z'))?.input).toBe(9);
  expect(await tariffAt(randomUUID(), 'q', '2026-10-11T00:00:00.000Z')).toBeNull();
});
it('deduplicates actual calls, includes retry costs, and excludes failures from successful latency', () => {
  const call: ModelCallLog = {
    id: 'a',
    conversationId: 'c',
    type: 'hint',
    model: 'q',
    at: '2026-10-12T22:00:00.000Z',
    latencyMs: 100,
    status: 'ok',
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 0,
    cachedTokens: 0,
    revision: 1,
    reasoning: 'disabled',
    costUsd: 0.01,
  };
  const result = summarize(
    [
      call,
      call,
      {
        ...call,
        id: 'b',
        status: 'error',
        latencyMs: 9000,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      },
      { ...call, id: 'c', latencyMs: 300 },
      {
        ...call,
        id: 'cancel',
        status: 'cancelled',
        latencyMs: 12000,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      },
    ],
    [],
  );
  expect(result.calls).toBe(4);
  expect(result.costUsd).toBe(0.02);
  expect(result.providerP95).toBe(300);
  expect(result.costCoverage).toBeCloseTo(2 / 4);
  expect(result.byDay['2026-10-13'].calls).toBe(4);
  expect(result.incomplete).toBe(true);
  expect(result.inputTokens).toBe(200);
});

it('counts only displayed hint cards, while retaining chat and service-call costs in the total', () => {
  const c = newConversation('org', 'u', 'model', 'Test');
  c.hints = [{ id: 'hint' }, { id: 'chat' }] as typeof c.hints;
  c.messages = [{ role: 'assistant', hint: { id: 'chat' } }] as typeof c.messages;
  const result = summarize([], [c]);
  expect(result.hints).toBe(1);
  expect(result.incomplete).toBe(true);
});
