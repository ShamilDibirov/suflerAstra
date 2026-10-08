import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { generateText } from 'ai';
import { classify, selectEvidence, salesAdvice, validateCoaching } from './ai';
import { newConversation } from '@sufler/shared/engine';
import { demoDocuments } from '@sufler/shared/demo';
import { MODEL_DEFAULTS, PatchSchema, SegmentSchema } from '@sufler/shared';
vi.mock('./config', () => ({
  config: {
    demo: false,
    openrouter: 'test-key',
    classifier: 'jaredpalmer/kev-4b',
    fallback: 'qwen/qwen3.5-9b',
    kevThreshold: 0.85,
  },
}));
vi.mock('ai', () => ({ generateText: vi.fn(), Output: { object: vi.fn((schema) => schema) } }));
const fetchMock = vi.fn();
const response = (confidence = 0.95) => ({
  answers: {
    direction: { type: 'choice', choice: 'service', confidence },
    intent: { type: 'choice', choice: 'sim_replacement', confidence },
    stage: { type: 'choice', choice: 'clarification', confidence },
    secondary: { type: 'choice', choice: 'unknown', confidence },
    objection: { type: 'choice', choice: 'none', confidence },
    shouldHint: { type: 'noul', noul: 0.9 },
    ending: { type: 'noul', noul: 0.01 },
    freeValues: { type: 'noul', noul: 0.1 },
  },
  usage: { input_tokens: 120, output_tokens: 10 },
});
const card = () => {
  const c = newConversation('org', 'u', MODEL_DEFAULTS[0].id, 'Клиент');
  c.segments = [
    SegmentSchema.parse({
      id: 's1',
      text: 'Нужна замена сим-карты, мой номер +7 (999) 123-45-67',
      role: 'customer',
      createdAt: new Date().toISOString(),
    }),
  ];
  return c;
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(response()), { headers: { 'Content-Type': 'application/json' } }),
  );
  vi.mocked(generateText).mockResolvedValue({
    output: PatchSchema.parse({
      direction: 'unknown',
      intent: 'unknown',
      stage: 'discovery',
      shouldHint: false,
      confidence: 0.4,
    }),
    usage: { inputTokens: 30, outputTokens: 10 },
  } as never);
});
afterEach(() => vi.unstubAllGlobals());
describe('provider contracts with mocked responses (not model quality)', () => {
  it('uses Decisions choice/noul, masks phone and preserves model token usage', async () => {
    const r = await classify(card(), demoDocuments('org'), new AbortController().signal);
    expect(r.source).toBe('kev');
    expect(r.patch.intent).toBe('sim_replacement');
    expect(r.patch.shouldHint).toBe(true);
    expect(r.usage.inputTokens).toBe(120);
    expect(generateText).not.toHaveBeenCalled();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    const request = JSON.parse(options.body);
    expect(request.model).toBe('jaredpalmer/kev-4b');
    expect(request.state).toContain('[ТЕЛЕФОН]');
    expect(request.state).not.toContain('123-45-67');
  });
  it('uses Qwen fallback on low KEV confidence', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(response(0.5))));
    const r = await classify(card(), demoDocuments('org'), new AbortController().signal);
    expect(r.source).toBe('qwen');
    expect(generateText).toHaveBeenCalledOnce();
  });
  it('uses Qwen after provider failure and clamps unknown invented intents', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
    vi.mocked(generateText).mockResolvedValue({
      output: PatchSchema.parse({
        direction: 'sales',
        intent: 'invented',
        secondaryIntents: ['invented'],
        stage: 'discovery',
        shouldHint: true,
        confidence: 0.9,
      }),
      usage: {},
    } as never);
    const r = await classify(card(), demoDocuments('org'), new AbortController().signal);
    expect(r.patch.intent).toBe('unknown');
    expect(r.patch.secondaryIntents).toEqual([]);
  });
  it('does not silently fall back in KEV-only evaluation', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(
      classify(card(), demoDocuments('org'), new AbortController().signal, 'kev'),
    ).rejects.toThrow();
    expect(generateText).not.toHaveBeenCalled();
  });
  it.each(MODEL_DEFAULTS.map((m) => m.id))(
    'uses the same selection-only contract for %s',
    async (id) => {
      vi.mocked(generateText).mockResolvedValue({
        output: { selection: [{ documentId: 'demo-doc-1', blockId: 'demo-block-1-1' }] },
        usage: { inputTokens: 42, outputTokens: 7 },
      } as never);
      const c = card();
      c.modelId = id;
      const documents = demoDocuments('org');
      documents[0].blocks[0].text += ' Контакт: +7 (999) 123-45-67';
      const result = await selectEvidence(
        c,
        documents,
        'Что сделать?',
        new AbortController().signal,
      );
      expect(result.selection).toEqual([{ documentId: 'demo-doc-1', blockId: 'demo-block-1-1' }]);
      const prompt = vi.mocked(generateText).mock.calls[0][0].prompt as string;
      expect(prompt).toContain('[ТЕЛЕФОН]');
      expect(prompt).not.toContain('123-45-67');
      expect((vi.mocked(generateText).mock.calls[0][0].model as { modelId: string }).modelId).toBe(
        id,
      );
      expect(vi.mocked(generateText).mock.calls[0][0].system).toContain(
        'Текст ответа сервер берёт дословно',
      );
    },
  );
});

it('generates prompt sales advice without retrieval, using selected model and masked speech', async () => {
  vi.mocked(generateText).mockResolvedValue({
    output: { text: 'Уточните, какие задачи важнее для клиента.' },
    usage: { inputTokens: 50, outputTokens: 12 },
  } as never);
  const result = await salesAdvice(
    card(),
    'Что спросить?',
    'Задавай один открытый вопрос.',
    new AbortController().signal,
  );
  expect(result.text).toContain('Уточните');
  const request = vi.mocked(generateText).mock.calls[0][0];
  expect(request.system).toContain('Задавай один открытый вопрос.');
  expect(request.system).toContain('Не утверждай цены');
  expect(request.prompt).not.toContain('999');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(validateCoaching('Тариф стоит 500 рублей.')).not.toContain('500');
});

it('offers general sales intents to KEV without knowledge documents', async () => {
  const c = card();
  c.assistanceMode = 'scripts';
  const data = response();
  data.answers.direction.choice = 'sales';
  data.answers.intent.choice = 'sales_discovery';
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }),
  );
  const result = await classify(c, [], new AbortController().signal);
  expect(result.patch.intent).toBe('sales_discovery');
  const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(payload.questions.intent.criteria).toHaveProperty('device_selection');
});
