import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Conversation, SessionUser, KnowledgeDocument } from '../packages/shared/src/index';
import { SegmentSchema, PatchSchema, MODEL_DEFAULTS } from '../packages/shared/src/index';
import { demoDocuments } from '../packages/shared/src/demo';
import { store } from '../apps/api/src/store';
import { config } from '../apps/api/src/config';
import { assertAdmin } from '../apps/api/src/auth';
import {
  createConversation,
  configureConversation,
  addSegment,
  editSegment,
  makeHint,
  requireConversation,
  finish,
} from '../apps/api/src/conversations';
import { publishDocument, saveDocument } from '../apps/api/src/knowledge';
import { deleteConversation, retention } from '../apps/api/src/infra';
import { classify, selectEvidence } from '../apps/api/src/ai';
vi.mock('../apps/api/src/ai', () => ({ classify: vi.fn(), selectEvidence: vi.fn() }));
let user: SessionUser, docs: KnowledgeDocument[];
const classification = {
  patch: PatchSchema.parse({
    direction: 'service',
    intent: 'sim_replacement',
    stage: 'clarification',
    shouldHint: false,
    confidence: 0.95,
  }),
  source: 'kev' as const,
  usage: { inputTokens: 10, outputTokens: 1, cost: 0 },
};
const segment = (text = 'Нужно заменить сим-карту') =>
  SegmentSchema.parse({
    id: randomUUID(),
    text,
    role: 'customer',
    createdAt: new Date().toISOString(),
  });
