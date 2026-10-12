import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { generateText } from 'ai';
import {
  classify,
  selectEvidence,
  salesAdvice,
  validateCoaching,
  testDecisionModel,
  inferSpeakerRoles,
  inferBoundary,
} from './ai';
import { newConversation } from '@sufler/shared/engine';
import { demoDocuments } from '@sufler/shared/demo';
import { MODEL_DEFAULTS, PatchSchema, SegmentSchema } from '@sufler/shared';
vi.mock('./config', () => ({
  config: {
    demo: false,
    dashscope: 'test-key',
    modelStudioBaseUrl: 'https://test.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    classifier: 'decision-model-preview',
    fallback: 'qwen3.8-flash',
    decisionThreshold: 0.85,
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
    expect(r.source).toBe('decision');
    expect(r.patch.intent).toBe('sim_replacement');
    expect(r.patch.shouldHint).toBe(true);
    expect(r.usage.inputTokens).toBe(120);
    expect(generateText).not.toHaveBeenCalled();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://test.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/systemone');
    const request = JSON.parse(options.body);
    expect(request.model).toBe('decision-model-preview');
    expect(request.state).toContain('[ТЕЛЕФОН]');
    expect(request.state).not.toContain('123-45-67');
  });
  it('uses Qwen fallback on low Decision Model confidence', async () => {
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
  it('does not silently fall back in Decision Model-only evaluation', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(
      classify(card(), demoDocuments('org'), new AbortController().signal, 'decision'),
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
  expect(validateCoaching('Тариф стоит **500** **рублей**.')).not.toContain('500');
  expect(validateCoaching('Это **бесплатно**.')).not.toContain('бесплатно');
});

it('offers general sales intents to Decision Model without knowledge documents', async () => {
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

it('checks the standalone Decision Model endpoint with bearer authentication', async () => {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        model: 'decision-model-preview',
        answers: { route: { type: 'choice', choice: 'sales', confidence: 0.9 } },
        usage: { input_tokens: 25 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ),
  );
  expect(await testDecisionModel()).toEqual({ ok: true, demo: false });
  const [url, request] = fetchMock.mock.calls[0];
  expect(url).toContain('/compatible-mode/v1/systemone');
  expect(request.headers.Authorization).toBe('Bearer test-key');
  expect(JSON.parse(request.body).model).toBe('decision-model-preview');
});

it('infers semantic roles only for supplied speakers and accepts no low-confidence guess', async () => {
  const c = card();
  c.segments = [
    { ...c.segments[0], speakerId: 'stream:7', role: 'unknown', roleInference: true },
    {
      ...c.segments[0],
      id: 'second',
      speakerId: 'stream:2',
      role: 'unknown',
      roleInference: true,
      text: 'Как могу помочь?',
    },
  ];
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        answers: {
          speaker_0: { type: 'choice', choice: 'customer', confidence: 0.96 },
          speaker_1: { type: 'choice', choice: 'consultant', confidence: 0.5 },
          speaker_99: { type: 'choice', choice: 'consultant', confidence: 0.99 },
        },
      }),
    ),
  );
  const roles = await inferSpeakerRoles(c, new AbortController().signal);
  expect(roles).toEqual({ 'stream:7': { role: 'customer', confidence: 0.96, source: 'model' } });
  const request = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(request.questions.speaker_0.instructions).toContain('Номер спикера');
  expect(JSON.stringify(request)).not.toContain('123-45-67');
});

it('requires both boundary signals, ordered transcript anchors and 0.9 confidence', async () => {
  const c = card();
  c.segments = [0, 1, 2, 3].map((i) =>
    SegmentSchema.parse({
      id: `s${i}`,
      text: ['Всё готово', 'До свидания', 'Здравствуйте, я следующий', 'Мне нужен телефон'][i],
      role: 'customer',
      confidence: 0.99,
      startMs: i * 1000,
      endMs: i * 1000 + 900,
      createdAt: new Date().toISOString(),
    }),
  );
  const answer = (
    ended = 0.95,
    began = 0.95,
    first = 's2',
    evidence = 's1',
    confidence = 0.95,
  ) => ({
    answers: {
      ended: { type: 'noul', noul: ended },
      began: { type: 'noul', noul: began },
      first: { type: 'choice', choice: first, confidence },
      endEvidence: { type: 'choice', choice: evidence, confidence },
    },
  });
  for (const [data, expected] of [
    [answer(), 's2'],
    [answer(0.89), null],
    [answer(0.95, 0.7), null],
    [answer(0.95, 0.95, 'invented'), null],
    [answer(0.95, 0.95, 's1', 's2'), null],
    [answer(0.95, 0.95, 's2', 's1', 0.85), null],
  ] as const) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(data)));
    expect(await inferBoundary(c, new AbortController().signal)).toBe(expected);
  }
});
