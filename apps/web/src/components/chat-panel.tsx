'use client';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useEffect, useMemo, useState } from 'react';
import { ArrowUp, BookOpen, Sparkles } from 'lucide-react';
import type { Conversation as ConversationData, Hint } from '@sufler/shared';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from './ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from './ai-elements/message';
import { Button } from './ui/button';
type VerifiedMessage = UIMessage<unknown, { hint: Hint }>;
export function ChatPanel({
  conversation,
  onSent,
}: {
  conversation: ConversationData;
  onSent: () => void;
}) {
  const [input, setInput] = useState('');
  const transport = useMemo(
    () =>
      new DefaultChatTransport<VerifiedMessage>({
        api: `/api/chat/${conversation.id}`,
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            message:
              messages
                .at(-1)
                ?.parts.filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('') || '',
          },
        }),
      }),
    [conversation.id],
  );
  const { messages, sendMessage, status, error, stop } = useChat<VerifiedMessage>({
    id: conversation.id,
    transport,
    messages: conversation.messages.map((m) => ({
      id: m.id,
      role: m.role,
      parts: [
        { type: 'text' as const, text: m.text },
        ...(m.hint ? [{ type: 'data-hint' as const, data: m.hint }] : []),
      ],
    })),
    onFinish: onSent,
  });
  useEffect(() => {
    void stop();
  }, [conversation.modelId, stop]);
  const busy = status === 'submitted' || status === 'streaming';
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || busy) return;
    const text = input;
    setInput('');
    await sendMessage({ text });
  }
  return (
    <div className="chat-layout">
      <div className="info-banner" style={{ fontSize: 12, marginBottom: 10 }}>
        Карточка клиента и подтверждённые источники уже в контексте.
      </div>
      <Conversation>
        <ConversationContent>
          {!messages.length && (
            <div className="empty-state">
              <Sparkles size={30} />
              <h3>Продолжим вместе</h3>
              <p>Уточните шаг, попросите подобрать предложение или найти условие.</p>
            </div>
          )}
          {messages.map((m) => {
            const hint = m.parts.find((p) => p.type === 'data-hint')?.data;
            return (
              <Message from={m.role} key={m.id}>
                <MessageContent>
                  {m.parts
                    .filter((p) => p.type === 'text')
                    .map((p, i) => (
                      <MessageResponse key={i}>{p.text}</MessageResponse>
                    ))}
                  {hint && (
                    <div className="chat-sources">
                      {hint.blocks.map((b) => (
                        <details key={`${b.documentId}:${b.blockId}`}>
                          <summary>
                            <BookOpen size={13} /> {b.title} · v{b.version}
                          </summary>
                          <blockquote>{b.quote}</blockquote>
                          <small>
                            {b.region} · {hint.modelId}
                          </small>
                        </details>
                      ))}
                      {hint.revision !== conversation.card.revision && (
                        <small>
                          Ответ из истории — запросите обновление для текущего контекста.
                        </small>
                      )}
                    </div>
                  )}
                </MessageContent>
              </Message>
            );
          })}
          {busy && <small>Проверяем источники…</small>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {error && <div className="error-banner">{error.message}</div>}
      <form className="chat-compose" onSubmit={send}>
        <textarea
          rows={2}
          aria-label="Вопрос Суфлёру"
          placeholder="Что ещё нужно уточнить у клиента?"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(e);
            }
          }}
        />
        <Button size="icon" disabled={busy || !input.trim()} aria-label="Отправить вопрос">
          <ArrowUp size={18} />
        </Button>
      </form>
      <div className="chat-meta">{conversation.modelId} · Ответ проверяется до отображения</div>
    </div>
  );
}
