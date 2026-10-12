import { MODEL_DEFAULTS, type Conversation, type ModelConfig } from '@sufler/shared';
import { invalidate } from '@sufler/shared/engine';
import { store } from './store';

const aliases: Record<string, string> = {
  'qwen/qwen3.5-9b': 'qwen3.8-27b',
  'qwen/qwen3.5-35b-a3b': 'qwen3.8-max',
  'moonshotai/kimi-k2.5': 'kimi-k3',
};
export async function migrateModelStudio() {
  for (const org of await store.organizations()) {
    await store.withLock(`${org}:model-studio-migration`, async () => {
      const saved = await store.list<ModelConfig>(org, 'model');
      for (const old of saved) {
        const id = aliases[old.id];
        if (!id) continue;
        const existing = saved.find((m) => m.id === id);
        const replacement = existing || MODEL_DEFAULTS.find((m) => m.id === id)!;
        const isDefault =
          existing?.isDefault ||
          (old.isDefault && !saved.some((m) => m.isDefault && !aliases[m.id]));
        await store.put(org, 'model', id, {
          ...replacement,
          enabled: existing?.enabled ?? old.enabled,
          isDefault,
        });
        await store.remove(org, 'model', old.id);
      }
      if (saved.some((m) => aliases[m.id])) {
        const current = await store.list<ModelConfig>(org, 'model');
        for (const model of MODEL_DEFAULTS)
          if (!current.some((m) => m.id === model.id))
            await store.put(org, 'model', model.id, { ...model, isDefault: false });
      }
      for (const c of await store.list<Conversation>(org, 'conversation')) {
        const id = aliases[c.modelId];
        if (!id || c.status !== 'active') continue;
        await store.mutateConversation(org, c.id, (v) => ({
          ...invalidate(v),
          modelId: id,
          error: null,
        }));
      }
    });
  }
}
