import { beforeEach, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { type SessionUser, SegmentSchema } from '@sufler/shared';
import { demoDocuments } from '@sufler/shared/demo';
import { newConversation } from '@sufler/shared/engine';
import { chatAnswer, renderAssistantParts } from './assistant';
import { createConversation, makeHint, requireConversation, finish } from './conversations';
import { store } from './store';
import { config } from './config';
import { assistantResponse } from './ai';
vi.mock('./ai', async (original) => ({
  ...(await original<object>()),
  assistantResponse: vi.fn(),
}));
let user: SessionUser;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assistantResponse).mockReset();
  user = {
    id: randomUUID(),
    orgId: randomUUID(),
    role: 'owner',
    orgName: 'Org',
    name: 'Owner',
    email: 'owner@example.test',
    demo: true,
  };
  vi.mocked(assistantResponse).mockResolvedValue({
    parts: [
      { kind: 'advice', text: '**Следующий шаг:** сравните варианты по главной потребности.' },
    ],
    inputTokens: 40,
    outputTokens: 20,
  });
});
it('uses chat memory without replacing live hints and survives an ordinary card revision', async () => {
  const c = await createConversation(user);
  const previous = await makeHint(user, c.id);
  await chatAnswer(user, c.id, 'Разбери ситуацию', new AbortController().signal);
  let resolve!: (v: Awaited<ReturnType<typeof assistantResponse>>) => void;
  vi.mocked(assistantResponse).mockReturnValueOnce(new Promise((r) => (resolve = r)));
  const pending = chatAnswer(user, c.id, 'А как ответить?', new AbortController().signal);
  await vi.waitFor(() =>
    expect(vi.mocked(assistantResponse).mock.calls.at(-1)?.[1]).toBe('А как ответить?'),
  );
  expect(vi.mocked(assistantResponse).mock.calls.at(-1)?.[0].messages).toHaveLength(2);
  await store.mutateConversation(user.orgId, c.id, (v) => ({
    ...v,
    generationEpoch: v.generationEpoch + 1,
    card: { ...v.card, revision: v.card.revision + 1 },
  }));
  resolve({
    parts: [{ kind: 'advice', text: '«Что для вас будет решающим при выборе?»' }],
    inputTokens: 20,
    outputTokens: 10,
  });
  expect(await pending).not.toBeNull();
  const updated = await requireConversation(user, c.id);
  expect(updated.messages).toHaveLength(4);
  expect(updated.hints).toEqual(previous ? [previous] : []);
  await finish(user, c.id);
});
it('continues helping without documents and rejects cross-tenant chat', async () => {
  const c = await createConversation(user);
  await expect(
    chatAnswer({ ...user, orgId: randomUUID() }, c.id, 'Помоги', new AbortController().signal),
  ).rejects.toThrow();
  const answer = await chatAnswer(
    user,
    c.id,
    'Как ответить на дорого?',
    new AbortController().signal,
  );
  expect(answer?.kind).toBe('coaching');
  expect(answer?.text).toContain('Следующий шаг');
  expect(assistantResponse).toHaveBeenCalledOnce();
  await finish(user, c.id);
});
it('does not publish cancelled responses or answers with withdrawn source versions', async () => {
  const docs = demoDocuments(user.orgId);
  for (const d of docs) await store.put(user.orgId, 'document', d.id, d);
  const c = await createConversation(user);
  await store.mutateConversation(user.orgId, c.id, (v) => ({
    ...v,
    assistanceMode: 'rag',
    card: { ...v.card, intent: docs[0].intent, direction: 'service' },
  }));
  let resolve!: (v: Awaited<ReturnType<typeof assistantResponse>>) => void;
  vi.mocked(assistantResponse).mockReturnValueOnce(new Promise((r) => (resolve = r)));
  const abort = new AbortController(),
    pending = chatAnswer(user, c.id, docs[0].title, abort.signal);
  await vi.waitFor(() => expect(assistantResponse).toHaveBeenCalledOnce());
  abort.abort();
  resolve({
    parts: [
      {
        kind: 'source',
        text: docs[0].blocks[0].text,
        documentId: docs[0].id,
        blockId: docs[0].blocks[0].id,
      },
    ],
    inputTokens: 10,
    outputTokens: 10,
  });
  expect(await pending).toBeNull();
  expect((await requireConversation(user, c.id)).messages).toEqual([]);
  await finish(user, c.id);
});
it('keeps only exact, applicable source and transcript quotes while preserving useful advice', () => {
  const c = newConversation('org', 'u', 'qwen', 'Test'),
    docs = demoDocuments('org');
  c.segments = [
    SegmentSchema.parse({
      id: 's1',
      text: 'Бюджет до 500 рублей',
      role: 'customer',
      createdAt: new Date().toISOString(),
    }),
  ];
  const result = renderAssistantParts(c, docs, [
    { kind: 'advice', text: 'Сравните варианты по потребности.\n\nТариф стоит 999 рублей.' },
    { kind: 'context', text: 'Бюджет до 500 рублей', segmentId: 's1' },
    {
      kind: 'source',
      text: docs[0].blocks[0].text,
      documentId: docs[0].id,
      blockId: docs[0].blocks[0].id,
    },
    {
      kind: 'source',
      text: 'Несуществующая цена',
      documentId: docs[0].id,
      blockId: docs[0].blocks[0].id,
    },
    { kind: 'context', text: 'Бюджет до 1000 рублей', segmentId: 's1' },
  ]);
  expect(result.text).toContain('Сравните варианты');
  expect(result.text).toContain('500 рублей');
  expect(result.text).not.toContain('999');
  expect(result.text).not.toContain('1000');
  expect(result.text).not.toContain('Несуществующая');
  expect(result.references).toHaveLength(1);
  expect(
    renderAssistantParts({ ...c, orgId: 'other' }, docs, [
      {
        kind: 'source',
        text: docs[0].blocks[0].text,
        documentId: docs[0].id,
        blockId: docs[0].blocks[0].id,
      },
    ]).references,
  ).toEqual([]);
});

