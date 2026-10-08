import {
  PromptInput,
  DEFAULT_PROMPTS,
  type PromptSettings,
  type SessionUser,
} from '@sufler/shared';
import { assertAdmin } from './auth';
import { store } from './store';

export async function getPrompts(orgId: string): Promise<PromptSettings> {
  return (
    (await store.get<PromptSettings>(orgId, 'settings', 'prompts')) || {
      ...DEFAULT_PROMPTS,
      revision: 0,
      updatedAt: null,
    }
  );
}
export async function savePrompts(user: SessionUser, input: unknown) {
  assertAdmin(user);
  const values = PromptInput.parse(input);
  return store.withLock(`${user.orgId}:prompts`, async () => {
    const previous = await getPrompts(user.orgId);
    const settings: PromptSettings = {
      ...values,
      revision: previous.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await store.put(user.orgId, 'settings', 'prompts', settings);
    return settings;
  });
}
