'use client';
import { useState } from 'react';
import type { Conversation } from '@sufler/shared';

export function RecordingPlayer({ conversation }: { conversation: Conversation }) {
  const [index, setIndex] = useState(0),
    [continuous, setContinuous] = useState(false),
    [error, setError] = useState('');
  const recordings = conversation.recordings;
  const seconds = recordings.reduce((sum, r) => sum + (r.endMs - r.startMs) / 1000, 0);
  if (!recordings.length)
    return (
      <div className="recording-player">
        <strong>Аудиозапись отсутствует</strong>
        <p className="muted">
          Для этого диалога звук не был сохранён. Записи появятся для новых разговоров при
          включённом AUDIO_RECORDING_ENABLED на сервере.
        </p>
      </div>
    );
  return (
    <section className="recording-player" aria-label="Запись диалога">
      <strong>Аудиозапись · {Math.round(seconds)} с</strong>
      <audio
        key={index}
        controls
        preload="metadata"
        autoPlay={continuous}
        src={`/api/recordings/${conversation.id}/${index}`}
        onPlay={() => setContinuous(true)}
        onEnded={() => {
          if (index + 1 < recordings.length) setIndex(index + 1);
          else setContinuous(false);
        }}
        onError={() => setError('Не удалось загрузить запись. Проверьте доступность хранилища.')}
      />
      {recordings.length > 1 && (
        <select
          aria-label="Фрагмент записи"
          value={index}
          onChange={(e) => {
            setError('');
            setIndex(Number(e.target.value));
          }}
        >
          {recordings.map((r, i) => (
            <option key={r.key} value={i}>
              Часть {i + 1} · {Math.round(r.startMs / 1000)}–{Math.round(r.endMs / 1000)} с
            </option>
          ))}
        </select>
      )}
      <small className="muted">
        Части воспроизводятся последовательно. Паузы микрофона в запись не входят.
      </small>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
