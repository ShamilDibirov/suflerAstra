import {
  ClassificationInput,
  DEFAULT_CLASSIFICATION,
  type ClassificationSettings,
  type SessionUser,
  type KnowledgeDocument,
  type Conversation,
} from '@sufler/shared';
import { assertAdmin } from './auth';
import { store } from './store';
import { config } from './config';

export async function getClassification(orgId: string): Promise<ClassificationSettings> {
  const saved = await store.get<ClassificationSettings>(orgId, 'settings', 'classification');
  if (saved)
    return {
      ...ClassificationInput.parse(saved),
      revision: saved.revision,
      updatedAt: saved.updatedAt,
    };
  return {
    ...structuredClone(DEFAULT_CLASSIFICATION),
    model: config.classifier,
    fallbackModel: config.fallback,
    threshold: config.decisionThreshold,
    revision: 0,
    updatedAt: null,
  };
}
export async function saveClassification(user: SessionUser, input: unknown) {
  assertAdmin(user);
  const values = ClassificationInput.parse(input);
  return store.withLock(`${user.orgId}:classification`, async () => {
    const previous = await getClassification(user.orgId);
    const settings = {
      ...values,
      revision: previous.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await store.put(user.orgId, 'settings', 'classification', settings);
    return settings;
  });
}
export function classificationIntents(
  c: Conversation,
  docs: KnowledgeDocument[],
  settings: ClassificationSettings,
) {
  const options = Object.fromEntries(
    docs.map((d) => [
      d.intent,
      { name: d.title, description: d.description || d.title, direction: d.direction },
    ]),
  );
  for (const intent of settings.intents) {
    if (intent.enabled) options[intent.id] = intent;
    else delete options[intent.id];
  }
  return options;
}
