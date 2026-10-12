'use client';
import { useEffect, useState } from 'react';
import type { Conversation, ModelCallLog } from '@sufler/shared';
import { api, formatTime } from '@/lib/api';
import { RecordingPlayer } from './recording-player';

const names: Record<string, string> = {
  classification: 'Контекст / Decision',
  'speaker-roles': 'Роли спикеров',
  'fact-extraction': 'Извлечение фактов',
  hint: 'Подсказка',
  chat: 'Чат',
};
export function HistoryAnalytics({ initial }: { initial: Conversation }) {
  const [data, setData] = useState<{
    conversation: Conversation;
    calls: ModelCallLog[];
    recordingEnabled: boolean;
    retentionDays: number;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api<NonNullable<typeof data>>(`/admin/history/${initial.id}/analytics`)
        .then((value) => {
          if (active) setData(value);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [initial.id]);
  const c = data?.conversation || initial,
    calls = data?.calls || [];
  const latencies = calls
    .filter((x) => x.status === 'ok')
    .map((x) => x.latencyMs)
    .sort((a, b) => a - b);
  const percentile = (p: number) =>
    latencies.length
      ? `${(latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] / 1000).toFixed(2)} с`
      : '—';
  return (
    <section>
      <RecordingPlayer key={c.id} conversation={c} />
      {data && (
        <p className="muted">
          Хранение: {data.retentionDays} дней · запись новых диалогов{' '}
          {data.recordingEnabled ? 'включена' : 'выключена'}
        </p>
      )}
      <div className="call-stats">
        <div>
          <small>Вызовы</small>
          <strong>{calls.length}</strong>
        </div>
        <div>
          <small>Ошибки / отмены</small>
          <strong>
            {calls.filter((x) => x.status === 'error').length} /{' '}
            {calls.filter((x) => x.status === 'cancelled').length}
          </strong>
        </div>
        <div>
          <small>Latency p50 / p95</small>
          <strong>
            {percentile(0.5)} / {percentile(0.95)}
          </strong>
        </div>
        <div>
          <small>Вход / выход, токены</small>
          <strong>
            {calls.reduce((n, x) => n + x.inputTokens, 0)} /{' '}
            {calls.reduce((n, x) => n + x.outputTokens, 0)}
          </strong>
        </div>
        <div>
          <small>Reasoning, токены</small>
          <strong>{calls.reduce((n, x) => n + x.reasoningTokens, 0)}</strong>
        </div>
        <div>
          <small>Реплики / подсказки</small>
          <strong>
            {c.segments.length} / {c.hints.length}
          </strong>
        </div>
      </div>
      <p className="muted">
        Latency — полный HTTP-запрос модели, включая получение ответа. Это не время от окончания
        речи. Токены — по данным провайдера; стоимость здесь не рассчитывается.
      </p>
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>Контекст и роли спикеров · ревизия {c.card.revision}</summary>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {JSON.stringify(
            { sessionId: c.sessionId || c.id, card: c.card, speakers: c.speakerRoles || {} },
            null,
            2,
          )}
        </pre>
      </details>
      <h3 style={{ marginTop: 20 }}>Вызовы моделей</h3>
      {!calls.length && (
        <p className="muted">
          Логи появятся после новых вызовов. Для старых диалогов подробная телеметрия не собиралась.
        </p>
      )}
      {calls.map((call) => (
        <details key={call.id} className="call-log">
          <summary>
            <time>{formatTime(call.at)}</time>
            <strong>{names[call.type] || call.type}</strong>
            <span>{call.model}</span>
            <span>{(call.latencyMs / 1000).toFixed(2)} с</span>
            <span>
              {call.status} {call.httpStatus || ''}
            </span>
          </summary>
          <p className="muted">
            {call.inputTokens} вход / {call.outputTokens} выход · reasoning {call.reasoningTokens} ·
            ревизия {call.revision}
          </p>
          {call.requestId && <small>Request ID: {call.requestId}</small>}
          {call.error && <p>{call.error}</p>}
          {call.result && <pre>{call.result}</pre>}
        </details>
      ))}
    </section>
  );
}
