'use client';
import { useEffect, useState } from 'react';
import type { ModelTariff } from '@sufler/shared';
import { api, post } from '@/lib/api';
import { Button } from './ui/button';
export type Metrics = {
  calls: number;
  errors: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  unknownUsage: number;
  untrackedConversations?: number;
  userNames?: Record<string, string>;
  costUsd: number | null;
  costCoverage: number | null;
  incomplete: boolean;
  conversations: number;
  hints: number;
  costPerConversation: number | null;
  costPerHint: number | null;
  providerP50: number | null;
  providerP95: number | null;
  pipelineP50: number | null;
  pipelineP95: number | null;
  byModel: Groups;
  byType: Groups;
  byProvider: Groups;
  byDay: Groups;
  from?: string;
  to?: string;
  retentionDays?: number;
  models?: string[];
  types?: string[];
  users?: string[];
};
type Groups = Record<string, { calls: number; costUsd: number; unknown: number; tokens: number }>;
export const dollars = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(6)}`);
const seconds = (v: number | null) => (v === null ? '—' : `${(v / 1000).toFixed(2)} с`);
export const callNames: Record<string, string> = {
  classification: 'Контекст',
  'speaker-roles': 'Роли спикеров',
  'client-boundary': 'Смена клиента',
  'fact-extraction': 'Факты',
  hint: 'Подсказка',
  chat: 'Чат',
};
export function CostSummary({ value: v }: { value: Metrics }) {
  return (
    <>
      <div className="call-stats">
        {[
          ['Расходы · USD', dollars(v.costUsd)],
          ['Стоимость диалога', dollars(v.costPerConversation)],
          ['На подсказку', dollars(v.costPerHint)],
          ['Диалоги / подсказки', `${v.conversations} / ${v.hints}`],
          ['Вызовы / ошибки / отмены', `${v.calls} / ${v.errors} / ${v.cancelled}`],
          ['Вход / выход', `${v.inputTokens} / ${v.outputTokens}`],
          ['Кэш / reasoning', `${v.cachedTokens} / ${v.reasoningTokens}`],
          ['Провайдер p50 / p95', `${seconds(v.providerP50)} / ${seconds(v.providerP95)}`],
          ['До подсказки p50 / p95', `${seconds(v.pipelineP50)} / ${seconds(v.pipelineP95)}`],
        ].map(([label, value]) => (
          <div key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <p className="muted">
        Стоимость известна для{' '}
        {v.costCoverage === null ? '—' : `${Math.round(v.costCoverage * 100)}%`} вызовов.{' '}
        {v.incomplete ? 'Итог неполный: часть тарифов или usage отсутствует. ' : ''}
        {v.untrackedConversations
          ? `Без журнала вызовов: ${v.untrackedConversations} диалогов. `
          : ''}
        {v.unknownUsage > 0 ? `Неизвестен расход токенов: ${v.unknownUsage} вызовов. ` : ''}Расчёт
        по тарифам на момент запроса; без Deepgram. Кэш и reasoning уже входят в токены.
      </p>
      <small className="muted">
        «До подсказки» — от получения подтверждённой реплики сервером; «Провайдер» — полный
        HTTP-запрос. Расход на подсказку включает контекст и служебные вызовы.
      </small>
    </>
  );
}
export function CostBreakdown({ value: v }: { value: Metrics }) {
  return (
    <div className="cost-breakdowns">
      {[
        ['Decision / LLM', v.byProvider],
        ['По моделям', v.byModel],
        ['По назначению', v.byType],
        ['По дням · Москва', v.byDay],
      ].map(([title, groups]) => (
        <details key={String(title)}>
          <summary>{String(title)}</summary>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Группа</th>
                  <th>Вызовы</th>
                  <th>Токены</th>
                  <th>USD</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(groups as Groups)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, row]) => (
                    <tr key={key}>
                      <td>{callNames[key] || key}</td>
                      <td>{row.calls}</td>
                      <td>{row.tokens}</td>
                      <td>
                        {row.unknown === row.calls ? '—' : dollars(row.costUsd)}
                        {row.unknown > 0 ? ' · неполно' : ''}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </div>
  );
}
export function MetricsPanel({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<Metrics | null>(null),
    [error, setError] = useState(''),
    [filters, setFilters] = useState({ from: '', to: '', model: '', type: '', user: '' });
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    api<Metrics>(`/admin/metrics?${query}`)
      .then((v) => {
        if (active) {
          setData(v);
          setError('');
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [filters]);
  return (
    <section className="panel metrics-panel">
      <h3>Расходы и скорость AI</h3>
      {!compact && (
        <div className="metrics-filters">
          {(['from', 'to'] as const).map((k) => (
            <label key={k}>
              {k === 'from' ? 'С' : 'По'}
              <input
                type="date"
                value={filters[k] || data?.[k] || ''}
                onChange={(e) => setFilters({ ...filters, [k]: e.target.value })}
              />
            </label>
          ))}
          {(['model', 'type', 'user'] as const).map((k) => (
            <label key={k}>
              {k === 'model' ? 'Модель' : k === 'type' ? 'Назначение' : 'Сотрудник'}
              <select
                value={filters[k]}
                onChange={(e) => setFilters({ ...filters, [k]: e.target.value })}
              >
                <option value="">Все</option>
                {(data?.[k === 'model' ? 'models' : k === 'type' ? 'types' : 'users'] || []).map(
                  (v) => (
                    <option key={v} value={v}>
                      {k === 'user' ? data?.userNames?.[v] || v : callNames[v] || v}
                    </option>
                  ),
                )}
              </select>
            </label>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <CostSummary value={data} />
          {!compact && <CostBreakdown value={data} />}
          <p className="muted">
            {data.from} — {data.to} · Europe/Moscow · доступный срок хранения {data.retentionDays}{' '}
            дней. Старые диалоги могут иметь неполную телеметрию.
          </p>
        </>
      )}
    </section>
  );
}
export function TariffEditor() {
  const [tariffs, setTariffs] = useState<ModelTariff[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [model, setModel] = useState('decision-model-preview'),
    [input, setInput] = useState(''),
    [output, setOutput] = useState(''),
    [cached, setCached] = useState(''),
    [date, setDate] = useState('');
  useEffect(() => {
    api<ModelTariff[]>('/admin/tariffs')
      .then(setTariffs)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <details className="panel tariff-editor">
      <summary>Тарифы моделей · USD за 1 млн токенов</summary>
      <p className="muted">
        Введите тариф вашего аккаунта Alibaba. Пустой тариф означает неизвестную стоимость. Новая
        версия не меняет прошлые расчёты.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const t = await post<ModelTariff>('/admin/tariffs', {
              modelId: model,
              input: Number(input),
              output: Number(output),
              cached: Number(cached),
              effectiveAt: date ? new Date(date).toISOString() : new Date().toISOString(),
            });
            setTariffs([...tariffs, t]);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Ошибка');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="metrics-filters">
          <label>
            ID модели
            <input required value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          {[
            ['Вход', input, setInput],
            ['Выход', output, setOutput],
            ['Кэш', cached, setCached],
          ].map(([label, value, set]) => (
            <label key={String(label)}>
              {String(label)}
              <input
                type="number"
                required
                min="0"
                step="any"
                value={String(value)}
                onChange={(e) => (set as (v: string) => void)(e.target.value)}
              />
            </label>
          ))}
          <label>
            Начало действия (по местному времени)
            <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <Button disabled={busy}>Сохранить тариф</Button>
        {error && <p role="alert">{error}</p>}
      </form>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Модель</th>
              <th>Вход / выход / кэш</th>
              <th>Действует с</th>
            </tr>
          </thead>
          <tbody>
            {tariffs.map((t) => (
              <tr key={t.id}>
                <td>{t.modelId}</td>
                <td>
                  {t.input} / {t.output} / {t.cached}
                </td>
                <td>{new Date(t.effectiveAt).toLocaleString('ru-RU')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
