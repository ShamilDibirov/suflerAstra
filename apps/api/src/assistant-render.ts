import type { Conversation, EvidenceRef, KnowledgeDocument } from '@sufler/shared';
import { eligibleSegments, verifiedEvidence } from '@sufler/shared/engine';
import { assistantResponse, validateCoaching } from './ai';

const escape = (text: string) => text.replace(/([\\`*_{}\[\]<>])/g, '\\$1');
export function renderAssistantParts(
  c: Conversation,
  docs: KnowledgeDocument[],
  parts: Awaited<ReturnType<typeof assistantResponse>>['parts'],
) {
  const references: EvidenceRef[] = [],
    text: string[] = [];
  for (const part of parts.slice(0, 12)) {
    if (part.kind === 'advice') {
      const safe = part.text
        .split(/\n\s*\n/)
        .map((p) => validateCoaching(p, true))
        .filter(Boolean)
        .join('\n\n');
      if (safe) text.push(safe);
    } else if (part.kind === 'context') {
      const turn = eligibleSegments(c.segments).find(
        (s) => s.id === part.segmentId && s.text.includes(part.text),
      );
      if (turn) text.push(`**В разговоре:**\n> ${escape(part.text)}`);
    } else {
      const refs = verifiedEvidence(
        [{ documentId: part.documentId || '', blockId: part.blockId || '' }],
        docs,
        c.orgId,
        c.card,
        c.region,
      );
      const ref = refs[0];
      if (!ref || !ref.quote.includes(part.text)) continue;
      text.push(
        `> ${escape(ref.quote)}` +
          (ref.catalogDate ? `\n\nКаталог от ${ref.catalogDate}. Наличие требует проверки.` : ''),
      );
      if (!references.some((r) => r.documentId === ref.documentId && r.blockId === ref.blockId))
        references.push(ref);
    }
  }
  return { text: text.join('\n\n').trim(), references };
}
