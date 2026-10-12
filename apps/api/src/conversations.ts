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
import { classify, selectEvidence, providerError, inferSpeakerRoles } from './ai';
import { retrieve, scriptSources } from './knowledge';
import { redis } from './infra';
import { config } from './config';
import { getPrompts } from './prompts';
import { getClassification, classificationIntents } from './classification';
import { assistantResponse } from './ai';
import { renderAssistantParts } from './assistant-render';
import { ensureSession, sessionKey, finishWorkingSession } from './working-sessions';

const autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
const analysisJobs = new Map<string, { promise: Promise<void> }>();
const pendingAnalysis = new Set<string>();
const roleJobs = new Map<string, AbortController>();
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
  pendingAnalysis.delete(id);
  analysisJobs.delete(id);
  clearTimeout(autoTimers.get(id));
  autoTimers.delete(id);
  classifiers.get(id)?.abort();
  generators.get(id)?.abort();
  classifiers.delete(id);
  generators.delete(id);
}
export async function createConversation(user: SessionUser, modelId?: string, previousId?: string) {
  if (previousId) {
    const old = await requireConversation(user, previousId, true);
    const ws = await ensureSession(user, old);
    const { switchClient } = await import('./working-sessions');
    const result = await switchClient(user, ws.id);
    if (!result) throw new BadRequestException('Смена уже выполняется');
    return result.conversation;
  }
  return store.withLock('active-conversation-capacity', async () => {
    const previous = previousId ? await requireConversation(user, previousId, true) : null;
    if (previous && previous.status !== 'active') throw new BadRequestException('Сессия завершена');
    const registry = await models(user.orgId);
    const selected = modelId
      ? registry.find((m) => m.id === modelId && m.enabled)
      : registry.find((m) => m.enabled && m.isDefault) || registry.find((m) => m.enabled);
    if (!selected) throw new BadRequestException('Выберите доступную модель');
    const history = await store.list<Conversation>(user.orgId, 'conversation');
    for (const prev of history.filter((c) => c.userId === user.id && c.status === 'active'))
      await finishWorkingSession(user, (await ensureSession(user, prev)).id);
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
    c.sessionId = previous?.sessionId || previous?.id || c.id;
    c.audioStartMs = 0;
    c.assistanceMode = config.defaultAssistanceMode;
    await store.put(user.orgId, 'conversation', c.id, c);
    await ensureSession(user, c);
    update(c);
    return c;
  });
}
export async function finish(user: SessionUser, id: string) {
  const previous = await requireConversation(user, id, true);
  const sid = previous.sessionId || previous.id;
  await store.withLock(sessionKey(user.orgId, sid), async () => {
    const ws = await store.get<import('@sufler/shared').WorkingSession>(
      user.orgId,
      'work-session',
      sid,
    );
    if (ws?.activeId === id)
      await store.put(user.orgId, 'work-session', sid, {
        ...ws,
        status: 'completed',
        revision: ws.revision + 1,
      });
  });
  cancel(id);
  roleJobs.get(id)?.abort();
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
  if (segment.role === 'unknown' && segment.roleInference && !segment.ambiguous)
    segment = { ...segment, excluded: false };
  const known = current.speakerRoles?.[segment.speakerId];
  if (known && !segment.ambiguous)
    segment = { ...segment, role: known.role, excluded: known.role === 'bystander' };
  let meaningful =
    eligibleSegments([segment]).length > 0 &&
    !/^(м[мх]+|э[эм]+)[.!?\s]*$/i.test(segment.text.trim());
  const c = await store.mutateConversation(user.orgId, id, (v) => {
    if (v.status !== 'active' || v.segments.some((s) => s.id === segment.id)) return null;
    const assigned = v.speakerRoles?.[segment.speakerId];
    if (assigned && !segment.ambiguous)
      segment = {
        ...segment,
        role: assigned.role,
        excluded: ['unknown', 'bystander'].includes(assigned.role),
      };
    meaningful =
      eligibleSegments([segment]).length > 0 &&
      !/^(м[мх]+|э[эм]+)[.!?\s]*$/i.test(segment.text.trim());

    // Append-only speech must not cancel a completed-prefix analysis. Corrections still invalidate.
    const next = { ...v };
    const prior =
      meaningful && segment.speakerId !== 'manual'
        ? v.segments.map((s) =>
            s.speakerId === segment.speakerId && s.role === 'unknown' && !s.ambiguous
              ? { ...s, role: segment.role, excluded: false }
              : s,
          )
        : v.segments;
    const recovered = prior.map((s) =>
      s.role === 'unknown' &&
      s.roleInference &&
      !s.ambiguous &&
      v.speakerRoles?.[s.speakerId]?.source !== 'manual'
        ? { ...s, excluded: false }
        : s,
    );
    next.segments = [...recovered, { ...segment, text: maskPII(segment.text) }];
    next.error = null;
    next.lastConfirmedAt = new Date().toISOString();
    return next;
  });
  if (!c) return current;
  update(c);
  if (segment.roleInference && segment.role === 'unknown' && !segment.ambiguous)
    void resolveRoles(user, id).catch((e) => recordError(user, id, e));
  if (meaningful) scheduleAnalysis(user, id);
  return c;
}
async function resolveRoles(user: SessionUser, id: string) {
  if (roleJobs.has(id)) return;
  const controller = new AbortController();
  roleJobs.set(id, controller);
  try {
    let observed = '';
    while (!controller.signal.aborted) {
      const snapshot = await requireConversation(user, id, true);
      const latestId = snapshot.segments.at(-1)?.id || '';
      if (snapshot.status !== 'active' || latestId === observed) break;
      observed = latestId;
      const roles = await inferSpeakerRoles(snapshot, controller.signal);
      if (controller.signal.aborted) break;
      const c = await store.mutateConversation(user.orgId, id, (v) => {
        if (v.status !== 'active') return null;
        const accepted = Object.fromEntries(
          Object.entries(roles).filter(
            ([speaker, role]) =>
              v.speakerRoles?.[speaker]?.source !== 'manual' &&
              v.speakerRoles?.[speaker]?.role !== role.role,
          ),
        );
        if (!Object.keys(accepted).length) return null;
        const next = invalidate(v);
        next.speakerRoles = { ...v.speakerRoles, ...accepted };
        next.segments = next.segments.map((s) => {
          const match = accepted[s.speakerId];
          return match && s.roleInference && !s.ambiguous
            ? { ...s, role: match.role, excluded: match.role === 'bystander' }
            : s;
        });
        return next;
      });
      if (c) {
        cancel(id);
        update(c);
        scheduleAnalysis(user, id);
      }
    }
  } finally {
    if (roleJobs.get(id) === controller) roleJobs.delete(id);
  }
}
export async function assignSpeaker(
  user: SessionUser,
  id: string,
  speakerId: string,
  role: 'customer' | 'consultant' | 'bystander',
) {
  await requireConversation(user, id, true);
  cancel(id);
  const c = await store.mutateConversation(user.orgId, id, (v) => {
    if (v.status !== 'active') return null;
    const next = invalidate(v);
    next.speakerRoles = {
      ...v.speakerRoles,
      [speakerId]: { role, source: 'manual', confidence: 1 },
    };
    next.segments = next.segments.map((segment) =>
      segment.speakerId === speakerId && !segment.ambiguous
        ? { ...segment, role, excluded: role === 'bystander', confidence: 1 }
        : segment,
    );
    next.card.labels = [];
    next.card.facts = [];
    next.card.classificationSource = null;
    return next;
  });
  if (c) {
    update(c);
    scheduleAnalysis(user, id);
  }
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
    const edited = v.segments.find((s) => s.id === segmentId)!;
    if (patch.role && edited.speakerId !== 'manual') {
      n.speakerRoles = {
        ...v.speakerRoles,
        [edited.speakerId]: { role: patch.role, source: 'manual', confidence: 1 },
      };
      n.segments = n.segments.map((s) =>
        s.speakerId === edited.speakerId && !s.ambiguous
          ? {
              ...s,
              role: patch.role!,
              excluded: ['unknown', 'bystander'].includes(patch.role!),
              roleInference: false,
            }
          : s,
      );
    }
    n.card.facts = [];
    n.card.labels = [];
    n.card.classificationSource = null;
    n.card.intent = 'unknown';
    n.card.needs = [];
    n.card.objections = [];
    n.card.missing = [];
    return n;
  });
  if (c) {
    update(c);
    scheduleAnalysis(user, id);
  }
  return c;
}
async function recordError(user: SessionUser, id: string, error: unknown) {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    return;
  const c = await store.mutateConversation(user.orgId, id, (v) =>
    v.status === 'active' ? { ...v, error: providerError(error) } : null,
  );
  if (c) update(c);
}
export async function reclassify(user: SessionUser, c: Conversation) {
  if (c.mergedInto || !c.segments.length) return;
  if (c.status === 'active') await scheduleAnalysis(user, c.id);
  else await classifyLatest(user, c, true);
}
// One pipeline per conversation. New ASR fragments coalesce into the next snapshot;
// model switches, corrections and client boundaries explicitly cancel the job.
function scheduleAnalysis(user: SessionUser, id: string) {
  pendingAnalysis.add(id);
  const existing = analysisJobs.get(id);
  if (existing) return existing.promise;
  const job = { promise: Promise.resolve() };
  analysisJobs.set(id, job);
  job.promise = (async () => {
    try {
      while (analysisJobs.get(id) === job && pendingAnalysis.delete(id)) {
        const latest = await requireConversation(user, id, true);
        if (analysisJobs.get(id) !== job || latest.status !== 'active') break;
        try {
          await classifyLatest(user, latest);
        } catch (e) {
          if (analysisJobs.get(id) === job) await recordError(user, id, e);
        }
      }
    } finally {
      if (analysisJobs.get(id) === job) analysisJobs.delete(id);
    }
  })().catch((e) => recordError(user, id, e));
  return job.promise;
}
async function classifyLatest(user: SessionUser, snapshot: Conversation, historical = false) {
  const controller = new AbortController();
  classifiers.set(snapshot.id, controller);
  let statusMessage = '';
  const status = (message: string, pending = true) => {
    statusMessage = message;
    if (!controller.signal.aborted)
      emit(user.orgId, user.id, {
        type: 'context.status',
        conversationId: snapshot.id,
        data: { message, pending },
      });
  };
  status('Decision Model · анализируем подтверждённую реплику…');
  try {
    const docs = (await store.list<KnowledgeDocument>(user.orgId, 'document')).filter(
      (d) =>
        isPublished(d, user.orgId) &&
        ((snapshot.assistanceMode || config.defaultAssistanceMode) !== 'scripts' ||
          (d.direction === 'sales' && d.intent !== 'sales_best_practices')),
    );
    let result;
    try {
      result = await classify(snapshot, docs, controller.signal, 'pipeline', (reason) =>
        status(`Decision Model не подтвердил контекст: ${reason}. Проверяем резервную LLM…`),
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      status(`Контекст не обновлён: ${providerError(error)}`);
      // Sales advice can use confirmed speech even if classification fails.
      if (
        !historical &&
        snapshot.autoHints &&
        (snapshot.assistanceMode || config.defaultAssistanceMode) === 'scripts' &&
        !controller.signal.aborted
      ) {
        const latest = await requireConversation(user, snapshot.id, true);
        if (latest.generationEpoch === snapshot.generationEpoch)
          await makeHint(user, snapshot.id, '', !!latest.salesScriptId).catch(() => null);
      }
      throw error;
    }
    if (controller.signal.aborted) return;
    if (
      result.settingsRevision !== undefined &&
      (await getClassification(user.orgId)).revision !== result.settingsRevision
    ) {
      pendingAnalysis.add(snapshot.id);
      return;
    }
    const c = await store.mutateConversation(user.orgId, snapshot.id, (v) => {
      if (
        (v.status !== 'active' && !historical) ||
        v.card.revision !== snapshot.card.revision ||
        v.generationEpoch !== snapshot.generationEpoch
      )
        return null;
      const next = invalidate(v);
      next.card = applyPatch(next.card, result.patch, snapshot.segments, result.source);
      const pinned =
        (v.assistanceMode || config.defaultAssistanceMode) === 'scripts' && v.salesScriptId
          ? docs.find((d) => d.id === v.salesScriptId && d.direction === 'sales')
          : undefined;
      if (pinned) {
        next.card.intent = pinned.intent;
        next.card.direction = 'sales';
      }
      if (pinned) next.card.intentLabel = pinned.title;
      next.card.activeProcessId =
        pinned?.id ||
        docs.find((d) => d.intent === next.card.intent && d.type === 'process')?.id ||
        null;
      return { ...next, error: null };
    });
    if (!c) return;
    status(
      `Контекст обновлён · ${result.source === 'decision' ? 'Alibaba Decision Model' : result.source === 'qwen' ? 'резервная LLM' : 'демо'}`,
    );
    update(c);
    await store.put(user.orgId, 'usage', randomUUID(), {
      conversationId: c.id,
      type: 'classification',
      model: result.source === 'decision' ? config.classifier : config.fallback,
      ...result.usage,
      at: new Date().toISOString(),
    });
    if (
      !historical &&
      c.autoHints &&
      (result.patch.shouldHint ||
        classifierContextChanged(snapshot.card.labels, c.card.labels) ||
        findUrgent(c, docs) ||
        ((c.assistanceMode || config.defaultAssistanceMode) === 'scripts' && !c.salesScriptId))
    )
      await makeHint(user, c.id, '', false);
  } finally {
    if (classifiers.get(snapshot.id) === controller) {
      status(statusMessage, false);
      classifiers.delete(snapshot.id);
    }
  }
}
function classifierContextChanged(
  before: Conversation['card']['labels'],
  after: Conversation['card']['labels'],
) {
  const values = (labels: Conversation['card']['labels']) =>
    (labels || [])
      .filter((v) => v.value !== 'unknown')
      .map((v) => [v.key, v.value])
      .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(values(before)) !== JSON.stringify(values(after));
}
export async function configureConversation(
  user: SessionUser,
  id: string,
  patch: {
    modelId?: string;
    assistanceMode?: 'rag' | 'scripts';
    salesScriptId?: string | null;
    autoHints?: boolean;
    region?: string;
    completedStep?: string;
    intent?: string;
    label?: string;
  },
) {
  const current = await requireConversation(user, id, true);
  const classification = await getClassification(user.orgId);
  if (patch.assistanceMode === 'rag' && !config.ragEnabled)
    throw new BadRequestException('RAG отключён на этом сервере');
  if (patch.modelId && !(await models(user.orgId)).some((m) => m.id === patch.modelId && m.enabled))
    throw new BadRequestException('Модель недоступна');
  const docs = await store.list<KnowledgeDocument>(user.orgId, 'document');
  const selectedScript = patch.salesScriptId
    ? docs.find(
        (d) =>
          d.id === patch.salesScriptId &&
          d.type === 'process' &&
          d.direction === 'sales' &&
          isPublished(d, user.orgId) &&
          (d.region === 'Все регионы' ||
            d.region === (patch.region || current.region || 'Все регионы')),
      )
    : undefined;
  if (patch.salesScriptId && !selectedScript)
    throw new BadRequestException('Выберите опубликованный скрипт продаж своего региона');
  if (
    patch.completedStep &&
    (current.assistanceMode || config.defaultAssistanceMode) === 'scripts'
  ) {
    const sources = await scriptSources(current);
    const nextStep = sources
      .find((d) => d.type === 'process')
      ?.blocks.find((b) => b.kind === 'step');
    if (
      nextStep?.id !== patch.completedStep ||
      !nextStep.requiredFacts.every((f) => current.card.completedSteps.includes(f))
    )
      throw new BadRequestException('Подтвердите текущий шаг скрипта');
  }
  if (
    patch.completedStep &&
    !docs.some(
      (d) => isPublished(d, user.orgId) && d.blocks.some((b) => b.id === patch.completedStep),
    )
  )
    throw new BadRequestException('Шаг не найден');
  const allowedIntents = classificationIntents(
    current,
    docs.filter((d) => isPublished(d, user.orgId)),
    classification,
  );
  if (patch.intent && patch.intent !== 'unknown' && !(patch.intent in allowedIntents))
    throw new BadRequestException('Неизвестное намерение');
  cancel(id);
  const c = await store.mutateConversation(user.orgId, id, (v) => {
    if (v.status !== 'active') throw new BadRequestException('Разговор завершён');
    const n = invalidate(v);
    if (patch.modelId) n.modelId = patch.modelId;
    if (patch.assistanceMode) n.assistanceMode = patch.assistanceMode;
    if (patch.salesScriptId !== undefined) {
      n.salesScriptId = patch.salesScriptId;
      n.card.activeProcessId = selectedScript?.id || null;
      n.card.completedSteps = [];
      n.card.shownOffers = [];
      if (selectedScript) {
        n.card.intent = selectedScript.intent;
        n.card.direction = 'sales';
      }
    }
    if (patch.autoHints !== undefined) n.autoHints = patch.autoHints;
    if (patch.label) n.card.label = patch.label;
    if (patch.region) n.region = patch.region;
    if (patch.intent) {
      n.card.intent = patch.intent;
      n.card.classificationSource = 'manual';
      const d = docs.find((d) => d.intent === patch.intent);
      const custom = classification.intents.find((i) => i.id === patch.intent && i.enabled);
      n.card.direction = custom?.direction || d?.direction || 'unknown';
      n.card.intentLabel = custom?.name || d?.title;
    }
    if (patch.completedStep)
      n.card.completedSteps = [...new Set([...n.card.completedSteps, patch.completedStep])];
    return n;
  });
  if (c) update(c);
  if (
    c &&
    c.segments.length &&
    !patch.intent &&
    (patch.autoHints === true || patch.modelId || patch.assistanceMode)
  )
    void scheduleAnalysis(user, id);
  if (c && (patch.completedStep || patch.salesScriptId !== undefined)) {
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
  const mode = c.assistanceMode || config.defaultAssistanceMode;
  const urgent = !manual
    ? findUrgent(
        c,
        mode === 'scripts'
          ? await scriptSources(c)
          : await store.list<KnowledgeDocument>(user.orgId, 'document'),
      )
    : undefined;
  if (!manual && !c.autoHints) return null;
  const remaining = 3000 - (Date.now() - c.lastAutoHintAt);
  if (!manual && !urgent && remaining > 0) {
    clearTimeout(autoTimers.get(id));
    autoTimers.set(
      id,
      setTimeout(() => {
        autoTimers.delete(id);
        void makeHint(user, id, '', false).catch(() => {});
      }, remaining + 10),
    );
    return null;
  }
  generators.get(id)?.abort();
  const controller = new AbortController();
  generators.set(id, controller);
  const start = Date.now();
  try {
    if (mode === 'scripts' && !c.salesScriptId)
      return await makeCoachingHint(user, c, question, manual, controller, start);
    const query = [
      c.card.intent,
      ...c.card.secondaryIntents,
      ...c.card.needs,
      eligibleSegments(c.segments).at(-1)?.text || '',
      question,
    ].join(' ');
    if (mode === 'rag' && !config.ragEnabled)
      throw new BadRequestException('Переключите диалог на продажи по скрипту');
    const docs = urgent
      ? [urgent.document]
      : mode === 'scripts'
        ? await scriptSources(c)
        : await retrieve(user.orgId, query, c.region);
    const scriptStep =
      mode === 'scripts' && !question
        ? docs
            .find((d) => d.type === 'process')
            ?.blocks.find(
              (b) =>
                b.kind === 'step' &&
                b.requiredFacts.every((f) => c.card.completedSteps.includes(f)),
            )
        : undefined;
    const scriptDoc = scriptStep
      ? docs.find((d) => d.blocks.some((b) => b.id === scriptStep.id))
      : undefined;
    const contextual = !question && !urgent && (!manual || !scriptStep);
    const prompts = contextual ? await getPrompts(user.orgId) : null;
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          policy: 'contextual-hint-v4',
          promptRevision: prompts?.revision,
          org: user.orgId,
          context: compactContext(c.card, c.segments),
          model: c.modelId,
          mode,
          script: c.salesScriptId,
          question,
          versions: docs.map((d) => [d.id, d.version]),
        }),
      )
      .digest('hex');
    const cached = redis ? await redis.get(`hint:${user.orgId}:${id}:${hash}`) : null;
    type Selection = Awaited<ReturnType<typeof selectEvidence>> & {
      parts?: Awaited<ReturnType<typeof assistantResponse>>['parts'];
    };
    let selected: Selection;
    if (contextual && prompts && !cached) {
      const candidates = scriptStep && scriptDoc ? [{ ...scriptDoc, blocks: [scriptStep] }] : docs;
      const generated = await assistantResponse(
        c,
        '',
        prompts.hintPrompt,
        candidates,
        controller.signal,
        undefined,
        'hint',
      );
      selected = {
        ...generated,
        selection: generated.parts
          .filter((p) => p.kind === 'source')
          .map((p) => ({ documentId: p.documentId || '', blockId: p.blockId || '' })),
      };
    } else
      selected = urgent
        ? {
            selection: [{ documentId: urgent.document.id, blockId: urgent.blockId }],
            inputTokens: 0,
            outputTokens: 0,
          }
        : cached
          ? (JSON.parse(cached) as Selection)
          : scriptStep && scriptDoc
            ? {
                selection: [{ documentId: scriptDoc.id, blockId: scriptStep.id }],
                inputTokens: 0,
                outputTokens: 0,
              }
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
      const rendered = selected.parts ? renderAssistantParts(c, valid, selected.parts) : null;
      if (rendered && !rendered.text)
        throw new BadRequestException('Подсказка не прошла проверку источников. Уточните вопрос.');
      if (prompts && (await getPrompts(user.orgId)).revision !== prompts.revision) return null;
      const hint = renderHint(c.card, refs, c.modelId, {
        ...(rendered?.text
          ? {
              text: rendered.text,
              blocks: rendered.references,
              kind: rendered.references.length
                ? c.card.direction === 'service'
                  ? ('service' as const)
                  : ('sales' as const)
                : ('coaching' as const),
            }
          : {}),
        ...(scriptStep ? { title: 'Следующий шаг скрипта' } : {}),
        latencyMs: Date.now() - start,
        pipelineLatencyMs:
          !config.demo && !manual && !question && c.lastConfirmedAt
            ? Math.max(0, Date.now() - Date.parse(c.lastConfirmedAt))
            : undefined,
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
          hints: [...v.hints.map((h) => ({ ...h, status: 'stale' as const })), hint],
          messages: [...v.messages, ...message],
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
    if (e instanceof BadRequestException) throw e;
    throw new BadRequestException(providerError(e));
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

async function makeCoachingHint(
  user: SessionUser,
  c: Conversation,
  question: string,
  manual: boolean,
  controller: AbortController,
  start: number,
) {
  const prompts = await getPrompts(user.orgId);
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        policy: 'contextual-coaching-v4',
        context: compactContext(c.card, c.segments),
        messages: question ? c.messages.slice(-6) : [],
        model: c.modelId,
        promptRevision: prompts.revision,
        instructions: question ? prompts.chatPrompt : prompts.hintPrompt,
        question,
        recentHints: c.hints.slice(-3).map((h) => h.text),
      }),
    )
    .digest('hex');
  const key = `coaching:${user.orgId}:${c.id}:${hash}`;
  const cached = redis ? await redis.get(key) : null;
  let advice: { text: string; inputTokens: number; outputTokens: number };
  if (cached) advice = JSON.parse(cached);
  else {
    const generated = await assistantResponse(
      c,
      question,
      question ? prompts.chatPrompt : prompts.hintPrompt,
      [],
      controller.signal,
      undefined,
      question ? 'chat' : 'hint',
    );
    const rendered = renderAssistantParts(c, [], generated.parts);
    if (!rendered.text)
      throw new BadRequestException(
        'Подсказка содержит неподтверждённые условия. Уточните запрос.',
      );
    advice = {
      text: rendered.text,
      inputTokens: generated.inputTokens,
      outputTokens: generated.outputTokens,
    };
  }
  if (controller.signal.aborted) return null;
  if (!cached && redis) await redis.set(key, JSON.stringify(advice), 'EX', 60);
  return store.withLock(`${user.orgId}:prompts`, async () => {
    if (controller.signal.aborted || (await getPrompts(user.orgId)).revision !== prompts.revision)
      return null;
    if (!(await models(user.orgId)).some((m) => m.id === c.modelId && m.enabled)) return null;
    const hint: Hint = {
      id: randomUUID(),
      revision: c.card.revision,
      kind: 'coaching',
      title: 'Продажи по промпту',
      text: advice.text,
      blocks: [],
      modelId: c.modelId,
      createdAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
      pipelineLatencyMs:
        !config.demo && !manual && !question && c.lastConfirmedAt
          ? Math.max(0, Date.now() - Date.parse(c.lastConfirmedAt))
          : undefined,
      inputTokens: cached ? 0 : advice.inputTokens,
      outputTokens: cached ? 0 : advice.outputTokens,
      cost: null,
      status: 'current',
    };
    const updated = await store.mutateConversation(user.orgId, c.id, (v) => {
      if (
        v.status !== 'active' ||
        v.card.revision !== c.card.revision ||
        v.generationEpoch !== c.generationEpoch
      )
        return null;
      if (!manual && v.hints.some((h) => h.status === 'current' && h.text === hint.text))
        return null;
      return {
        ...v,
        hints: [...v.hints.map((h) => ({ ...h, status: 'stale' as const })), hint],
        messages: question
          ? [
              ...v.messages,
              {
                id: randomUUID(),
                role: 'user' as const,
                text: maskPII(question),
                createdAt: hint.createdAt,
              },
              {
                id: hint.id,
                role: 'assistant' as const,
                text: hint.text,
                hint,
                createdAt: hint.createdAt,
              },
            ]
          : v.messages,
        lastAutoHintAt: manual ? v.lastAutoHintAt : Date.now(),
        error: null,
      };
    });
    if (!updated) return null;
    update(updated);
    return hint;
  });
}
