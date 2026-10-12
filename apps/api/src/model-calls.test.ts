import { afterEach, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { modelFetch, withModelCall } from './model-calls';
import { newConversation } from '@sufler/shared/engine';
import type { ModelCallLog } from '@sufler/shared';
import { store } from './store';
afterEach(() => vi.unstubAllGlobals());
it('captures model latency, actual usage and failure without storing credentials or prompts; deletes with dialogue', async () => {
  const c = newConversation(randomUUID(), 'u', 'qwen3.8-flash', 'Client');
  const otherOrg = randomUUID();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            usage: {
              prompt_tokens: 50,
              completion_tokens: 15,
              completion_tokens_details: { reasoning_tokens: 0 },
            },
            choices: [{ finish_reason: 'stop' }],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 403 })),
  );
  const options = {
    method: 'POST',
    headers: { Authorization: 'secret-token' },
    body: JSON.stringify({ model: c.modelId, messages: [{ content: 'private-prompt' }] }),
  };
  await withModelCall(c, 'hint', () => modelFetch('https://example.org', options));
  await withModelCall(c, 'classification', () => modelFetch('https://example.org', options));
  const logs = await store.list<ModelCallLog>(c.orgId, 'model-call');
  expect(logs).toHaveLength(2);
  expect(logs[0]).toMatchObject({
    status: 'ok',
    inputTokens: 50,
    outputTokens: 15,
    reasoningTokens: 0,
  });
  expect(logs[1]).toMatchObject({ status: 'error', httpStatus: 403 });
  expect(logs.every((x) => x.latencyMs >= 0)).toBe(true);
  expect(JSON.stringify(logs)).not.toContain('secret-token');
  expect(JSON.stringify(logs)).not.toContain('private-prompt');
  expect(await store.list(otherOrg, 'model-call')).toEqual([]);
  await store.removeConversationRecords(c.orgId, c.id);
  expect(await store.list(c.orgId, 'model-call')).toEqual([]);
});
