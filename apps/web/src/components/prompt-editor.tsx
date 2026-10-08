'use client';
import { useEffect, useState } from 'react';
import type { PromptSettings } from '@sufler/shared';
import { api, post } from '@/lib/api';
import { Button } from './ui/button';

export function PromptEditor() {
  const [settings, setSettings] = useState<PromptSettings | null>(null);
  const [defaults, setDefaults] = useState<Pick<
    PromptSettings,
    'hintPrompt' | 'chatPrompt'
  > | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void api<{
      settings: PromptSettings;
      defaults: Pick<PromptSettings, 'hintPrompt' | 'chatPrompt'>;
    }>('/admin/prompts')
      .then((result) => {
        setSettings(result.settings);
        setDefaults(result.defaults);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <section className="panel" style={{ padding: 24 }}>
      <p className="info-banner">
        Эти промпты работают в режиме продаж, когда опубликованный скрипт не выбран. База знаний не
        нужна. Модель помогает вести разговор; цены, условия и сервисные регламенты проверяются
        отдельно.
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {!settings ? (
        <p>Загружаем промпты…</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            setSaved(false);
            void post<PromptSettings>('/admin/prompts', {
              hintPrompt: settings.hintPrompt,
              chatPrompt: settings.chatPrompt,
            })
              .then((result) => {
                setSettings(result);
                setSaved(true);
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {(['hintPrompt', 'chatPrompt'] as const).map((field) => (
            <label key={field} style={{ display: 'block', marginTop: 24 }}>
              <strong>
                {field === 'hintPrompt' ? 'Короткие подсказки' : 'Продолжение в чате'}
              </strong>
              <textarea
                aria-label={field === 'hintPrompt' ? 'Промпт подсказок' : 'Промпт чата'}
                className="input"
                rows={8}
                minLength={10}
                maxLength={6000}
                required
                disabled={busy}
                value={settings[field]}
                onChange={(e) => {
                  setSettings({ ...settings, [field]: e.target.value });
                  setSaved(false);
                }}
                style={{ width: '100%', marginTop: 8, resize: 'vertical' }}
              />
              <span className="muted">{settings[field].length} / 6000 символов</span>
            </label>
          ))}
          <div className="form-actions" style={{ marginTop: 24, flexWrap: 'wrap' }}>
            <Button type="submit" disabled={busy}>
              {busy ? 'Сохраняем…' : 'Сохранить промпты'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !defaults}
              onClick={() => {
                if (defaults) setSettings({ ...settings, ...defaults });
                setSaved(false);
              }}
            >
              Вернуть стандартные
            </Button>
          </div>
          <p className="muted" role="status">
            {saved
              ? 'Сохранено. Следующие подсказки и ответы используют новые промпты.'
              : `Версия ${settings.revision}. После редактирования нажмите «Сохранить промпты».`}
          </p>
        </form>
      )}
    </section>
  );
}
