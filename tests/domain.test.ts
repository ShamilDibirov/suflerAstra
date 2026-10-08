import { describe, it, expect } from 'vitest';
import { SegmentSchema, PatchSchema, NO_EVIDENCE } from '../packages/shared/src/index';
import {
  emptyCard,
  applyPatch,
  eligibleSegments,
  verifiedEvidence,
  renderHint,
  isPublished,
  maskPII,
  invalidate,
  newConversation,
} from '../packages/shared/src/engine';
import { demoDocuments } from '../packages/shared/src/demo';
const segment = (patch = {}) =>
  SegmentSchema.parse({
    id: 's1',
    text: 'Мне нужен Nord A1 до 20000 рублей.',
    role: 'customer',
    createdAt: new Date().toISOString(),
    ...patch,
  });
const patch = (values = {}) =>
  PatchSchema.parse({
    direction: 'sales',
    intent: 'devices',
    stage: 'discovery',
    shouldHint: true,
    confidence: 0.95,
    ...values,
  });
describe('evidence and conversation invariants', () => {
  it('includes only assigned, final, confident speech', () => {
    const list = [
      segment(),
      segment({ id: 's2', role: 'bystander' }),
      segment({ id: 's3', role: 'unknown' }),
      segment({ id: 's4', confidence: 0.5 }),
      segment({ id: 's5', excluded: true }),
      segment({ id: 's6', final: false }),
    ];
    expect(eligibleSegments(list).map((s) => s.id)).toEqual(['s1']);
  });
  it('accepts only exact fact values backed by an eligible segment', () => {
    const facts = [
      { key: 'device', value: 'Nord A1', quote: 'Мне нужен Nord A1', segmentId: 's1' },
      { key: 'budget', value: '15000', quote: 'до 20000 рублей', segmentId: 's1' },
      { key: 'other', value: 'Nord A1', quote: 'Nord A1', segmentId: 'missing' },
    ];
    expect(applyPatch(emptyCard('c'), patch({ facts }), [segment()], 'qwen').facts).toEqual([
      facts[0],
    ]);
    expect(
      applyPatch(emptyCard('c'), patch({ facts }), [segment({ role: 'bystander' })], 'qwen').facts,
    ).toEqual([]);
  });
  it('never converts discussion into execution of a required step', () => {
    const card = applyPatch(
      emptyCard('c'),
      patch(),
      [segment({ text: 'Сейчас проверю документ' })],
      'kev',
    );
    expect(card.completedSteps).toEqual([]);
    const doc = demoDocuments('org')[0];
    doc.blocks[1].requiredFacts = [doc.blocks[0].id];
    const selection = [{ documentId: doc.id, blockId: doc.blocks[1].id }];
    expect(verifiedEvidence(selection, [doc], 'org', card)).toEqual([]);
    card.completedSteps = [doc.blocks[0].id];
    expect(verifiedEvidence(selection, [doc], 'org', card)).toHaveLength(1);
    expect(
      verifiedEvidence([{ documentId: doc.id, blockId: doc.blocks[0].id }], [doc], 'org', card),
    ).toEqual([]);
  });
  it('rejects foreign, archived, future, expired, wrong-region and invented sources', () => {
    const doc = demoDocuments('org')[0],
      select = [{ documentId: doc.id, blockId: doc.blocks[0].id }],
      card = emptyCard('c');
    for (const invalid of [
      { orgId: 'other' },
      { status: 'draft' as const },
      { status: 'archived' as const },
      { validFrom: '2999-01-01' },
      { validUntil: '2000-01-01' },
      { region: 'Другой регион' },
    ])
      expect(verifiedEvidence(select, [{ ...doc, ...invalid }], 'org', card)).toEqual([]);
    expect(
      verifiedEvidence([{ documentId: doc.id, blockId: 'made-up' }], [doc], 'org', card),
    ).toEqual([]);
    expect(verifiedEvidence([...select, ...select], [doc], 'org', card)).toHaveLength(1);
  });
  it('renders literal source text, or the fixed no-evidence answer', () => {
    const doc = demoDocuments('org')[0],
      card = emptyCard('c');
    const refs = verifiedEvidence(
      [{ documentId: doc.id, blockId: doc.blocks[0].id }],
      [doc],
      'org',
      card,
    );
    expect(renderHint(card, refs, 'qwen').text).toBe(doc.blocks[0].text);
    expect(renderHint(card, [], 'kimi').text).toBe(NO_EVIDENCE);
  });
  it('treats expiry as inclusive, using UTC dates', () => {
    const d = { ...demoDocuments('org')[0], validFrom: '2026-10-07', validUntil: '2026-10-07' };
    expect(isPublished(d, 'org', new Date('2026-10-07T23:59:59Z'))).toBe(true);
    expect(isPublished(d, 'org', new Date('2026-10-08T00:00:00Z'))).toBe(false);
  });
  it('masks common sensitive numbers before sending context', () => {
    const masked = maskPII(
      'Почта user@example.com, +7 (999) 123-45-67, паспорт 1234 567890, карта 1234 5678 9012 3456',
    );
    expect(masked).toContain('[EMAIL]');
    expect(masked).toContain('[ТЕЛЕФОН]');
    expect(masked).toContain('[ДОКУМЕНТ]');
    expect(masked).toContain('[НОМЕР]');
    expect(masked).not.toContain('567890');
  });
  it('invalidates every earlier hint when context changes', () => {
    const c = newConversation('a', 'u', 'qwen', 'Клиент');
    c.hints = [renderHint(c.card, [], 'qwen')];
    const next = invalidate(c);
    expect(next.card.revision).toBe(1);
    expect(next.generationEpoch).toBe(1);
    expect(next.hints[0].status).toBe('stale');
  });
});

describe('audio frame integrity', () => {
  it('preserves PCM bytes and rejects missing/out-of-order frames', async () => {
    const { encodeAudioFrame, decodeAudioFrame } = await import('../packages/shared/src/index');
    const pcm = new Int16Array([100, -100, 32767, -32768]);
    const frame = new Uint8Array(encodeAudioFrame(pcm.buffer, 4, 1600));
    expect([...decodeAudioFrame(frame, 4, 1600)]).toEqual([...new Uint8Array(pcm.buffer)]);
    expect(() => decodeAudioFrame(frame, 3, 1600)).toThrow();
    expect(() => decodeAudioFrame(frame, 4, 0)).toThrow();
  });
});
