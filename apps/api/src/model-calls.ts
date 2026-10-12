import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ModelCallLog, Conversation } from '@sufler/shared';
import { store } from './store';

const context = new AsyncLocalStorage<{ c: Conversation; type: string }>();
export function withModelCall<T>(c: Conversation, type: string, fn: () => Promise<T>) {
  return context.run({ c, type }, fn);
}
/** Persist each actual HTTP attempt (including SDK retries), never headers, keys or raw prompts. */
export const modelFetch: typeof fetch = async (input, init) => {
  const active = context.getStore();
  if (!active) return fetch(input, init);
  const start = Date.now();
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
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    reasoning: body.model === 'decision-model-preview' ? 'decision' : 'disabled',
  };
  try {
    const response = await fetch(input, init);
    log.httpStatus = response.status;
    log.status = response.ok ? 'ok' : 'error';
    const data = await response
      .clone()
      .json()
      .catch(() => ({}));
    const usage = data.usage || {};
    log.inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    log.outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
    log.reasoningTokens =
      usage.completion_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      0;
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
    await store.put(active.c.orgId, 'model-call', log.id, log).catch(() => {});
  }
};
