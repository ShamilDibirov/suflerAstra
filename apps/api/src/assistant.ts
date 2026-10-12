import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { Conversation, Hint, KnowledgeDocument, SessionUser } from '@sufler/shared';
import { isPublished, maskPII } from '@sufler/shared/engine';
import { store } from './store';
import { config } from './config';
import { requireConversation, models } from './conversations';
import { retrieve, scriptSources } from './knowledge';
import { getPrompts } from './prompts';
import { assistantResponse, providerError } from './ai';
import { emit } from './events';

import { renderAssistantParts } from './assistant-render';
export { renderAssistantParts } from './assistant-render';

// The pilot runs one API instance. Keep the provider wait out of the PostgreSQL
// connection pool while still serializing questions and chat memory per dialog.
const chatQueues = new Map<string, Promise<unknown>>();
async function serializeChat<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = chatQueues.get(key) || Promise.resolve();
  const job = previous.catch(() => {}).then(action);
  chatQueues.set(key, job);
  try {
    return await job;
  } finally {
    if (chatQueues.get(key) === job) chatQueues.delete(key);
  }
}

/** Chat has its own memory and lifecycle; it never replaces the live hint. */
export async function chatAnswer(
  user: SessionUser,
  id: string,
  question: string,
  signal: AbortSignal,
) {
  await requireConversation(user, id, true);
  return serializeChat(`${user.orgId}:chat:${id}`, async () => {
    if (signal.aborted) return null;
    const c = await requireConversation(user, id, true);
    if (c.status !== 'active')
      throw new BadRequestException('Начните новую сессию для продолжения чата');
    if (!(await models(user.orgId)).some((m) => m.id === c.modelId && m.enabled))
      throw new BadRequestException('Модель отключена');
    const prompts = await getPrompts(user.orgId),
      start = Date.now();
    const mode = c.assistanceMode || config.defaultAssistanceMode;
    let docs: KnowledgeDocument[] = [];
    let retrievalError: string | undefined;
    try {
      docs =
        mode === 'scripts'
          ? c.salesScriptId
            ? await scriptSources(c)
            : []
          : await retrieve(
              user.orgId,
              [question, c.card.intent, ...c.card.needs].join(' '),
              c.region,
            );
    } catch {
      retrievalError = 'Поиск по базе сейчас недоступен; не утверждай условия оператора.';
    }
    if (signal.aborted) return null;
    try {
      const result = await assistantResponse(
        c,
        question,
        prompts.chatPrompt,
        docs,
        signal,
        retrievalError,
      );
      if (signal.aborted) return null;
      return await store.withLock(`${user.orgId}:knowledge`, async () => {
        const latestDocs = await store.list<KnowledgeDocument>(user.orgId, 'document');
        const valid = latestDocs
          .filter(
            (d) =>
              docs.some((old) => old.id === d.id && old.version === d.version) &&
              isPublished(d, user.orgId),
          )
          .map((d) => ({
            ...d,
            blocks: d.blocks.filter((b) =>
              docs.some((old) => old.id === d.id && old.blocks.some((x) => x.id === b.id)),
            ),
          }));
        const rendered = renderAssistantParts(c, valid, result.parts);
        if (!rendered.text)
          throw new BadRequestException('Ответ не прошёл проверку источников. Уточните вопрос.');
        if ((await getPrompts(user.orgId)).revision !== prompts.revision)
          throw new BadRequestException('Промпт изменился. Повторите вопрос.');
        if (!(await models(user.orgId)).some((m) => m.id === c.modelId && m.enabled))
          throw new BadRequestException('Модель отключена во время генерации');
        const answer: Hint = {
          id: randomUUID(),
          revision: c.card.revision,
          kind: rendered.references.length ? 'sales' : 'coaching',
          title: 'Ответ ассистента',
          text: rendered.text,
          blocks: rendered.references,
          modelId: c.modelId,
          createdAt: new Date().toISOString(),
          latencyMs: Date.now() - start,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cost: null,
          status: 'current',
        };
        const updated = await store.mutateConversation(user.orgId, id, (v) => {
          const turns = new Map(v.segments.map((s) => [s.id, s]));
          const corrected = c.segments.some((s) => {
            const live = turns.get(s.id);
            return !live || live.text !== s.text || !!live.excluded !== !!s.excluded;
          });
          if (
            signal.aborted ||
            v.status !== 'active' ||
            corrected ||
            v.region !== c.region ||
            v.modelId !== c.modelId ||
            v.assistanceMode !== c.assistanceMode ||
            v.salesScriptId !== c.salesScriptId
          )
            return null;
          return {
            ...v,
            messages: [
              ...v.messages,
              {
                id: randomUUID(),
                role: 'user' as const,
                text: maskPII(question),
                createdAt: answer.createdAt,
              },
              {
                id: answer.id,
                role: 'assistant' as const,
                text: answer.text,
                hint: answer,
                createdAt: answer.createdAt,
              },
            ],
          };
        });
        if (!updated) return null;
        emit(user.orgId, user.id, {
          type: 'conversation.updated',
          conversationId: id,
          data: updated,
        });
        return answer;
      });
    } catch (e) {
      if (signal.aborted) return null;
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(providerError(e));
    }
  });
}