beforeEach(async () => {
  vi.clearAllMocks();
  user = {
    id: randomUUID(),
    orgId: randomUUID(),
    orgName: 'Test',
    name: 'Test',
    email: 'test@example.org',
    role: 'consultant',
    demo: true,
  };
  docs = demoDocuments(user.orgId);
  for (const d of docs) await store.put(user.orgId, 'document', d.id, d);
  vi.mocked(classify).mockResolvedValue(structuredClone(classification));
  vi.mocked(selectEvidence).mockResolvedValue({
    selection: [{ documentId: docs[0].id, blockId: docs[0].blocks[0].id }],
    inputTokens: 20,
    outputTokens: 5,
  });
});
afterEach(async () => {
  for (const org of await store.organizations()) {
    for (const c of await store.list<Conversation>(org, 'conversation'))
      await deleteConversation(org, c);
    for (const d of await store.list<KnowledgeDocument>(org, 'document'))
      await store.remove(org, 'document', d.id);
  }
});
const waitForClassification = async (id: string) => {
  await vi.waitFor(async () =>
    expect(
      (await store.get<Conversation>(user.orgId, 'conversation', id))?.card.classificationSource,
    ).toBe('kev'),
  );
};
describe('server authorization and asynchronous state', () => {
  it('requires an admin role independently of the UI', () => {
    expect(() => assertAdmin(user)).toThrow();
    expect(() => assertAdmin({ ...user, role: 'admin' })).not.toThrow();
  });
  it('isolates organizations, users, and privileged history access', async () => {
    const c = await createConversation(user);
    await expect(requireConversation({ ...user, orgId: 'other' }, c.id)).rejects.toThrow();
    await expect(requireConversation({ ...user, id: 'other' }, c.id)).rejects.toThrow();
    await expect(
      requireConversation({ ...user, id: 'admin', role: 'admin' }, c.id),
    ).resolves.toHaveProperty('id', c.id);
    await expect(
      requireConversation({ ...user, id: 'admin', role: 'admin' }, c.id, true),
    ).rejects.toThrow();
  });
  it('preserves context while changing the model and invalidates pending generations', async () => {
    const c = await createConversation(user);
    await addSegment(user, c.id, segment());
    await waitForClassification(c.id);
    const before = (await requireConversation(user, c.id)).card;
    const next = await configureConversation(user, c.id, { modelId: MODEL_DEFAULTS[2].id });
    expect(next?.card.intent).toBe(before.intent);
    expect(next?.segments).toHaveLength(1);
    expect(next?.card.id).toBe(before.id);
    expect(next?.modelId).toBe(MODEL_DEFAULTS[2].id);
  });
  it('starts a new client with an entirely empty card and completes the previous session', async () => {
    const c = await createConversation(user);
    await addSegment(user, c.id, segment());
    await waitForClassification(c.id);
    await makeHint(user, c.id);
    const next = await createConversation(user, MODEL_DEFAULTS[2].id);
    expect(next.card.intent).toBe('unknown');
    expect(next.segments).toEqual([]);
    expect(next.hints).toEqual([]);
    expect(next.card.shownOffers).toEqual([]);
    expect((await requireConversation(user, c.id)).status).toBe('completed');
  });
  it('discards a late classification after manual correction', async () => {
    let resolve!: (v: typeof classification) => void;
    vi.mocked(classify).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const c = await createConversation(user);
    await addSegment(user, c.id, segment());
    await vi.waitFor(() => expect(classify).toHaveBeenCalled());
    await configureConversation(user, c.id, { intent: 'unknown' });
    resolve(classification);
    await new Promise((r) => setTimeout(r, 20));
    expect((await requireConversation(user, c.id)).card.classificationSource).toBe('manual');
  });
  it('discards a late hint after model switch', async () => {
    let resolve!: (v: Awaited<ReturnType<typeof selectEvidence>>) => void;
    vi.mocked(selectEvidence).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const c = await createConversation(user);
    const pending = makeHint(user, c.id);
    await vi.waitFor(() => expect(selectEvidence).toHaveBeenCalled());
    await configureConversation(user, c.id, { modelId: MODEL_DEFAULTS[2].id });
    resolve({
      selection: [{ documentId: docs[0].id, blockId: docs[0].blocks[0].id }],
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(await pending).toBeNull();
    expect((await requireConversation(user, c.id)).hints).toEqual([]);
  });
  it('does not allow a newly classified card to reuse an earlier hint revision', async () => {
    const c = await createConversation(user);
    await addSegment(user, c.id, segment());
    await waitForClassification(c.id);
    expect((await requireConversation(user, c.id)).card.revision).toBe(2);
  });
  it('withdraws a displayed hint when its source expires during a conversation', async () => {
    const c = await createConversation(user);
    await addSegment(user, c.id, segment());
    await waitForClassification(c.id);
    await makeHint(user, c.id);
    const before = await requireConversation(user, c.id);
    expect(before.hints.some((hint) => hint.status === 'current' && hint.blocks.length)).toBe(true);
    await store.put(user.orgId, 'document', docs[0].id, {
      ...docs[0],
      validUntil: '2000-01-01',
    });
    const after = await requireConversation(user, c.id);
    expect(after.hints.every((hint) => hint.status === 'stale')).toBe(true);
    expect(after.generationEpoch).toBeGreaterThan(before.generationEpoch);
  });
  it('does not invoke AI or invalidate a hint for an excluded bystander', async () => {
    const c = await createConversation(user);
    await makeHint(user, c.id);
    await addSegment(user, c.id, {
      ...segment('Соседний покупатель'),
      role: 'bystander',
      excluded: true,
    });
    expect(classify).not.toHaveBeenCalled();
    expect((await requireConversation(user, c.id)).hints[0].status).toBe('current');
  });
  it('removes dependent facts when a speaker is corrected', async () => {
    const c = await createConversation(user),
      s = segment();
    await addSegment(user, c.id, s);
    await waitForClassification(c.id);
    await editSegment(user, c.id, s.id, { role: 'bystander', excluded: true });
    expect((await requireConversation(user, c.id)).card.facts).toEqual([]);
  });
  it('rechecks publication after model latency', async () => {
    const c = await createConversation(user);
    await addSegment(user, c.id, segment());
    await waitForClassification(c.id);
    let resolve!: (v: Awaited<ReturnType<typeof selectEvidence>>) => void;
    vi.mocked(selectEvidence).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const pending = makeHint(user, c.id);
    await vi.waitFor(() => expect(selectEvidence).toHaveBeenCalled());
    await publishDocument({ ...user, role: 'admin' }, docs[0].id, 'archived');
    resolve({
      selection: [{ documentId: docs[0].id, blockId: docs[0].blocks[0].id }],
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(await pending).toBeNull();
  });
  it('expires transcripts, revisions, and usage together after 30 days', async () => {
    const c = await createConversation(user);
    c.createdAt = new Date(Date.now() - 31 * 86400000).toISOString();
    await store.put(user.orgId, 'conversation', c.id, c);
    await store.put(user.orgId, 'usage', 'usage1', { conversationId: c.id, inputTokens: 12 });
    await store.mutateConversation(user.orgId, c.id, (v) => v);
    await retention();
    expect(await store.get(user.orgId, 'conversation', c.id)).toBeNull();
    expect(await store.list(user.orgId, 'usage')).toEqual([]);
    expect(await store.list(user.orgId, 'revision')).toEqual([]);
  });
  it('applies the seven-day pilot retention without deleting recent conversations', async () => {
    const previous = config.retentionDays;
    config.retentionDays = 7;
    try {
      const old = await createConversation(user);
      old.createdAt = new Date(Date.now() - 8 * 86400000).toISOString();
      await store.put(user.orgId, 'conversation', old.id, old);
      const recent = await createConversation({ ...user, id: randomUUID() });
      recent.createdAt = new Date(Date.now() - 6 * 86400000).toISOString();
      await store.put(user.orgId, 'conversation', recent.id, recent);
      await retention();
      expect(await store.get(user.orgId, 'conversation', old.id)).toBeNull();
      expect(await store.get(user.orgId, 'conversation', recent.id)).not.toBeNull();
    } finally {
      config.retentionDays = previous;
    }
  });
  it('enforces a total limit of ten even under concurrent creation', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 11 }, (_, i) => createConversation({ ...user, id: `u-${i}` })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('refuses disabled models and writes to completed conversations', async () => {
    const c = await createConversation(user);
    await expect(
      configureConversation(user, c.id, { modelId: 'unapproved/model' }),
    ).rejects.toThrow();
    await finish(user, c.id);
    await expect(addSegment(user, c.id, segment())).rejects.toThrow();
  });
  it('shows an approved urgent step immediately without spending model tokens', async () => {
    docs[0].blocks[0].urgent = true;
    await store.put(user.orgId, 'document', docs[0].id, docs[0]);
    const c = await createConversation(user);
    await store.mutateConversation(user.orgId, c.id, (v) => ({
      ...v,
      lastAutoHintAt: Date.now(),
      card: { ...v.card, intent: docs[0].intent },
    }));
    const hint = await makeHint(user, c.id, '', false);
    expect(hint?.blocks[0].blockId).toBe(docs[0].blocks[0].id);
    expect(selectEvidence).not.toHaveBeenCalled();
    expect(await makeHint(user, c.id, '', false)).toBeNull();
  });
  it('requires step confirmations again after a process version is edited', async () => {
    const old = docs[0];
    const saved = await saveDocument(
      { ...user, role: 'admin' },
      { ...old, content: old.content + '\n' },
      old.id,
    );
    expect(saved.version).toBe(2);
    expect(saved.blocks.map((b) => b.id)).not.toContain(old.blocks[0].id);
    expect(saved.blocks[2].requiredFacts).toEqual([saved.blocks[1].id]);
  });
});
