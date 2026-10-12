'use client';
import { useMemo, useRef, useState } from 'react';
import { roleLabels, type Conversation } from '@sufler/shared';
import { Button } from './ui/button';
export function RecordingPlayer({ conversation: c }: { conversation: Conversation }) {
  const player = useRef<HTMLAudioElement>(null),
    list = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(-1),
    [follow, setFollow] = useState(true),
    [error, setError] = useState('');
  const lastActive = useRef('');
  const layout = useMemo(() => {
    let offset = 0;
    return [...c.recordings]
      .sort((a, b) => a.startMs - b.startMs)
      .map((r) => {
        const piece = { ...r, offset };
        offset += r.endMs - r.startMs;
        return piece;
      });
  }, [c.recordings]);
  const duration = layout.reduce((n, r) => n + r.endMs - r.startMs, 0);
  const position = (ms: number) => {
    const p = layout.find((r) => ms >= r.startMs && ms < r.endMs);
    return p ? (p.offset + ms - p.startMs) / 1000 : null;
  };
  const active = c.segments.filter((s) => time >= s.startMs && time < s.endMs);
  const update = () => {
    const ms = (player.current?.currentTime || 0) * 1000,
      p = layout.find((r) => ms >= r.offset && ms < r.offset + r.endMs - r.startMs);
    const absolute = p ? p.startMs + ms - p.offset : -1;
    setTime(absolute);
    const id = c.segments.find((s) => absolute >= s.startMs && absolute < s.endMs)?.id;
    if (follow && id && lastActive.current !== id) {
      const el = list.current?.querySelector<HTMLElement>(`[data-segment="${CSS.escape(id)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      lastActive.current = id;
    }
  };
  return (
    <section className="dialog-playback">
      <div className="recording-player">
        <strong>
          {duration
            ? `Запись диалога · ${Math.round(duration / 1000)} с`
            : 'Аудиозапись отсутствует'}
        </strong>
        {duration > 0 ? (
          <>
            <audio
              ref={player}
              controls
              preload="metadata"
              src={`/api/conversations/${c.id}/audio`}
              onTimeUpdate={update}
              onSeeked={update}
              onEnded={() => setTime(-1)}
              onError={() =>
                setError('Запись недоступна. Проверьте хранилище или повторите позже.')
              }
            />
            <div className="playback-tools">
              <label>
                Скорость{' '}
                <select
                  defaultValue="1"
                  onChange={(e) => {
                    if (player.current) player.current.playbackRate = Number(e.target.value);
                  }}
                >
                  {[0.75, 1, 1.25, 1.5, 2].map((v) => (
                    <option key={v} value={v}>
                      {v}×
                    </option>
                  ))}
                </select>
              </label>
              <a href={`/api/conversations/${c.id}/audio?download=1`}>Скачать WAV</a>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFollow(true);
                  lastActive.current = '';
                  update();
                }}
              >
                Следовать за аудио
              </Button>
            </div>
            {layout.some((r, i) => i > 0 && r.startMs > layout[i - 1].endMs + 1) && (
              <small className="muted">
                В записи есть пропуски: несохранённые участки пропущены при воспроизведении.
              </small>
            )}
            {c.audioStartMs === undefined && (
              <small className="muted">
                Старая запись: точность синхронизации зависит от сохранённых меток.
              </small>
            )}
          </>
        ) : (
          <p className="muted">Звук этого диалога не был сохранён.</p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <div
        ref={list}
        className="playback-transcript"
        onWheel={() => setFollow(false)}
        onTouchMove={() => setFollow(false)}
        onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(e.key)) setFollow(false);
        }}
      >
        {c.segments.map((s) => {
          const at = position(s.startMs),
            isActive = active.some((a) => a.id === s.id);
          return (
            <button
              key={s.id}
              data-segment={s.id}
              className={`playback-turn ${isActive ? 'playing' : ''}`}
              aria-current={isActive ? 'true' : undefined}
              disabled={at === null}
              onClick={() => {
                if (player.current && at !== null) {
                  player.current.currentTime = at;
                  update();
                }
              }}
            >
              <small>
                {roleLabels[s.role]} ·{' '}
                {at === null
                  ? 'нет аудио'
                  : `${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, '0')}`}
              </small>
              <span>{s.text}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
