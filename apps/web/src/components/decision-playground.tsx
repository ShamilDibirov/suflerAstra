'use client';
import { useEffect, useRef, useState } from 'react';
import { Plus, Play, Trash2, Copy } from 'lucide-react';
import type { ClassificationSettings } from '@sufler/shared';
import {
  decisionQuestion,
  decisionPassed,
  type DecisionRule,
  type DecisionAnswer,
} from '@sufler/shared/decisions';
import { post } from '@/lib/api';
import { Button } from './ui/button';

type Kind = 'choice' | 'noul' | 'score';
const names: Record<Kind, string> = {
  choice: 'Выбор категории',
  noul: 'Да / Нет',
  score: 'Оценка по шкале',
};
export function ruleTemplate(type: Kind): DecisionRule {
  const base = {
    id: `rule_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
    enabled: true,
    threshold: 0.85,
    choices: [],
    type,
  };
  if (type === 'noul')
    return {
      ...base,
      name: 'Есть возражение по цене',
      instructions: 'Клиент явно возражает против цены?',
      trueWhen: 'Клиент говорит, что дорого, или просит более дешёвый вариант.',
      falseWhen: 'Клиент только называет бюджет, спрашивает цену или соглашается с ней.',
    };
  if (type === 'score')
    return {
      ...base,
      name: 'Готовность к покупке',
      instructions: 'Насколько клиент готов купить?',
      levels: [
        'Только интересуется, потребность не названа',
        'Сравнивает варианты, потребность уже известна',
        'Потребность и бюджет понятны, готов выбрать',
        'Выбрал предложение и явно согласился на оформление',
      ],
      scoreThreshold: 2,
    };
  return {
    ...base,
    name: 'Сценарий использования',
    instructions: 'Для чего клиенту нужна связь?',
    choices: [
      { id: 'phone', name: 'Телефон', description: 'Звонки и интернет на личном телефоне' },
      {
        id: 'router',
        name: 'Роутер',
        description: 'SIM-карта для роутера, модема или домашнего интернета',
      },
      {
        id: 'smart_device',
        name: 'Умное устройство',
        description: 'Связь для часов, сигнализации, камеры или другого умного устройства',
      },
    ],
  };
}
type TestResult = {
  request: unknown;
  response: unknown;
  answer: DecisionAnswer | null;
  label: { value: string; label: string; confidence: number } | null;
  demo: boolean;
  latencyMs: number;
  results: {
    id: string;
    name: string;
    type: Kind;
    answer: DecisionAnswer | null;
    label: { value: string; label: string; confidence: number };
  }[];
};
export function DecisionPlayground({
  settings,
  published,
  change,
}: {
  settings: ClassificationSettings;
  published: ClassificationSettings['intents'];
  change: (values: Partial<ClassificationSettings>) => void;
}) {
  const [selected, setSelected] = useState('__primary');
  const [state, setState] = useState(
    'Клиент: Нужна сим-карта для роутера на даче.\nКонсультант: Какой бюджет?\nКлиент: До 500 рублей, хочу оформить сегодня.',
  );
  const [result, setResult] = useState<TestResult | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setResult(null);
    setError('');
    setBusy(false);
  }, [settings, state]);
  const intentOptions = Object.fromEntries(published.map((v) => [v.id, v]));
  for (const v of settings.intents) {
    if (v.enabled) intentOptions[v.id] = v;
    else delete intentOptions[v.id];
  }
  const intentRule: DecisionRule = {
    id: 'intent',
    name: 'Намерение клиента',
    instructions: 'Определи основное ещё не решённое намерение клиента из перечисленных вариантов.',
    enabled: true,
    choices: Object.values(intentOptions).map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
  };
  const index = settings.groups.findIndex((g) => g.id === selected);
  const rule = index < 0 ? intentRule : settings.groups[index];
  const type = rule.type || 'choice',
    threshold = rule.threshold ?? settings.threshold;
  const update = (values: Partial<DecisionRule>) =>
    change({ groups: settings.groups.map((g, i) => (i === index ? { ...g, ...values } : g)) });
  const editOption = (at: number, values: Partial<DecisionRule['choices'][number]>) => {
    if (index >= 0)
      return update({ choices: rule.choices.map((v, i) => (i === at ? { ...v, ...values } : v)) });
    const original = rule.choices[at];
    const entry = { ...intentOptions[original.id], ...values };
    change({
      intents: settings.intents.some((v) => v.id === original.id)
        ? settings.intents.map((v) => (v.id === original.id ? entry : v))
        : [...settings.intents, entry],
    });
  };
  const add = (kind: Kind) => {
    const g = ruleTemplate(kind);
    change({ groups: [...settings.groups, g] });
    setSelected(g.id);
  };
  const currentResult = result?.results.find((v) =>
    index < 0 ? ['_primary_intent', 'intent'].includes(v.id) : v.id === rule.id,
  );
  const selectedResult = currentResult
    ? { ...result!, answer: currentResult.answer, label: currentResult.label }
    : null;
  const probability =
    selectedResult?.answer?.type === 'noul'
      ? { false: 1 - selectedResult.answer.noul, true: selectedResult.answer.noul }
      : selectedResult?.answer && 'probabilities' in selectedResult.answer
        ? selectedResult.answer.probabilities
        : undefined;
  const options: [string, string][] =
    type === 'choice'
      ? [...rule.choices.map((v): [string, string] => [v.id, v.name]), ['unknown', 'Не определено']]
      : type === 'noul'
        ? [
            ['false', 'Нет'],
            ['true', 'Да'],
          ]
        : (rule.levels || []).map((v, i) => [String(i), `${i} · ${v}`]);
  const passed = decisionPassed(rule, selectedResult?.answer || undefined, settings.threshold);
  const test = async (all = true) => {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const r = await post<TestResult>('/admin/classification/playground', {
        settings,
        transcript: state,
        target: all ? 'all' : index < 0 ? 'intent' : 'rule',
        ruleId: rule.id,
      });
      if (current === generation.current) setResult(r);
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : 'Ошибка проверки');
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  return (
    <section className="panel settings-panel decision-builder">
      <div className="settings-heading">
        <div>
          <h2>
            Набор классификаторов · {settings.groups.filter((g) => g.enabled).length + 1} включено
          </h2>
          <p className="muted">
            Все включённые классификаторы анализируют разговор одновременно. Каждый возвращает свой
            результат: сценарий, возражения, готовность купить и другие признаки складываются в
            общую карточку. Выбор ниже открывает редактор, а не переключает активный классификатор.
          </p>
        </div>
      </div>
      <div className="classifier-list" aria-label="Все классификаторы">
        <article className={`classifier-item ${index < 0 ? 'selected' : ''}`}>
          <strong>Намерение клиента</strong>
          <small>Основные категории · всегда включён</small>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelected('__primary')}>
            Редактировать намерения
          </Button>
        </article>
        {settings.groups.map((g) => (
          <article key={g.id} className={`classifier-item ${selected === g.id ? 'selected' : ''}`}>
            <label className="check-label">
              <input
                type="checkbox"
                checked={g.enabled}
                onChange={(e) =>
                  change({
                    groups: settings.groups.map((v) =>
                      v.id === g.id ? { ...v, enabled: e.target.checked } : v,
                    ),
                  })
                }
              />
              <strong>{g.name || 'Новый классификатор'}</strong>
            </label>
            <small>
              {names[g.type || 'choice']} · порог{' '}
              {Math.round((g.threshold ?? settings.threshold) * 100)}%
            </small>
            <p>{g.instructions}</p>
            <small>
              {g.remember
                ? 'Запоминает последнее уверенное значение'
                : 'Оценивает текущее состояние'}
            </small>
            <div className="decision-toolbar">
              <Button type="button" size="sm" variant="outline" onClick={() => setSelected(g.id)}>
                Настроить
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={settings.groups.length >= 32}
                aria-label={`Дублировать ${g.name}`}
                onClick={() => {
                  const copy = {
                    ...structuredClone(g),
                    id: ruleTemplate(g.type || 'choice').id,
                    name: `${g.name.slice(0, 90)} · копия`,
                  };
                  change({ groups: [...settings.groups, copy] });
                  setSelected(copy.id);
                }}
              >
                <Copy size={14} />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Удалить ${g.name}`}
                onClick={() => {
                  change({ groups: settings.groups.filter((v) => v.id !== g.id) });
                  if (selected === g.id) setSelected('__primary');
                }}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </article>
        ))}
      </div>
      <div className="decision-toolbar">
        {(['choice', 'noul', 'score'] as Kind[]).map((k) => (
          <Button
            key={k}
            type="button"
            size="sm"
            variant="outline"
            disabled={settings.groups.length >= 32}
            onClick={() => add(k)}
          >
            <Plus size={14} />
            {names[k]}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={settings.groups.length > 26}
          onClick={() => {
            const use = { ...ruleTemplate('choice'), remember: true };
            const price = ruleTemplate('noul');
            const ready = ruleTemplate('score');
            const urgency = {
              ...ruleTemplate('score'),
              name: 'Срочность',
              instructions: 'Насколько срочно клиенту нужно решение?',
              levels: [
                'Срок не назван',
                'Есть план на ближайшее время',
                'Нужно сегодня',
                'Требуется немедленно',
              ],
              scoreThreshold: 2,
            };
            const customer = {
              ...ruleTemplate('choice'),
              remember: true,
              name: 'Тип обращения',
              instructions: 'Связь нужна для личного использования или бизнеса?',
              choices: [
                { id: 'personal', name: 'Личное', description: 'Для себя или семьи' },
                {
                  id: 'business',
                  name: 'Бизнес',
                  description: 'Для компании, сотрудников или рабочих задач',
                },
              ],
            };
            const extra = {
              ...ruleTemplate('noul'),
              name: 'Есть дополнительная потребность',
              instructions: 'Клиент явно назвал ещё одну потребность помимо основного обращения?',
              trueWhen: 'Назван отдельный товар, услуга или задача',
              falseWhen: 'Обсуждаются только подробности основного обращения',
            };
            change({ groups: [...settings.groups, use, price, ready, urgency, customer, extra] });
            setSelected(use.id);
          }}
        >
          Добавить набор для продаж · 6 классификаторов
        </Button>
      </div>
      <div className="decision-grid">
        <div className="decision-input">
          <div className="decision-types" role="group" aria-label="Тип решения">
            {(['choice', 'noul', 'score'] as Kind[]).map((k) => (
              <Button
                key={k}
                type="button"
                size="sm"
                variant={type === k ? 'default' : 'ghost'}
                disabled={index < 0 && k !== 'choice'}
                onClick={() =>
                  index >= 0 &&
                  update({
                    ...ruleTemplate(k),
                    id: rule.id,
                    name: rule.name,
                    enabled: rule.enabled,
                  })
                }
              >
                {names[k]} <code>{k}</code>
              </Button>
            ))}
          </div>
          {index >= 0 && (
            <>
              <div className="settings-heading">
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) => update({ enabled: e.target.checked })}
                  />
                  Использовать в разговоре
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={!!rule.remember}
                    onChange={(e) => update({ remember: e.target.checked })}
                  />
                  Запоминать последнее уверенное значение
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Удалить вопрос"
                  onClick={() => {
                    change({ groups: settings.groups.filter((_, i) => i !== index) });
                    setSelected('__primary');
                  }}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
              <label>
                Название в карточке
                <input
                  required
                  maxLength={100}
                  value={rule.name}
                  onChange={(e) => update({ name: e.target.value })}
                />
              </label>
            </>
          )}
          <label>
            Вопрос к модели
            <textarea
              rows={3}
              required
              maxLength={800}
              value={rule.instructions}
              readOnly={index < 0}
              onChange={(e) => update({ instructions: e.target.value })}
            />
          </label>
          <p className="decision-explanation">
            {type === 'choice'
              ? 'Модель выбирает один из этих вариантов. «Не определено» добавляется автоматически.'
              : type === 'noul'
                ? 'Модель оценивает вероятность «Да». Опишите оба случая, чтобы она различала их.'
                : 'Модель оценивает ситуацию по уровням от низкого к высокому. Результат может быть дробным.'}
          </p>
          {type === 'choice' &&
            rule.choices.map((v, j) => (
              <div className="decision-option" key={j}>
                <div className="settings-heading">
                  <strong>
                    {j + 1}. {v.name || 'Новый вариант'}
                  </strong>
                  {index >= 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Удалить вариант ${v.name}`}
                      disabled={rule.choices.length <= 2}
                      onClick={() => update({ choices: rule.choices.filter((_, at) => at !== j) })}
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
                <div className="form-grid">
                  <label>
                    Возвращать как
                    <input
                      required
                      pattern="[a-z][a-z0-9_]{0,59}"
                      value={v.id}
                      readOnly={index < 0}
                      onChange={(e) => editOption(j, { id: e.target.value })}
                    />
                  </label>
                  <label>
                    Показывать в карточке
                    <input
                      required
                      maxLength={100}
                      value={v.name}
                      onChange={(e) => editOption(j, { name: e.target.value })}
                    />
                  </label>
                  <label className="full">
                    Выбирать, когда
                    <textarea
                      required
                      maxLength={index < 0 ? 600 : 400}
                      rows={2}
                      value={v.description}
                      onChange={(e) => editOption(j, { description: e.target.value })}
                    />
                  </label>
                </div>
              </div>
            ))}
          {type === 'choice' && (
            <div className="decision-option">
              <strong>
                Не определено · <code>unknown</code>
              </strong>
              <p className="muted">Недостаточно данных или ни один вариант не подходит.</p>
            </div>
          )}
          {type === 'choice' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={index >= 0 ? rule.choices.length >= 12 : settings.intents.length >= 40}
              onClick={() => {
                if (index < 0) {
                  change({
                    intents: [
                      ...settings.intents,
                      {
                        id: `intent_${Date.now()}`,
                        name: '',
                        description: '',
                        direction: 'sales',
                        enabled: true,
                      },
                    ],
                  });
                  return;
                }
                let n = rule.choices.length + 1;
                while (rule.choices.some((v) => v.id === `option_${n}`)) n++;
                update({
                  choices: [...rule.choices, { id: `option_${n}`, name: '', description: '' }],
                });
              }}
            >
              <Plus size={14} />
              Добавить вариант
            </Button>
          )}
          {type === 'choice' && index < 0 && (
            <p className="muted">
              Названия и условия можно менять прямо здесь. Дополнительные намерения, их ключи и
              направления — в разделе «Все намерения и направления» ниже. Опубликованные процессы
              входят в этот список автоматически.
            </p>
          )}
          {type === 'noul' && (
            <div className="decision-binary">
              <label>
                Да, когда
                <textarea
                  rows={4}
                  required
                  maxLength={800}
                  value={rule.trueWhen || ''}
                  onChange={(e) => update({ trueWhen: e.target.value })}
                />
              </label>
              <label>
                Нет, когда
                <textarea
                  rows={4}
                  required
                  maxLength={800}
                  value={rule.falseWhen || ''}
                  onChange={(e) => update({ falseWhen: e.target.value })}
                />
              </label>
            </div>
          )}
          {type === 'score' && (
            <>
              <p className="muted">Уровни · от низкого к высокому</p>
              {(rule.levels || []).map((level, i) => (
                <div className="decision-level" key={i}>
                  <strong>{i}</strong>
                  <textarea
                    required
                    rows={2}
                    maxLength={400}
                    value={level}
                    onChange={(e) =>
                      update({
                        levels: rule.levels?.map((v, at) => (at === i ? e.target.value : v)),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={(rule.levels?.length || 0) <= 2}
                    aria-label={`Удалить уровень ${i}`}
                    onClick={() => {
                      const levels = rule.levels?.filter((_, at) => at !== i) || [];
                      update({
                        levels,
                        scoreThreshold: Math.min(rule.scoreThreshold || 0, levels.length - 1),
                      });
                    }}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={(rule.levels?.length || 0) >= 10}
                onClick={() => update({ levels: [...(rule.levels || []), ''] })}
              >
                <Plus size={14} />
                Добавить уровень
              </Button>
              <label>
                Порог оценки · {rule.scoreThreshold ?? 1}
                <input
                  type="range"
                  min={0}
                  max={(rule.levels?.length || 2) - 1}
                  step={0.1}
                  value={rule.scoreThreshold ?? 1}
                  onChange={(e) => update({ scoreThreshold: Number(e.target.value) })}
                />
              </label>
              <small>
                При оценке от {rule.scoreThreshold ?? 1} и достаточной уверенности порог считается
                достигнутым.
              </small>
            </>
          )}
          <label>
            Порог уверенности · {Math.round(threshold * 100)}%
            <input
              type="range"
              min={0.5}
              max={0.99}
              step={0.01}
              value={threshold}
              disabled={index < 0}
              onChange={(e) => update({ threshold: Number(e.target.value) })}
            />
          </label>
          <small className="muted">
            Ниже порога — «Не определено». Для «Да/Нет» нужен уверенный ответ в одну из сторон.
            Пороги признаков не выполняют операции автоматически.
          </small>
          {index >= 0 && (
            <details>
              <summary>Ключ результата</summary>
              <code>{rule.id}</code>
              <p className="muted">Уникальный ключ в контексте ассистента.</p>
            </details>
          )}
        </div>
        <div className="decision-preview">
          <h3>Проверка решения</h3>
          <label>
            Состояние / тестовый разговор
            <textarea
              rows={7}
              maxLength={8000}
              value={state}
              onChange={(e) => setState(e.target.value)}
            />
          </label>
          <Button type="button" disabled={busy || !state.trim()} onClick={() => void test()}>
            <Play size={16} />
            {busy
              ? 'Проверяем набор…'
              : `Проверить весь набор · ${settings.groups.filter((g) => g.enabled).length + 1}`}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy || !state.trim()}
            onClick={() => void test(false)}
          >
            Проверить только открытый классификатор
          </Button>
          <p className="muted">
            Все включённые вопросы → один вызов Decision Model. Проверяются текущие поля, сохранять
            заранее не нужно. Резервная LLM в этой проверке не вызывается.
          </p>
          {error && (
            <div role="alert" className="error-banner">
              {error}
            </div>
          )}
          {!result && !busy && (
            <div className="decision-empty">
              Проверьте набор, чтобы увидеть все результаты вместе.
            </div>
          )}
          {result?.demo && (
            <div className="decision-empty">
              Учебный режим: запрос подготовлен, но в Alibaba не отправлен. Для вероятностей нужен
              рабочий режим с ключом.
            </div>
          )}
          {!!result?.results.length && (
            <div className="classifier-summary" aria-live="polite">
              <h3>Общий контекст · {result.results.length} результатов</h3>
              <p className="muted">
                {(result.latencyMs / 1000).toFixed(2)} с · один запрос. Все признаки доступны
                ассистенту вместе.
              </p>
              {result.results.map((v) => (
                <div key={v.id}>
                  <strong>{v.name}</strong>
                  <span>{v.label.label}</span>
                  <small>{Math.round(v.label.confidence * 100)}%</small>
                </div>
              ))}
            </div>
          )}
          {selectedResult?.answer && (
            <div className="decision-result" aria-live="polite">
              <strong>{selectedResult.label?.label}</strong>
              {selectedResult.answer.type === 'score' && (
                <p>
                  Оценка модели: {selectedResult.answer.score.toFixed(2)} /{' '}
                  {(rule.levels?.length || 1) - 1}
                </p>
              )}
              <p>
                {(selectedResult.latencyMs / 1000).toFixed(2)} с · уверенность{' '}
                {Math.round(
                  (selectedResult.answer.type === 'noul'
                    ? Math.max(selectedResult.answer.noul, 1 - selectedResult.answer.noul)
                    : selectedResult.answer.confidence) * 100,
                )}
                %
              </p>
              {type !== 'choice' && (
                <p>
                  {passed === null
                    ? 'Недостаточно уверенности для решения'
                    : passed
                      ? 'Порог достигнут'
                      : 'Порог не достигнут'}
                </p>
              )}
              {probability ? (
                options.map(([id, name]) => (
                  <div className="decision-probability" key={id}>
                    <div>
                      <span>{name}</span>
                      <strong>
                        {probability[id] == null ? '—' : `${(probability[id] * 100).toFixed(1)}%`}
                      </strong>
                    </div>
                    <meter
                      min={0}
                      max={1}
                      value={probability[id] || 0}
                      aria-label={`Вероятность: ${name}`}
                    />
                  </div>
                ))
              ) : (
                <p className="muted">Провайдер не вернул распределение вероятностей.</p>
              )}
            </div>
          )}
          <details>
            <summary>Что получает модель · JSON</summary>
            <pre>
              {JSON.stringify(
                result?.request || {
                  model: settings.model,
                  state: { instructions: settings.instructions, transcript: state },
                  questions: Object.fromEntries(
                    [
                      { ...intentRule, id: '_primary_intent' },
                      ...settings.groups.filter((g) => g.enabled),
                    ].map((g) => [g.id, decisionQuestion(g)]),
                  ),
                },
                null,
                2,
              )}
            </pre>
            <small className="muted">
              После проверки здесь точный отправленный запрос: чувствительные реквизиты маскируются
              сервером.
            </small>
          </details>
          {result?.response != null && (
            <details>
              <summary>Ответ провайдера · JSON</summary>
              <pre>{JSON.stringify(result.response, null, 2)}</pre>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
