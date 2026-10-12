import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { store } from './store';
import { migrateModelStudio } from './provider-migration';
import { newConversation } from '@sufler/shared/engine';
import { MODEL_DEFAULTS, type Conversation } from '@sufler/shared';
it('migrates saved models and active cards idempotently while retaining completed history', async () => {
  const org = randomUUID();
  await store.put(org, 'model', 'qwen/qwen3.5-9b', { ...MODEL_DEFAULTS[0], id: 'qwen/qwen3.5-9b' });
  const active = newConversation(org, 'u', 'qwen/qwen3.5-9b', 'Client');
  active.card.needs = ['Телефон'];
  const completed = {
    ...newConversation(org, 'u', 'qwen/qwen3.5-9b', 'Previous'),
    status: 'completed' as const,
  };
  await store.put(org, 'conversation', active.id, active);
  await store.put(org, 'conversation', completed.id, completed);
  await migrateModelStudio();
  expect((await store.list<any>(org, 'model')).map((m) => m.id).sort()).toEqual(
    MODEL_DEFAULTS.map((m) => m.id).sort(),
  );
  const changed = await store.get<Conversation>(org, 'conversation', active.id);
  expect(changed?.modelId).toBe('qwen3.8-27b');
  expect(changed?.card.needs).toEqual(['Телефон']);
  expect((await store.get<Conversation>(org, 'conversation', completed.id))?.modelId).toBe(
    'qwen/qwen3.5-9b',
  );
  await migrateModelStudio();
  expect((await store.get<Conversation>(org, 'conversation', active.id))?.card.revision).toBe(
    changed?.card.revision,
  );
  await store.remove(org, 'conversation', active.id);
  await store.remove(org, 'conversation', completed.id);
  for (const model of MODEL_DEFAULTS) await store.remove(org, 'model', model.id);
});
