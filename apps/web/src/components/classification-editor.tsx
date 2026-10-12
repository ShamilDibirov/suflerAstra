'use client';
import { useEffect, useState } from 'react';
import { Plus, Trash2, Play, Save } from 'lucide-react';
import {
  DEFAULT_CLASSIFICATION,
  type ClassificationSettings,
  type ConversationCard,
} from '@sufler/shared';
import { api, post } from '@/lib/api';
import { Button } from './ui/button';

type Intent = ClassificationSettings['intents'][number];
type Group = ClassificationSettings['groups'][number];
export function ClassificationEditor() {
  const [settings, setSettings] = useState<ClassificationSettings | null>(null);
  const [published, setPublished] = useState<Intent[]>([]),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false),
    [testing, setTesting] = useState(false);
  const [transcript, setTranscript] = useState(
    'Клиент: Хочу сим-карту для роутера на даче.\nКонсультант: Как часто будете пользоваться?\nКлиент: По выходным, бюджет до 500 рублей.',
  );
  const [result, setResult] = useState<{
    card: ConversationCard;
    source: string;
    latencyMs: number;
    demo: boolean;
  } | null>(null);
  useEffect(() => {
    void api<{ settings: ClassificationSettings; publishedIntents: Intent[] }>(
      '/admin/classification',
    )
      .then((r) => {
        setSettings(r.settings);
        setPublished(r.publishedIntents);
      })
      .catch((e) => setError(e.message));
  }, []);
  const change = (values: Partial<ClassificationSettings>) => {
    setSettings((s) => s && { ...s, ...values });
    setSaved(false);
    setResult(null);
  };
  const intent = (i: number, values: Partial<Intent>) =>
    settings &&
    change({ intents: settings.intents.map((v, at) => (at === i ? { ...v, ...values } : v)) });
  const group = (i: number, values: Partial<Group>) =>
    settings &&
    change({ groups: settings.groups.map((v, at) => (at === i ? { ...v, ...values } : v)) });
  if (!settings)
    return (
      <section className="panel settings-panel">{error || 'Загружаем классификацию…'}</section>
    );
  return (
    <div className="classification-editor">
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          void post<ClassificationSettings>('/admin/classification', settings)
            .then((r) => {
              setSettings(r);
              setSaved(true);
            })
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <section className="panel settings-panel">
          <h2>Как понимать разговор</h2>
          <p className="muted">
            Настройки вашей организации. Новые реплики используют сохранённую версию. При недостатке
            данных доступен вариант «Не определено».
          </p>
          <div className="form-grid">
            <label>
              Decision Model
              <input
                required
                value={settings.model}
                onChange={(e) => change({ model: e.target.value })}
              />
            </label>
            <label>
              Резервная LLM
              <input
                required
                value={settings.fallbackModel}
                onChange={(e) => change({ fallbackModel: e.target.value })}
              />
            </label>
            <label>
              Порог уверенности
              <input
                type="number"
                min="0.5"
                max="0.99"
                step="0.01"
                required
                value={settings.threshold}
                onChange={(e) => change({ threshold: Number(e.target.value) })}
              />
              <small className="muted">
                Ниже порога намерение проверяет резервная модель; дополнительные лейблы остаются
                неопределёнными.
              </small>
            </label>
            <label className="full">
              Правила классификации
              <textarea
                rows={5}
                maxLength={4000}
                value={settings.instructions}
                onChange={(e) => change({ instructions: e.target.value })}
              />
            </label>
          </div>
        </section>
        <section className="panel settings-panel">
          <div className="settings-heading">
            <div>
              <h2>Намерения клиента</h2>
              <p className="muted">
                Имя показывается в карточке. Описание объясняет модели, когда выбирать намерение.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={settings.intents.length >= 40}
              onClick={() =>
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
                })
              }
            >
              <Plus size={16} />
              Намерение
            </Button>
          </div>
          {settings.intents.map((v, i) => (
            <div className="classification-rule" key={i}>
              <div className="settings-heading">
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={v.enabled}
                    onChange={(e) => intent(i, { enabled: e.target.checked })}
                  />
                  Включено
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Удалить намерение ${v.name || i + 1}`}
                  onClick={() => change({ intents: settings.intents.filter((_, at) => at !== i) })}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
              <div className="form-grid">
                <label>
                  ID
                  <input
                    pattern="[a-z][a-z0-9_]{0,59}"
                    required
                    value={v.id}
                    onChange={(e) => intent(i, { id: e.target.value })}
                  />
                </label>
                <label>
                  Название
                  <input
                    required
                    maxLength={100}
                    value={v.name}
                    onChange={(e) => intent(i, { name: e.target.value })}
                  />
                </label>
                <label>
                  Направление
                  <select
                    value={v.direction}
                    onChange={(e) =>
                      intent(i, { direction: e.target.value as Intent['direction'] })
                    }
                  >
                    <option value="sales">Продажи</option>
                    <option value="service">Сервис</option>
                    <option value="mixed">Смешанное</option>
                  </select>
                </label>
                <label className="full">
                  Когда выбирать
                  <textarea
                    required
                    rows={2}
                    maxLength={600}
                    value={v.description}
                    onChange={(e) => intent(i, { description: e.target.value })}
                  />
                </label>
              </div>
            </div>
          ))}
          {!!published.length && (
            <details>
              <summary>Намерения из опубликованной базы · {published.length}</summary>
              {published.map((v, i) => (
                <p key={i}>
                  <strong>{v.name}</strong> · <code>{v.id}</code>
                </p>
              ))}
              <p className="muted">
                Собственное намерение с таким же ID переопределяет описание. Выключенное намерение
                исключается и из базы.
              </p>
            </details>
          )}
        </section>
        <section className="panel settings-panel">
          <div className="settings-heading">
            <div>
              <h2>Дополнительные лейблы</h2>
              <p className="muted">
                Например, сценарий использования, срочность, готовность купить. Каждая группа задаёт
                один вопрос и варианты выбора.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={settings.groups.length >= 8}
              onClick={() =>
                change({
                  groups: [
                    ...settings.groups,
                    {
                      id: `label_${Date.now()}`,
                      name: '',
                      instructions: '',
                      enabled: true,
                      choices: [
                        { id: 'option_a', name: '', description: '' },
                        { id: 'option_b', name: '', description: '' },
                      ],
                    },
                  ],
                })
              }
            >
              <Plus size={16} />
              Группа лейблов
            </Button>
          </div>
          {!settings.groups.length && (
            <p className="muted">
              Добавьте группу: её результат появится в карточке и контексте ассистента.
            </p>
          )}
          {settings.groups.map((g, i) => (
            <div className="classification-rule" key={i}>
              <div className="settings-heading">
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={g.enabled}
                    onChange={(e) => group(i, { enabled: e.target.checked })}
                  />
                  Включено
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Удалить группу ${g.name || i + 1}`}
                  onClick={() => change({ groups: settings.groups.filter((_, at) => at !== i) })}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
              <div className="form-grid">
                <label>
                  ID группы
                  <input
                    required
                    pattern="[a-z][a-z0-9_]{0,59}"
                    value={g.id}
                    onChange={(e) => group(i, { id: e.target.value })}
                  />
                </label>
                <label>
                  Название группы
                  <input
                    required
                    maxLength={100}
                    value={g.name}
                    onChange={(e) => group(i, { name: e.target.value })}
                  />
                </label>
                <label className="full">
                  Вопрос к Decision Model
                  <textarea
                    required
                    rows={2}
                    maxLength={800}
                    value={g.instructions}
                    onChange={(e) => group(i, { instructions: e.target.value })}
                  />
                </label>
              </div>
              {g.choices.map((v, j) => (
                <div className="classification-choice" key={j}>
                  <label>
                    ID варианта
                    <input
                      required
                      pattern="[a-z][a-z0-9_]{0,59}"
                      value={v.id}
                      onChange={(e) =>
                        group(i, {
                          choices: g.choices.map((x, at) =>
                            at === j ? { ...x, id: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    Лейбл
                    <input
                      required
                      maxLength={100}
                      value={v.name}
                      onChange={(e) =>
                        group(i, {
                          choices: g.choices.map((x, at) =>
                            at === j ? { ...x, name: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    Значение для модели
                    <input
                      required
                      maxLength={400}
                      value={v.description}
                      onChange={(e) =>
                        group(i, {
                          choices: g.choices.map((x, at) =>
                            at === j ? { ...x, description: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={g.choices.length <= 2}
                    aria-label={`Удалить лейбл ${v.name || j + 1}`}
                    onClick={() => group(i, { choices: g.choices.filter((_, at) => at !== j) })}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={g.choices.length >= 12}
                onClick={() =>
                  group(i, {
                    choices: [
                      ...g.choices,
                      { id: `option_${g.choices.length + 1}`, name: '', description: '' },
                    ],
                  })
                }
              >
                <Plus size={14} />
                Вариант
              </Button>
            </div>
          ))}
        </section>
        <div className="settings-save">
          <Button type="submit" disabled={busy}>
            <Save size={16} />
            {busy ? 'Сохраняем…' : 'Сохранить классификацию'}
          </Button>
          <span role="status">
            {saved
              ? 'Сохранено'
              : `Версия ${settings.revision} · изменения применяются после сохранения`}
          </span>
          <Button
            type="button"
            variant="ghost"
            onClick={() => change(structuredClone(DEFAULT_CLASSIFICATION))}
          >
            Стандартные настройки
          </Button>
        </div>
      </form>
      <section className="panel settings-panel">
        <h2>Проверить на разговоре</h2>
        <p className="muted">
          Можно проверить настройки до сохранения. В рабочем режиме тест вызывает Decision Model и
          LLM по тарифу вашего провайдера.
        </p>
        <label>
          Тестовый разговор
          <textarea
            rows={7}
            value={transcript}
            maxLength={8000}
            onChange={(e) => setTranscript(e.target.value)}
          />
        </label>
        <Button
          disabled={testing || !transcript.trim()}
          onClick={() => {
            setTesting(true);
            setError('');
            setResult(null);
            void post<typeof result>('/admin/classification/test', { settings, transcript })
              .then(setResult)
              .catch((e) => setError(e.message))
              .finally(() => setTesting(false));
          }}
        >
          <Play size={16} />
          {testing ? 'Анализируем…' : 'Проверить'}
        </Button>
        {result && (
          <div className="classification-result">
            <p>
              <strong>
                {result.demo
                  ? 'Учебный результат'
                  : result.source === 'decision'
                    ? 'Decision Model'
                    : 'Резервная LLM'}
              </strong>{' '}
              · {(result.latencyMs / 1000).toFixed(2)} с
            </p>
            <p>
              <strong>Намерение:</strong> {result.card.intentLabel || result.card.intent}
            </p>
            <p>
              <strong>Потребности:</strong> {result.card.needs.join(', ') || 'Не определены'}
            </p>
            {result.card.labels?.map((v) => (
              <p key={v.key}>
                <strong>{v.name}:</strong> {v.label} · {Math.round(v.confidence * 100)}%
              </p>
            ))}
            <details>
              <summary>Полная карточка</summary>
              <pre>{JSON.stringify(result.card, null, 2)}</pre>
            </details>
          </div>
        )}
      </section>
    </div>
  );
}
