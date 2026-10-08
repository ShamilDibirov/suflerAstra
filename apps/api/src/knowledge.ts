import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { KnowledgeDocument, Conversation, SessionUser } from '@sufler/shared';
import { KnowledgeInput } from '@sufler/shared';
import { isPublished, maskPII } from '@sufler/shared/engine';
import { store } from './store';
import { config } from './config';
import { getFile } from './storage';
import { emit } from './events';

export async function knowledgeCall(path: string, body: unknown) {
  const r = await fetch(`${config.knowledge}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': config.internalToken },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`Сервис базы знаний: HTTP ${r.status}`);
  return r.json();
}
export async function saveDocument(user: SessionUser, input: unknown, id?: string) {
  return store.withLock(`${user.orgId}:knowledge`, async () => {
    const data = KnowledgeInput.parse(input);
    const prev = id ? await store.get<KnowledgeDocument>(user.orgId, 'document', id) : null;
    if (id && !prev) throw new NotFoundException();
    if (data.validFrom && data.validUntil && data.validFrom > data.validUntil)
      throw new BadRequestException('Проверьте даты действия');
    const now = new Date().toISOString();
    const documentId = id || randomUUID();
    const blocks = (
      data.blocks ||
      data.content
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((text) => ({ id: undefined, text, kind: 'step' as const, requiredFacts: [] }))
    ).map((b) => ({ ...b, id: b.id || randomUUID() }));
    if (new Set(blocks.map((b) => b.id)).size !== blocks.length)
      throw new BadRequestException('Идентификаторы шагов должны быть уникальными');
    if (prev) {
      const newIds = new Map(blocks.map((b) => [b.id, randomUUID()]));
      for (const b of blocks) {
        b.id = newIds.get(b.id)!;
        b.requiredFacts = b.requiredFacts.map((id) => newIds.get(id) || id);
      }
    }
    const doc: KnowledgeDocument = {
      ...data,
      id: documentId,
      orgId: user.orgId,
      blocks,
      status: 'draft',
      version: (prev?.version || 0) + 1,
      createdAt: prev?.createdAt || now,
      updatedAt: now,
      publishedAt: null,
      sourceName: prev?.sourceName || null,
      sourceKey: prev?.sourceKey || null,
      error: null,
      indexedVersion: null,
    };
    await store.put(user.orgId, 'document', documentId, doc);
    await invalidateDocumentHints(user.orgId, documentId);
    return doc;
  });
}
export async function publishDocument(
  user: SessionUser,
  id: string,
  status: 'review' | 'published' | 'archived',
) {
  const doc = await store.get<KnowledgeDocument>(user.orgId, 'document', id);
  if (!doc) throw new NotFoundException();
  if (doc.status === 'processing') throw new BadRequestException('Дождитесь обработки файла');
  if (status === 'published') {
    if (!doc.blocks.length || doc.blocks.some((b) => !b.text.trim()))
      throw new BadRequestException('Добавьте проверенные фрагменты');
    if (doc.blocks.some((b) => b.requiredFacts.some((f) => !doc.blocks.some((x) => x.id === f))))
      throw new BadRequestException('Зависимость шага не найдена');
    if (doc.validUntil && doc.validUntil < new Date().toISOString().slice(0, 10))
      throw new BadRequestException('Срок действия истёк');
    if (!config.demo && config.ragEnabled) await knowledgeCall('/index', { document: doc });
    doc.publishedAt = new Date().toISOString();
    doc.indexedVersion = config.ragEnabled ? doc.version : null;
  }
  return store.withLock(`${user.orgId}:knowledge`, async () => {
    const latest = await store.get<KnowledgeDocument>(user.orgId, 'document', id);
    if (!latest || latest.version !== doc.version || latest.updatedAt !== doc.updatedAt)
      throw new BadRequestException(
        'Документ изменился. Обновите страницу и повторите публикацию.',
      );
    doc.status = status;
    doc.updatedAt = new Date().toISOString();
    await store.put(user.orgId, 'document', id, doc);
    await invalidateDocumentHints(user.orgId, id);
    return doc;
  });
}
async function invalidateDocumentHints(org: string, id: string) {
  for (const c of await store.list<Conversation>(org, 'conversation'))
    if (c.status === 'active') {
      const updated = await store.mutateConversation(org, c.id, (v) => ({
        ...v,
        generationEpoch: v.generationEpoch + 1,
        hints: v.hints.map((h) =>
          h.blocks.some((b) => b.documentId === id) ? { ...h, status: 'stale' } : h,
        ),
      }));
      if (updated)
        emit(org, updated.userId, {
          type: 'conversation.updated',
          conversationId: updated.id,
          data: updated,
        });
    }
}
export async function retrieve(
  org: string,
  query: string,
  region = 'Все регионы',
): Promise<KnowledgeDocument[]> {
  const docs = (await store.list<KnowledgeDocument>(org, 'document')).filter(
    (d) => isPublished(d, org) && (d.region === 'Все регионы' || d.region === region),
  );
  if (config.demo) {
    const words = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((w) => w.length > 2);
    return docs
      .map((d) => ({
        doc: d,
        score: words.reduce(
          (score, w) =>
            score +
            ((d.title + ' ' + d.intent + ' ' + d.content).toLowerCase().includes(w) ? 1 : 0),
          0,
        ),
      }))
      .filter((v) => v.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((v) => v.doc);
  }
  if (!config.ragEnabled)
    throw new BadRequestException('RAG отключён. Выберите продажи по скрипту.');
  if (!docs.length) return [];
  const indexed = docs.filter((d) => d.indexedVersion === d.version);
  if (!indexed.length) return [];
  const result = (await knowledgeCall('/search', {
    orgId: org,
    query: maskPII(query).slice(0, 1000),
    region,
    versions: indexed.map((d) => ({ id: d.id, version: d.version })),
  })) as { results: { documentId: string; blockId: string; version: number }[] };
  return docs
    .map((d) => ({
      ...d,
      blocks: d.blocks.filter((b) =>
        result.results.some(
          (r) => r.documentId === d.id && r.version === d.version && r.blockId === b.id,
        ),
      ),
    }))
    .filter((d) => d.blocks.length);
}
export async function ingestDocument(org: string, id: string) {
  const doc = await store.get<KnowledgeDocument>(org, 'document', id);
  if (!doc?.sourceKey) return;
  try {
    const file = await getFile(doc.sourceKey);
    const result = (await knowledgeCall('/parse', {
      name: doc.sourceName,
      contentBase64: file.body.toString('base64'),
    })) as { text: string };
    if (!result.text.trim()) throw new Error('Не удалось извлечь текст');
    doc.content = result.text;
    doc.blocks = result.text
      .split(/\n\s*\n/)
      .filter(Boolean)
      .flatMap((text) => text.match(/[\s\S]{1,1800}/g) || [])
      .map((text) => ({ id: randomUUID(), text, kind: 'step', requiredFacts: [] }));
    doc.status = 'review';
    doc.error = null;
  } catch (e) {
    doc.status = 'failed';
    doc.error = e instanceof Error ? e.message : 'Ошибка обработки';
  }
  doc.updatedAt = new Date().toISOString();
  await store.put(org, 'document', id, doc);
}

/** Direct, bounded script selection. Never calls embeddings, search or file parsing. */
export async function scriptSources(c: Conversation): Promise<KnowledgeDocument[]> {
  const docs = (await store.list<KnowledgeDocument>(c.orgId, 'document')).filter(
    (d) =>
      isPublished(d, c.orgId) &&
      d.direction === 'sales' &&
      (d.region === 'Все регионы' || d.region === (c.region || 'Все регионы')),
  );
  const script = c.salesScriptId
    ? docs.find((d) => d.id === c.salesScriptId && d.type === 'process')
    : docs.find((d) => d.type === 'process' && d.intent === c.card.intent);
  const practices = docs
    .filter(
      (d) =>
        d.type === 'article' && (d.intent === 'sales_best_practices' || d.intent === c.card.intent),
    )
    .slice(0, 3);
  if (!script) return practices;
  const next = script.blocks.find(
    (b) => b.kind === 'step' && !c.card.completedSteps.includes(b.id),
  );
  return [
    { ...script, blocks: script.blocks.filter((b) => b.kind !== 'step' || b.id === next?.id) },
    ...practices,
  ];
}

export async function addSalesTemplates(user: SessionUser) {
  const existing = await store.list<KnowledgeDocument>(user.orgId, 'document');
  const templates = [
    {
      title: 'Базовый скрипт продажи',
      type: 'process' as const,
      intent: 'sales_discovery',
      paragraphs: [
        'Уточните, что клиент хочет решить: связь, интернет, устройство или аксессуар.',
        'Спросите, как клиент сейчас пользуется продуктом и что его не устраивает.',
        'Уточните бюджет и приоритет: цена, удобство или конкретная возможность.',
        'Предложите сравнить подходящие варианты по подтверждённым условиям. Не обещайте неизвестные цены и наличие.',
        'Уточните сомнения клиента и предложите следующий шаг без давления.',
      ],
    },
    {
      title: 'Практики консультации и работа с возражениями',
      type: 'article' as const,
      intent: 'sales_best_practices',
      paragraphs: [
        'Задавайте один открытый вопрос за раз и кратко проверяйте, правильно ли поняли потребность.',
        'При возражении о цене уточните, с чем клиент сравнивает предложение и что для него важнее.',
        'Привязывайте предложение к озвученной потребности. Не добавляйте ненужные услуги и не скрывайте ограничения.',
        'Если цена, срок действия, условия или наличие не подтверждены, предложите проверить их в системе оператора.',
      ],
    },
  ];
  const created = [];
  for (const template of templates) {
    if (existing.some((d) => d.intent === template.intent)) continue;
    created.push(
      await saveDocument(user, {
        ...template,
        direction: 'sales',
        description: 'Учебная заготовка. Проверьте и адаптируйте перед публикацией.',
        content: template.paragraphs.join('\n\n'),
        blocks: template.paragraphs.map((text) => ({
          text,
          kind: template.type === 'process' ? 'step' : 'question',
          requiredFacts: [],
        })),
      }),
    );
  }
  return created;
}
