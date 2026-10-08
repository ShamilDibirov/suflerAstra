import { randomUUID } from 'node:crypto';
import type {
  Conversation,
  ConversationCard,
  ConversationStatePatch,
  KnowledgeDocument,
  EvidenceRef,
  TranscriptSegment,
  Hint,
} from './index';
import { NO_EVIDENCE } from './index';

export function emptyCard(id: string, label = 'Новый клиент'): ConversationCard {
  return {
    id,
    label,
    revision: 0,
    direction: 'unknown',
    intent: 'unknown',
    secondaryIntents: [],
    stage: 'discovery',
    needs: [],
    objections: [],
    missing: [],
    facts: [],
    completedSteps: [],
    shownOffers: [],
    activeProcessId: null,
    ending: false,
    classificationSource: null,
    confidence: null,
    evidenceSegmentIds: [],
    updatedAt: new Date().toISOString(),
  };
}
export function newConversation(
  orgId: string,
  userId: string,
  modelId: string,
  label: string,
): Conversation {
  const id = randomUUID();
  return {
    id,
    orgId,
    userId,
    modelId,
    card: emptyCard(id, label),
    status: 'active',
    createdAt: new Date().toISOString(),
    endedAt: null,
    segments: [],
    hints: [],
    messages: [],
    autoHints: true,
    lastAutoHintAt: 0,
    generationEpoch: 0,
    error: null,
    recordings: [],
  };
}
export function eligibleSegments(segments: TranscriptSegment[]) {
  return segments.filter(
    (s) =>
      s.final &&
      !s.excluded &&
      s.confidence >= 0.7 &&
      (s.role === 'customer' || s.role === 'consultant'),
  );
}
export function maskPII(text: string): string {
  return text
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}\b/g, '[EMAIL]')
    .replace(/(?<!\d)(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g, '[ТЕЛЕФОН]')
    .replace(/(?<!\d)\d{4}\s+\d{6}(?!\d)/g, '[ДОКУМЕНТ]')
    .replace(/(?<!\d)(?:\d[ -]?){16}(?!\d)/g, '[НОМЕР]');
}
export function applyPatch(
  card: ConversationCard,
  patch: ConversationStatePatch,
  segments: TranscriptSegment[],
  source: ConversationCard['classificationSource'],
): ConversationCard {
  const allowed = eligibleSegments(segments);
  const facts = patch.facts.filter(
    (f) =>
      f.quote.includes(f.value) &&
      allowed.some((s) => s.id === f.segmentId && s.text.includes(f.quote)),
  );
  return {
    ...card,
    direction: patch.direction,
    intent: patch.intent,
    secondaryIntents: patch.secondaryIntents,
    stage: patch.stage,
    needs: patch.needs,
    objections: patch.objections,
    missing: patch.missing,
    facts,
    ending: patch.ending,
    classificationSource: source,
    confidence: patch.confidence,
    evidenceSegmentIds: allowed.slice(-8).map((s) => s.id),
    updatedAt: new Date().toISOString(),
  };
}
export function isPublished(doc: KnowledgeDocument, orgId: string, at = new Date()): boolean {
  const now = at.toISOString().slice(0, 10);
  return (
    doc.orgId === orgId &&
    doc.status === 'published' &&
    (!doc.validFrom || doc.validFrom <= now) &&
    (!doc.validUntil || doc.validUntil >= now)
  );
}
export function evidenceFor(doc: KnowledgeDocument, blockId: string): EvidenceRef | undefined {
  const block = doc.blocks.find((b) => b.id === blockId);
  if (!block) return;
  return {
    documentId: doc.id,
    version: doc.version,
    blockId,
    title: doc.title,
    quote: block.text,
    region: doc.region,
    ...(doc.type === 'catalog'
      ? { catalogDate: (doc.publishedAt || doc.updatedAt).slice(0, 10) }
      : {}),
  };
}
export function verifiedEvidence(
  selection: { documentId: string; blockId: string }[],
  docs: KnowledgeDocument[],
  orgId: string,
  card: ConversationCard,
  region = 'Все регионы',
): EvidenceRef[] {
  const seen = new Set<string>();
  const refs: EvidenceRef[] = [];
  for (const item of selection.slice(0, 3)) {
    const doc = docs.find(
      (d) =>
        d.id === item.documentId &&
        isPublished(d, orgId) &&
        (d.region === 'Все регионы' || d.region === region),
    );
    const block = doc?.blocks.find((b) => b.id === item.blockId);
    if (
      !doc ||
      !block ||
      seen.has(block.id) ||
      (block.kind === 'step' && card.completedSteps.includes(block.id))
    )
      continue;
    // Prerequisites are explicit consultant confirmations, never inferred from a spoken promise.
    if (block.requiredFacts.some((f) => !card.completedSteps.includes(f))) continue;
    seen.add(block.id);
    refs.push(evidenceFor(doc, block.id)!);
  }
  return refs;
}
export function renderHint(
  card: ConversationCard,
  refs: EvidenceRef[],
  modelId: string,
  extra: Partial<Hint> = {},
): Hint {
  const sales = card.direction === 'sales' || card.stage === 'offer';
  return {
    id: randomUUID(),
    revision: card.revision,
    kind: refs.length ? (sales ? 'sales' : 'service') : 'no_evidence',
    title: refs.length ? (sales ? 'Подходящее предложение' : 'Следующий шаг') : 'Нужно уточнение',
    text: refs.length
      ? refs
          .map(
            (r) =>
              r.quote +
              (r.catalogDate ? `\nКаталог от ${r.catalogDate}. Наличие требует проверки.` : ''),
          )
          .join('\n\n')
      : NO_EVIDENCE,
    blocks: refs,
    modelId,
    createdAt: new Date().toISOString(),
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: null,
    status: 'current',
    ...extra,
  };
}
export function invalidate(conversation: Conversation): Conversation {
  return {
    ...conversation,
    generationEpoch: conversation.generationEpoch + 1,
    card: {
      ...conversation.card,
      revision: conversation.card.revision + 1,
      updatedAt: new Date().toISOString(),
    },
    hints: conversation.hints.map((h) => ({ ...h, status: 'stale' as const })),
  };
}
export function compactContext(
  card: ConversationCard,
  segments: TranscriptSegment[],
  limit = 5200,
) {
  const recent = eligibleSegments(segments)
    .slice(-6)
    .map((s) => ({ id: s.id, role: s.role, text: maskPII(s.text).slice(0, 550) }));
  return JSON.stringify({
    card: {
      direction: card.direction,
      intent: card.intent,
      secondaryIntents: card.secondaryIntents,
      stage: card.stage,
      needs: card.needs,
      missing: card.missing,
      facts: card.facts,
      completedSteps: card.completedSteps,
      ending: card.ending,
    },
    recent,
  }).slice(0, limit);
}
