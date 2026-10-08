import { randomUUID, createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type {
  Conversation,
  Hint,
  KnowledgeDocument,
  ModelConfig,
  SessionUser,
  TranscriptSegment,
} from '@sufler/shared';
import { MODEL_DEFAULTS } from '@sufler/shared';
import {
  newConversation,
  invalidate,
  eligibleSegments,
  applyPatch,
  verifiedEvidence,
  renderHint,
  maskPII,
  isPublished,
  compactContext,
} from '@sufler/shared/engine';
import { store } from './store';
import { emit } from './events';
import { classify, selectEvidence } from './ai';
import { retrieve } from './knowledge';
import { redis } from './infra';
import { config } from './config';

const classifiers = new Map<string, AbortController>(),
  generators = new Map<string, AbortController>();
export async function models(org: string) {
  const saved = await store.list<ModelConfig>(org, 'model');
  return saved.length ? saved : structuredClone(MODEL_DEFAULTS);
}
export async function requireConversation(user: SessionUser, id: string, write = false) {
  const c = await store.get<Conversation>(user.orgId, 'conversation', id);
  if (!c) throw new NotFoundException('Диалог не найден');
  if (c.userId !== user.id && (write || user.role === 'consultant')) throw new ForbiddenException();
  const current = c.hints.filter((h) => h.status === 'current' && h.blocks.length);
  if (current.length) {
    const docs = await store.list<KnowledgeDocument>(user.orgId, 'document');
    const expired = new Set(
      current
        .filter((h) =>
          h.blocks.some(
            (ref) =>
              !docs.some(
                (d) =>
                  d.id === ref.documentId &&
                  d.version === ref.version &&
                  isPublished(d, user.orgId),
              ),
          ),
        )
        .map((h) => h.id),
    );
    if (expired.size) {
      const updated = await store.mutateConversation(user.orgId, id, (v) => ({
        ...v,
        generationEpoch: v.generationEpoch + 1,
        hints: v.hints.map((h) => (expired.has(h.id) ? { ...h, status: 'stale' } : h)),
      }));
      if (updated) {
        update(updated);
        return updated;
      }
    }
  }
  return c;
}
function update(c: Conversation) {
  emit(c.orgId, c.userId, { type: 'conversation.updated', conversationId: c.id, data: c });
}
export function cancel(id: string) {
  classifiers.get(id)?.abort();
  generators.get(id)?.abort();
  classifiers.delete(id);
  generators.delete(id);
}
export async function createConversation(user: SessionUser, modelId?: string) {
  return store.withLock('active-conversation-capacity', async () => {
    const registry = await models(user.orgId);
    const selected = modelId
      ? registry.find((m) => m.id === modelId && m.enabled)
      : registry.find((m) => m.enabled && m.isDefault) || registry.find((m) => m.enabled);
    if (!selected) throw new BadRequestException('Выберите доступную модель');
    const history = await store.list<Conversation>(user.orgId, 'conversation');
    for (const prev of history.filter((c) => c.userId === user.id && c.status === 'active'))
      await finish(user, prev.id);
    let active = 0;
    for (const org of await store.organizations())
      active += (await store.list<Conversation>(org, 'conversation')).filter(
        (c) => c.status === 'active',
      ).length;
    if (active >= 10) throw new BadRequestException('В пилоте доступны 10 одновременных диалогов');
    const c = newConversation(
      user.orgId,
      user.id,
      selected.id,
      `Клиент №${String(history.length + 1).padStart(2, '0')}`,
    );
    await store.put(user.orgId, 'conversation', c.id, c);
    update(c);
    return c;
  });
}
export async function finish(user: SessionUser, id: string) {
  await requireConversation(user, id, true);
  cancel(id);
  const c = await store.mutateConversation(user.orgId, id, (v) => ({
    ...invalidate(v),
    status: 'completed',
    endedAt: new Date().toISOString(),
  }));
  if (c) update(c);
  return c;
}
export async function addSegment(user: SessionUser, id: string, segment: TranscriptSegment) {
  const current = await requireConversation(user, id, true);
  if (current.status !== 'active') throw new BadRequestException('Разговор завершён');
  const meaningful =
    eligibleSegments([segment]).length > 0 &&
    !/^(м[мх]+|э[эм]+)[.!?\s]*$/i.test(segment.text.trim());
  const c = await store.mutateConversation(user.orgId, id, (v) => {
    if (v.status !== 'active' || v.segments.some((s) => s.id === segment.id)) return null;
    const next = meaningful ? invalidate(v) : v;
    next.segments = [...v.segments, { ...segment, text: maskPII(segment.text) }].slice(-1000);
    next.error = null;
    return next;
  });
  if (!c) return current;
  if (meaningful) cancel(id);
  update(c);
  if (meaningful) void classifyLatest(user, c).catch((e) => recordError(user, id, e));
  return c;
}
export async function editSegment(
  user: SessionUser,
  id: string,
  segmentId: string,
  patch: { text?: string; role?: TranscriptSegment['role']; excluded?: boolean },
) {
  await requireConversation(user, id, true);
  cancel(id);
  const c = await store.mutateConversation(user.orgId, id, (v) => {
    if (v.status !== 'active') throw new BadRequestException('Разговор завершён');
    if (!v.segments.some((s) => s.id === segmentId)) throw new NotFoundException();
    const n = invalidate(v);
    n.segments = n.segments.map((s) =>
      s.id === segmentId
        ? { ...s, ...patch, text: maskPII(patch.text ?? s.text), confidence: 1 }
        : s,
    );
    n.card.facts = [];
    n.card.classificationSource = null;
    n.card.intent = 'unknown';
    n.card.needs = [];
    n.card.objections = [];
    n.card.missing = [];
    return n;
  });
  if (c) {
    update(c);
    void classifyLatest(user, c).catch((e) => recordError(user, id, e));
  }
  return c;
}
async function recordError(user: SessionUser, id: string, error: unknown) {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    return;
  const c = await store.mutateConversation(user.orgId, id, (v) =>
    v.status === 'active'
      ? { ...v, error: error instanceof Error ? error.message : 'Не удалось обработать запрос' }
      : null,
  );
  if (c) update(c);
}
async function classifyLatest(user: SessionUser, snapshot: Conversation) {
  const controller = new AbortController();
  classifiers.set(snapshot.id, controller);
  try {
    const docs = (await store.list<KnowledgeDocument>(user.orgId, 'document')).filter((d) =>
      isPublished(d, user.orgId),
    );
    const result = await classify(snapshot, docs, controller.signal);
    if (controller.signal.aborted) return;
    const c = await store.mutateConversation(user.orgId, snapshot.id, (v) => {
      if (
        v.status !== 'active' ||
        v.card.revision !== snapshot.card.revision ||
        v.generationEpoch !== snapshot.generationEpoch
      )
        return null;
      const next = invalidate(v);
      next.card = applyPatch(next.card, result.patch, v.segments, result.source);
      next.card.activeProcessId =
        docs.find((d) => d.intent === next.card.intent && d.type === 'process')?.id || null;
      return { ...next, error: null };
    });
    if (!c) return;
    update(c);
    await store.put(user.orgId, 'usage', randomUUID(), {
      conversationId: c.id,
      type: 'classification',
      model: result.source === 'kev' ? config.classifier : config.fallback,
      ...result.usage,
      at: new Date().toISOString(),
    });
    if (c.autoHints && (result.patch.shouldHint || findUrgent(c, docs)))
      await makeHint(user, c.id, '', false);
  } finally {
    if (classifiers.get(snapshot.id) === controller) classifiers.delete(snapshot.id);
  }
}
export async function configureConversation(
  user: SessionUser,
  id: string,
  patch: {
    modelId?: string;
    autoHints?: boolean;
    region?: string;
    completedStep?: string;
    intent?: string;
    label?: string;
  },
) {
  await requireConversation(user, id, true);
  if (patch.modelId && !(await models(user.orgId)).some((m) => m.id === patch.modelId && m.enabled))
    throw new BadRequestException('Модель недоступна');
  const docs = await store.list<KnowledgeDocument>(user.orgId, 'document');
  if (
    patch.completedStep &&
    !docs.some(
      (d) => isPublished(d, user.orgId) && d.blocks.some((b) => b.id === patch.completedStep),
    )
  )
    throw new BadRequestException('Шаг не найден');
  if (
    patch.intent &&
    patch.intent !== 'unknown' &&
    !docs.some((d) => isPublished(d, user.orgId) && d.intent === patch.intent)
  )
    throw new BadRequestException('Неизвестное намерение');
  cancel(id);
  const c = await store.mutateConversation(user.orgId, id, (v) => {
    if (v.status !== 'active') throw new BadRequestException('Разговор завершён');
    const n = invalidate(v);
    if (patch.modelId) n.modelId = patch.modelId;
    if (patch.autoHints !== undefined) n.autoHints = patch.autoHints;
    if (patch.label) n.card.label = patch.label;
    if (patch.region) n.region = patch.region;
    if (patch.intent) {
      n.card.intent = patch.intent;
      n.card.classificationSource = 'manual';
      const d = docs.find((d) => d.intent === patch.intent);
      n.card.direction = d?.direction || 'unknown';
    }
    if (patch.completedStep)
      n.card.completedSteps = [...new Set([...n.card.completedSteps, patch.completedStep])];
    return n;
  });
  if (c) update(c);
  if (c && patch.completedStep) {
    await makeHint(user, id, '', true);
    return requireConversation(user, id, true);
  }
  return c;
}
export async function makeHint(
  user: SessionUser,
  id: string,
  question = '',
  manual = true,
): Promise<Hint | null> {
  const c = await requireConversation(user, id, true);
  if (c.status !== 'active') throw new BadRequestException('Разговор завершён');
  if (!(await models(user.orgId)).some((m) => m.id === c.modelId && m.enabled))
    throw new BadRequestException('Модель отключена администратором');
  const urgent = !manual
    ? findUrgent(c, await store.list<KnowledgeDocument>(user.orgId, 'document'))
    : undefined;
  if (!manual && !urgent && Date.now() - c.lastAutoHintAt < 8000) return null;
  generators.get(id)?.abort();
  const controller = new AbortController();
  generators.set(id, controller);
  const start = Date.now();
  try {
    const query = [
      c.card.intent,
      ...c.card.secondaryIntents,
      ...c.card.needs,
      eligibleSegments(c.segments).at(-1)?.text || '',
      question,
    ].join(' ');
    const docs = urgent ? [urgent.document] : await retrieve(user.orgId, query, c.region);
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          org: user.orgId,
          context: compactContext(c.card, c.segments),
          model: c.modelId,
          question,
          versions: docs.map((d) => [d.id, d.version]),
        }),
      )
      .digest('hex');
    const cached = redis ? await redis.get(`hint:${user.orgId}:${id}:${hash}`) : null;
    const selected = urgent
      ? {
          selection: [{ documentId: urgent.document.id, blockId: urgent.blockId }],
          inputTokens: 0,
          outputTokens: 0,
        }
      : cached
        ? (JSON.parse(cached) as Awaited<ReturnType<typeof selectEvidence>>)
        : await selectEvidence(c, docs, question, controller.signal);
    if (!cached && redis)
      await redis.set(`hint:${user.orgId}:${id}:${hash}`, JSON.stringify(selected), 'EX', 60);
    if (controller.signal.aborted) return null;
    return await store.withLock(`${user.orgId}:knowledge`, async () => {
      if (controller.signal.aborted) return null;
      if (!(await models(user.orgId)).some((m) => m.id === c.modelId && m.enabled)) return null;
      const latest = await store.list<KnowledgeDocument>(user.orgId, 'document');
      // Restrict to the exact retrieved version, then re-check publication after model latency.
      const valid = latest
        .filter((d) => docs.some((old) => old.id === d.id && old.version === d.version))
        .map((d) => ({
          ...d,
          blocks: d.blocks.filter((b) =>
            docs.some((old) => old.id === d.id && old.blocks.some((x) => x.id === b.id)),
          ),
        }));
      const refs = verifiedEvidence(
        selected.selection.slice(0, question ? 3 : 1),
        valid,
        user.orgId,
        c.card,
        c.region,
      );
      const hint = renderHint(c.card, refs, c.modelId, {
        latencyMs: Date.now() - start,
        inputTokens: cached ? 0 : selected.inputTokens,
        outputTokens: cached ? 0 : selected.outputTokens,
      });
      const updated = await store.mutateConversation(user.orgId, id, (v) => {
        if (
          v.status !== 'active' ||
          v.card.revision !== c.card.revision ||
          v.generationEpoch !== c.generationEpoch
        )
          return null;
        if (!manual && v.hints.some((h) => h.status === 'current' && h.text === hint.text))
          return null;
        const message = question
          ? [
              {
                id: randomUUID(),
                role: 'user' as const,
                text: maskPII(question),
                createdAt: new Date().toISOString(),
              },
              {
                id: hint.id,
                role: 'assistant' as const,
                text: hint.text,
                hint,
                createdAt: new Date().toISOString(),
              },
            ]
          : [];
        const offers = refs
          .filter((ref) =>
            valid.some((d) => d.blocks.some((b) => b.id === ref.blockId && b.kind === 'offer')),
          )
          .map((ref) => ref.blockId);
        return {
          ...v,
          card: { ...v.card, shownOffers: [...new Set([...v.card.shownOffers, ...offers])] },
          hints: [...v.hints.map((h) => ({ ...h, status: 'stale' as const })), hint].slice(-100),
          messages: [...v.messages, ...message].slice(-100),
          lastAutoHintAt: manual ? v.lastAutoHintAt : Date.now(),
          error: null,
        };
      });
      if (!updated) return null;
      update(updated);
      return hint;
    });
  } catch (e) {
    if (controller.signal.aborted) return null;
    await recordError(user, id, e);
    throw e;
  } finally {
    if (generators.get(id) === controller) generators.delete(id);
  }
}

function findUrgent(c: Conversation, docs: KnowledgeDocument[]) {
  if (c.card.intent === 'unknown') return;
  for (const d of docs.filter(
    (d) =>
      isPublished(d, c.orgId) &&
      d.intent === c.card.intent &&
      (d.region === 'Все регионы' || d.region === c.region),
  )) {
    const b = d.blocks.find(
      (b) =>
        b.urgent &&
        !c.card.completedSteps.includes(b.id) &&
        b.requiredFacts.every((id) => c.card.completedSteps.includes(id)) &&
        !c.hints.some((h) =>
          h.blocks.some(
            (ref) => ref.documentId === d.id && ref.version === d.version && ref.blockId === b.id,
          ),
        ),
    );
    if (b) return { document: d, blockId: b.id };
  }
}
