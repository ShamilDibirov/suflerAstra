'use client';
import { useEffect, useRef, useState } from 'react';
import { Plus, Play, Trash2 } from 'lucide-react';
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
  const base = { id: `rule_${Date.now()}`, enabled: true, threshold: 0.85, choices: [], type };
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
  const [selected, setSelected] = useState('intent');
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
  }, [settings, state, selected]);
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
  const question = decisionQuestion(rule);
  const probability =
    result?.answer?.type === 'noul'
      ? { false: 1 - result.answer.noul, true: result.answer.noul }
      : result?.answer && 'probabilities' in result.answer
        ? result.answer.probabilities
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
  const passed = decisionPassed(rule, result?.answer || undefined, settings.threshold);
  const test = async () => {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const r = await post<TestResult>('/admin/classification/playground', {
        settings,
        transcript: state,
        target: index < 0 ? 'intent' : 'rule',
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
          <h2>Конструктор решений</h2>
          <p className="muted">
            Задайте вопрос, перечислите ответы и объясните, когда выбирать каждый. Результат
            сохранится в карточке клиента и станет доступен ассистенту.
          </p>
        </div>
      </div>
      <label>
        Какой вопрос настраиваем
        <select
          value={index < 0 ? 'intent' : selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="intent">Намерение клиента · основные категории</option>
          {settings.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
              {g.enabled ? '' : ' · выключен'}
            </option>
          ))}
        </select>
      </label>
      <div className="decision-toolbar">
        {(['choice', 'noul', 'score'] as Kind[]).map((k) => (
          <Button
            key={k}
            type="button"
            size="sm"
            variant="outline"
            disabled={settings.groups.length >= 8}
            onClick={() => add(k)}
          >
            <Plus size={14} />
            {names[k]}
          </Button>
        ))}
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
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Удалить вопрос"
                  onClick={() => {
                    change({ groups: settings.groups.filter((_, i) => i !== index) });
                    setSelected('intent');
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
            {busy ? 'Проверяем…' : 'Запустить решение'}
          </Button>
          <p className="muted">
            Один вопрос → один вызов Decision Model. Проверяются текущие поля, сохранять заранее не
            нужно. Резервная LLM в этой проверке не вызывается.
          </p>
          {error && (
            <div role="alert" className="error-banner">
              {error}
            </div>
          )}
          {!result && !busy && (
            <div className="decision-empty">
              Запустите решение, чтобы увидеть ответ и вероятности.
            </div>
          )}
          {result?.demo && (
            <div className="decision-empty">
              Учебный режим: запрос подготовлен, но в Alibaba не отправлен. Для вероятностей нужен
              рабочий режим с ключом.
            </div>
          )}
          {result?.answer && (
            <div className="decision-result" aria-live="polite">
              <strong>{result.label?.label}</strong>
              {result.answer.type === 'score' && (
                <p>
                  Оценка модели: {result.answer.score.toFixed(2)} / {(rule.levels?.length || 1) - 1}
                </p>
              )}
              <p>
                {(result.latencyMs / 1000).toFixed(2)} с · уверенность{' '}
                {Math.round(
                  (result.answer.type === 'noul'
                    ? Math.max(result.answer.noul, 1 - result.answer.noul)
                    : result.answer.confidence) * 100,
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
                  questions: { [rule.id]: question },
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
