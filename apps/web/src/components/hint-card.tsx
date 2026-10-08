'use client';
import {
  ArrowUpRight,
  BookOpen,
  Check,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { Hint } from '@sufler/shared';
import { Button } from './ui/button';
export function HintCard({
  hint,
  busy,
  onHint,
  onChat,
  onSource,
  onComplete,
  emptyMessage,
}: {
  emptyMessage?: string;
  hint: Hint | undefined;
  busy: boolean;
  onHint: () => void;
  onChat: () => void;
  onSource: () => void;
  onComplete: () => void;
}) {
  return (
    <section className="panel hint-panel" aria-live="polite">
      <div className="hint-top">
        <span className="hint-label">
          <Sparkles size={16} /> ПОДСКАЗКА СУФЛЁРА
        </span>
        <span className="hint-auto">
          <span className="green-dot" />
          {busy
            ? 'Обновляем…'
            : hint?.kind === 'coaching'
              ? 'По промпту продаж'
              : 'На основе вашей базы'}
        </span>
      </div>
      {hint ? (
        <>
          <h2 className="hint-title">
            {hint.kind === 'coaching'
              ? 'Следующий шаг в разговоре'
              : hint.kind === 'service'
                ? 'Помогите клиенту сделать следующий шаг'
                : hint.kind === 'sales'
                  ? 'Есть подходящее предложение'
                  : 'Уточним, прежде чем советовать'}
          </h2>
          <p className="hint-body">{hint.text}</p>
          {hint.blocks.length > 0 && (
            <button className="hint-source" onClick={onSource}>
              <BookOpen size={13} />
              {hint.blocks[0].title}
              <ArrowUpRight size={12} />
            </button>
          )}
        </>
      ) : (
        <div className="hint-empty">
          <h2 className="hint-title">Ожидаем следующий шаг</h2>
          <p className="hint-body">
            {emptyMessage ||
              'Начните консультацию. Подсказка появится, когда в опубликованной базе найдётся подтверждённый следующий шаг.'}
          </p>
        </div>
      )}
      <div className="hint-footer">
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={onHint} disabled={busy} size="sm">
            <Sparkles size={14} />
            {busy ? 'Думаем…' : 'Подскажи'}
          </Button>
          <Button onClick={onChat} variant="outline" size="sm">
            <MessageSquare size={14} />
            Открыть чат
          </Button>
        </div>
        <span className="hint-footer-meta">
          <ShieldCheck size={12} />
          {hint?.kind === 'coaching'
            ? 'Рекомендация по общению · без базы'
            : 'Только подтверждённые знания'}
        </span>
      </div>
    </section>
  );
}
