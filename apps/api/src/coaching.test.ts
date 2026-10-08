import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PROMPTS, type SessionUser } from '@sufler/shared';
import { config } from './config';
import { store } from './store';
import { createConversation, makeHint, finish } from './conversations';
import { getPrompts, savePrompts } from './prompts';
import { salesAdvice, selectEvidence } from './ai';
vi.mock('./ai', async (original) => ({
  ...(await original<object>()),
  salesAdvice: vi.fn(),
  selectEvidence: vi.fn(),
  classify: vi.fn(),
}));
let user: SessionUser;
const mode = config.defaultAssistanceMode;
beforeEach(() => {
  vi.clearAllMocks();
  config.defaultAssistanceMode = 'scripts';
  user = {
    id: randomUUID(),
    orgId: randomUUID(),
    orgName: 'Org',
    name: 'Owner',
    email: 'test@example.test',
    role: 'owner',
    demo: true,
  };
  vi.mocked(salesAdvice).mockResolvedValue({
    text: 'Уточните, для каких задач нужен телефон.',
    inputTokens: 50,
    outputTokens: 10,
  });
});
afterEach(() => {
  config.defaultAssistanceMode = mode;
});
it('gives a hint and continues chat without any knowledge documents', async () => {
  const c = await createConversation(user);
  const hint = await makeHint(user, c.id);
  expect(hint).toMatchObject({ kind: 'coaching', blocks: [], inputTokens: 50 });
  expect(selectEvidence).not.toHaveBeenCalled();
  expect(salesAdvice).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: c.id }),
    '',
    DEFAULT_PROMPTS.hintPrompt,
    expect.any(AbortSignal),
  );
  await makeHint(user, c.id, 'Как обработать дорого?');
  expect(salesAdvice).toHaveBeenLastCalledWith(
    expect.anything(),
    'Как обработать дорого?',
    DEFAULT_PROMPTS.chatPrompt,
    expect.any(AbortSignal),
  );
  expect((await store.get<any>(user.orgId, 'conversation', c.id)).messages).toHaveLength(2);
  await finish(user, c.id);
});
it('applies new prompts to subsequent requests and isolates organizations and roles', async () => {
  const c = await createConversation(user);
  const values = {
    hintPrompt: 'Задавай один открытый вопрос о потребности.',
    chatPrompt: 'Приводи короткий пример ответа на возражение.',
  };
  await expect(savePrompts({ ...user, role: 'consultant' }, values)).rejects.toThrow();
  await savePrompts(user, values);
  await makeHint(user, c.id);
  expect(vi.mocked(salesAdvice).mock.calls.at(-1)?.[2]).toBe(values.hintPrompt);
  expect((await getPrompts('other')).hintPrompt).toBe(DEFAULT_PROMPTS.hintPrompt);
  await expect(savePrompts(user, { hintPrompt: '', chatPrompt: '' })).rejects.toThrow();
  await finish(user, c.id);
});
it('drops a late result after the prompt has changed', async () => {
  const c = await createConversation(user);
  let resolve!: (value: any) => void;
  vi.mocked(salesAdvice).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = makeHint(user, c.id);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  await savePrompts(user, {
    ...DEFAULT_PROMPTS,
    hintPrompt: 'Задавай один уточняющий вопрос о потребности.',
  });
  resolve({ text: 'Old answer', inputTokens: 1, outputTokens: 1 });
  expect(await pending).toBeNull();
  await finish(user, c.id);
});
