'use client';
import { useEffect, useState } from 'react';
import type { Conversation, ModelCallLog } from '@sufler/shared';
import { api, formatTime } from '@/lib/api';
import { CostSummary, CostBreakdown, dollars, callNames, type Metrics } from './metrics-panel';
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
    summary: Metrics;
    recordingEnabled: boolean;
    retentionDays: number;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api<NonNullable<typeof data>>(`/admin/history/${initial.id}/analytics`)
        .then((value) => {
          if (active) {
            setData(value);
            setError('');
          }
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
      {data && (
        <>
          <CostSummary value={data.summary} />
          <CostBreakdown value={data.summary} />
        </>
      )}
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
            <strong>{callNames[call.type] || call.type}</strong>
            <span>{call.model}</span>
            <span>{(call.latencyMs / 1000).toFixed(2)} с</span>
            <span>
              {call.status} {call.httpStatus || ''}
            </span>
          </summary>
          <p className="muted">
            {call.inputTokens ?? '—'} вход / {call.outputTokens ?? '—'} выход · кэш{' '}
            {call.cachedTokens ?? '—'} · reasoning {call.reasoningTokens ?? '—'} ·{' '}
            {dollars(call.costUsd)} (
            {call.costSource === 'estimated'
              ? 'расчёт'
              : call.costSource === 'provider'
                ? 'провайдер'
                : 'стоимость неизвестна'}
            ) · ревизия {call.revision}
          </p>
          {call.requestId && <small>Request ID: {call.requestId}</small>}
          {call.error && <p>{call.error}</p>}
          {call.result && <pre>{call.result}</pre>}
        </details>
      ))}
    </section>
  );
}
