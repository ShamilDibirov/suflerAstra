import { afterEach, it, expect, vi } from 'vitest';
import { testModel } from './ai';
vi.mock('./config', () => ({
  config: {
    demo: false,
    dashscope: 'test-key',
    modelStudioBaseUrl: 'https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
  },
}));
afterEach(() => vi.unstubAllGlobals());
it('sends actual AI SDK requests to Alibaba with bearer auth and JSON mode', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: 'test',
        object: 'chat.completion',
        created: 1,
        model: 'qwen3.8-flash',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '{"ok":true}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fetch);
  expect(await testModel('qwen3.8-flash')).toEqual({ ok: true, demo: false });
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe(
    'https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
  );
  expect(new Headers(options.headers).get('authorization')).toBe('Bearer test-key');
  const body = JSON.parse(options.body);
  expect(body.model).toBe('qwen3.8-flash');
  expect(body.response_format).toEqual({ type: 'json_object' });
  expect(body.enable_thinking).toBe(false);
  expect(body.reasoning_effort).toBe('none');
  expect(body.messages[0].content).toContain('"ok"');
});
it('rejects malformed JSON output instead of presenting it as verified', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'test',
          object: 'chat.completion',
          created: 1,
          model: 'kimi-k2.5',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '{"wrong":true}' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
  await expect(testModel('kimi-k2.5')).rejects.toThrow();
});

it('rejects thinking-only models rather than pretending reasoning is off', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(testModel('kimi-k3')).rejects.toThrow('требует reasoning');
  expect(fetch).not.toHaveBeenCalled();
});