it('drops an archived source from a late chat answer while retaining useful analysis', async () => {
  const docs = demoDocuments(user.orgId);
  for (const d of docs) await store.put(user.orgId, 'document', d.id, d);
  const c = await createConversation(user);
  await store.mutateConversation(user.orgId, c.id, (v) => ({ ...v, assistanceMode: 'rag' }));
  let resolve!: (v: Awaited<ReturnType<typeof assistantResponse>>) => void;
  vi.mocked(assistantResponse).mockReturnValueOnce(new Promise((r) => (resolve = r)));
  const pending = chatAnswer(user, c.id, docs[0].title, new AbortController().signal);
  await vi.waitFor(() => expect(assistantResponse).toHaveBeenCalledOnce());
  await store.put(user.orgId, 'document', docs[0].id, { ...docs[0], status: 'archived' });
  resolve({
    parts: [
      { kind: 'advice', text: 'Уточните, какой результат нужен клиенту.' },
      {
        kind: 'source',
        text: docs[0].blocks[0].text,
        documentId: docs[0].id,
        blockId: docs[0].blocks[0].id,
      },
    ],
    inputTokens: 20,
    outputTokens: 10,
  });
  const answer = await pending;
  expect(answer?.blocks).toEqual([]);
  expect(answer?.text).toContain('какой результат');
  expect(answer?.text).not.toContain(docs[0].blocks[0].text);
  await finish(user, c.id);
});

it('does not publish chat analysis based on speech that was explicitly corrected', async () => {
  const c = await createConversation(user);
  const turn = SegmentSchema.parse({
    id: 's1',
    text: 'Для дачи',
    role: 'customer',
    createdAt: new Date().toISOString(),
  });
  await store.mutateConversation(user.orgId, c.id, (v) => ({ ...v, segments: [turn] }));
  let resolve!: (v: Awaited<ReturnType<typeof assistantResponse>>) => void;
  vi.mocked(assistantResponse).mockReturnValueOnce(new Promise((r) => (resolve = r)));
  const pending = chatAnswer(user, c.id, 'Какой следующий шаг?', new AbortController().signal);
  await vi.waitFor(() => expect(assistantResponse).toHaveBeenCalledOnce());
  await store.mutateConversation(user.orgId, c.id, (v) => ({
    ...v,
    segments: [{ ...turn, text: 'Для работы' }],
  }));
  resolve({
    parts: [{ kind: 'advice', text: 'Обсудите использование на даче.' }],
    inputTokens: 10,
    outputTokens: 10,
  });
  expect(await pending).toBeNull();
  expect((await requireConversation(user, c.id)).messages).toEqual([]);
  await finish(user, c.id);
});

it('serializes overlapping chat questions and passes the first answer into the second request', async () => {
  const c = await createConversation(user);
  let release!: (v: Awaited<ReturnType<typeof assistantResponse>>) => void;
  vi.mocked(assistantResponse).mockReturnValueOnce(new Promise((r) => (release = r)));
  const first = chatAnswer(user, c.id, 'Первый вопрос', new AbortController().signal);
  await vi.waitFor(() => expect(assistantResponse).toHaveBeenCalledOnce());
  const second = chatAnswer(user, c.id, 'Второй вопрос', new AbortController().signal);
  await new Promise((r) => setTimeout(r, 10));
  expect(assistantResponse).toHaveBeenCalledOnce();
  release({
    parts: [{ kind: 'advice', text: 'Ответ на первый вопрос.' }],
    inputTokens: 10,
    outputTokens: 10,
  });
  await Promise.all([first, second]);
  expect(vi.mocked(assistantResponse).mock.calls[1][0].messages).toHaveLength(2);
  expect(
    (await requireConversation(user, c.id)).messages
      .filter((m) => m.role === 'user')
      .map((m) => m.text),
  ).toEqual(['Первый вопрос', 'Второй вопрос']);
  await finish(user, c.id);
});
