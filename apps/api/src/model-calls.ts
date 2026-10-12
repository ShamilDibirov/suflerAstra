import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ModelCallLog, Conversation } from '@sufler/shared';
import { store } from './store';
import { tariffAt, usageOf, estimateCost } from './billing';

const context = new AsyncLocalStorage<{ c: Conversation; type: string }>();
export function withModelCall<T>(c: Conversation, type: string, fn: () => Promise<T>) {
  return context.run({ c, type }, fn);
}
/** Persist each actual HTTP attempt (including SDK retries), never headers, keys or raw prompts. */
export const modelFetch: typeof fetch = async (input, init) => {
  const active = context.getStore();
  if (!active) return fetch(input, init);
  let start = Date.now();
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
  const log: ModelCallLog = {
    id: randomUUID(),
    conversationId: active.c.id,
    revision: active.c.card.revision,
    type: active.type,
    model: String(body.model || 'unknown'),
    at: new Date().toISOString(),
    latencyMs: 0,
    status: 'error',
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedTokens: null,
    costUsd: null,
    costSource: 'unknown',
    userId: active.c.userId,
    sessionId: active.c.sessionId || active.c.id,
    reasoning: body.model === 'decision-model-preview' ? 'decision' : 'disabled',
  };
  log.tariff = await tariffAt(active.c.orgId, log.model, log.at).catch(() => null);
  start = Date.now();
  try {
    const response = await fetch(input, init);
    log.httpStatus = response.status;
    log.status = response.ok ? 'ok' : 'error';
    const data = await response
      .clone()
      .json()
      .catch(() => ({}));
    Object.assign(log, usageOf(data));
    log.costUsd = estimateCost(usageOf(data), log.tariff || null);
    log.costSource = log.costUsd === null ? 'unknown' : 'estimated';
    log.requestId = data.request_id || response.headers.get('x-request-id') || undefined;
    log.result = data.answers
      ? JSON.stringify(data.answers).slice(0, 6000)
      : data.choices?.[0]?.finish_reason
        ? `finish_reason: ${data.choices[0].finish_reason}`
        : undefined;
    if (!response.ok) log.error = `HTTP ${response.status}`;
    return response;
  } catch (e) {
    log.status =
      init?.signal?.aborted && init.signal.reason?.name !== 'TimeoutError' ? 'cancelled' : 'error';
    log.error = e instanceof Error ? e.name : 'RequestError';
    throw e;
  } finally {
    log.latencyMs = Date.now() - start;
    // Telemetry must never interrupt the speech / hint flow.
    await store
      .withLock(`work-session:${active.c.orgId}:${active.c.sessionId || active.c.id}`, async () => {
        const current = await store.get<Conversation>(
          active.c.orgId,
          'conversation',
          log.conversationId,
        );
        if (!current) return;
        if (current.mergedInto) log.conversationId = current.mergedInto;
        await store.put(active.c.orgId, 'model-call', log.id, log);
      })
      .catch(() => {});
  }
};
