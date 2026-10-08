import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SessionUser, KnowledgeDocument } from '@sufler/shared';
import { config } from './config';
import { store } from './store';
import { saveDocument, publishDocument, addSalesTemplates, scriptSources } from './knowledge';
import { createConversation, configureConversation, makeHint, addSegment } from './conversations';
import { deleteConversation } from './infra';
import { selectEvidence, classify } from './ai';
import { SegmentSchema, PatchSchema } from '@sufler/shared';
vi.mock('./ai', async (original) => ({
  ...(await original<object>()),
  selectEvidence: vi.fn(),
  classify: vi.fn(),
}));
const original = {
  ragEnabled: config.ragEnabled,
  defaultAssistanceMode: config.defaultAssistanceMode,
};
let user: SessionUser;
function createFetchSpy() {
  return vi.spyOn(globalThis, 'fetch');
}
let fetchSpy: ReturnType<typeof createFetchSpy>;
beforeEach(() => {
  config.ragEnabled = false;
  config.defaultAssistanceMode = 'scripts';
  user = {
    id: randomUUID(),
    orgId: randomUUID(),
    orgName: 'Test',
    name: 'Test',
    email: 'test@example.org',
    role: 'admin',
    demo: true,
  };
  vi.clearAllMocks();
  fetchSpy = createFetchSpy().mockRejectedValue(
    new Error('External knowledge requests are forbidden in scripts mode'),
  );
});
afterEach(async () => {
  Object.assign(config, original);
  fetchSpy.mockRestore();
  for (const org of await store.organizations()) {
    for (const c of await store.list<any>(org, 'conversation')) await deleteConversation(org, c);
    for (const d of await store.list<KnowledgeDocument>(org, 'document'))
      await store.remove(org, 'document', d.id);
  }
});
async function setupScript() {
  const draft = await saveDocument(user, {
    title: 'Скрипт продажи',
    type: 'process',
    direction: 'sales',
    intent: 'sales_discovery',
    content: 'Уточните потребность.\n\nУточните бюджет.',
  });
  const script = await publishDocument(user, draft.id, 'published');
  const conversation = await createConversation(user);
  await configureConversation(user, conversation.id, { salesScriptId: script.id });
  return { script, conversation };
}
describe('sales scripts without RAG', () => {
  it('publishes and advances explicit steps without external requests or hint-model calls', async () => {
    const { script, conversation } = await setupScript();
    expect(script.indexedVersion).toBeNull();
    const first = await makeHint(user, conversation.id);
    expect(first?.blocks[0].blockId).toBe(script.blocks[0].id);
    expect(first?.text).toContain('Уточните потребность');
    const updated = await configureConversation(user, conversation.id, {
      completedStep: script.blocks[0].id,
    });
    expect(updated?.hints.at(-1)?.blocks[0].blockId).toBe(script.blocks[1].id);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(selectEvidence).not.toHaveBeenCalled();
  });
  it('rejects skipping steps, foreign scripts and switching to unavailable RAG', async () => {
    const { script, conversation } = await setupScript();
    await expect(
      configureConversation(user, conversation.id, { completedStep: script.blocks[1].id }),
    ).rejects.toThrow('текущий шаг');
    await expect(
      configureConversation(user, conversation.id, { assistanceMode: 'rag' }),
    ).rejects.toThrow('RAG отключён');
    const foreign = await saveDocument(
      { ...user, orgId: randomUUID() },
      {
        title: 'Чужой скрипт',
        type: 'process',
        direction: 'sales',
        intent: 'sales_discovery',
        content: 'Чужие условия продажи.',
      },
    );
    await expect(
      configureConversation(user, conversation.id, { salesScriptId: foreign.id }),
    ).rejects.toThrow('опубликованный скрипт');
  });
  it('rechecks publication, region and dates for script sources and practices', async () => {
    const { script, conversation } = await setupScript();
    const practice = await saveDocument(user, {
      title: 'Практика уточнения',
      type: 'article',
      direction: 'sales',
      intent: 'sales_best_practices',
      region: 'Москва',
      content: 'Задавайте один вопрос за раз.',
    });
    await publishDocument(user, practice.id, 'published');
    const c = await store.get<any>(user.orgId, 'conversation', conversation.id);
    expect((await scriptSources(c)).map((d) => d.id)).toEqual([script.id]);
    c.region = 'Москва';
    expect((await scriptSources(c)).map((d) => d.id)).toContain(practice.id);
    await publishDocument(user, script.id, 'archived');
    expect((await scriptSources(c)).some((d) => d.id === script.id)).toBe(false);
    const expired = await store.get<KnowledgeDocument>(user.orgId, 'document', practice.id);
    expired!.validUntil = '2000-01-01';
    await store.put(user.orgId, 'document', practice.id, expired!);
    expect(await scriptSources(c)).toEqual([]);
  });
  it('creates editable drafts once and never silently publishes generic advice', async () => {
    const first = await addSalesTemplates(user);
    expect(first).toHaveLength(2);
    expect(first.every((d) => d.status === 'draft' && d.direction === 'sales')).toBe(true);
    expect(await addSalesTemplates(user)).toEqual([]);
    const c = await createConversation(user);
    expect(await scriptSources(c)).toEqual([]);
  });
  it('preserves the selected script through classification and limits chat to approved sources', async () => {
    const { script, conversation } = await setupScript();
    vi.mocked(classify).mockResolvedValue({
      patch: PatchSchema.parse({
        direction: 'service',
        intent: 'other',
        stage: 'clarification',
        confidence: 0.9,
        shouldHint: false,
      }),
      source: 'kev',
      usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
    });
    await addSegment(
      user,
      conversation.id,
      SegmentSchema.parse({
        id: randomUUID(),
        text: 'У меня вопрос',
        role: 'customer',
        createdAt: new Date().toISOString(),
      }),
    );
    await vi.waitFor(async () =>
      expect(
        (await store.get<any>(user.orgId, 'conversation', conversation.id)).card
          .classificationSource,
      ).toBe('kev'),
    );
    vi.mocked(selectEvidence).mockResolvedValue({
      selection: [{ documentId: 'invented', blockId: 'invented' }],
      inputTokens: 10,
      outputTokens: 2,
    });
    const hint = await makeHint(user, conversation.id, 'Назови неизвестную цену');
    expect(hint?.kind).toBe('no_evidence');
    expect(hint?.blocks).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

it('keeps published script hints available when classification is forbidden', async () => {
  const { conversation } = await setupScript();
  vi.mocked(classify).mockRejectedValue(new Error('Forbidden'));
  await addSegment(
    user,
    conversation.id,
    SegmentSchema.parse({
      id: randomUUID(),
      role: 'customer',
      text: 'Хочу новый телефон',
      createdAt: new Date().toISOString(),
    }),
  );
  await vi.waitFor(async () => {
    const saved = await store.get<any>(user.orgId, 'conversation', conversation.id);
    expect(saved.error).toContain('403');
    expect(
      saved.hints.some(
        (hint: any) => hint.status === 'current' && hint.text.includes('Уточните потребность'),
      ),
    ).toBe(true);
  });
  expect(selectEvidence).not.toHaveBeenCalled();
});
