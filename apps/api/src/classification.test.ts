import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ClassificationInput, DEFAULT_CLASSIFICATION, type SessionUser } from '@sufler/shared';
import { newConversation } from '@sufler/shared/engine';
import { demoDocuments } from '@sufler/shared/demo';
import { getClassification, saveClassification, classificationIntents } from './classification';
const owner = (): SessionUser => ({
  orgId: randomUUID(),
  id: 'owner',
  role: 'owner',
  orgName: 'Org',
  name: 'Owner',
  email: 'owner@example.test',
  demo: true,
});
describe('organization classification controls', () => {
  it('persists custom labels, versions updates and denies consultants and other tenants', async () => {
    const user = owner();
    const input = {
      ...DEFAULT_CLASSIFICATION,
      groups: [
        {
          id: 'use_case',
          name: 'Сценарий',
          enabled: true,
          instructions: 'Где нужна связь?',
          choices: [
            { id: 'dacha', name: 'Дача', description: 'Связь за городом' },
            { id: 'travel', name: 'Поездки', description: 'Связь в поездках' },
          ],
        },
      ],
    };
    await expect(saveClassification({ ...user, role: 'consultant' }, input)).rejects.toThrow();
    const saved = await saveClassification(user, input);
    expect(saved.revision).toBe(1);
    expect((await getClassification(user.orgId)).groups[0].choices[0].id).toBe('dacha');
    expect((await getClassification(randomUUID())).groups).toEqual([]);
    expect((await saveClassification(user, input)).revision).toBe(2);
  });
  it('overrides and disables published intent definitions and rejects duplicate IDs', () => {
    const docs = demoDocuments('org'),
      c = newConversation('org', 'u', 'qwen', 'Test');
    const settings = {
      ...DEFAULT_CLASSIFICATION,
      revision: 0,
      updatedAt: null,
      intents: [
        {
          id: docs[0].intent,
          name: 'Своя категория',
          description: 'Описание',
          direction: 'service' as const,
          enabled: false,
        },
      ],
    };
    expect(classificationIntents(c, docs, settings)).not.toHaveProperty(docs[0].intent);
    settings.intents[0].enabled = true;
    expect(classificationIntents(c, docs, settings)[docs[0].intent].name).toBe('Своя категория');
    expect(() =>
      ClassificationInput.parse({
        ...settings,
        intents: [...settings.intents, ...settings.intents],
      }),
    ).toThrow();
    expect(() =>
      ClassificationInput.parse({
        ...settings,
        intents: [{ ...settings.intents[0], id: 'unknown' }],
      }),
    ).toThrow();
  });
});
