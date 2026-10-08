'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  AudioLines,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  Edit3,
  Info,
  Mic,
  MicOff,
  MoreHorizontal,
  Play,
  Plus,
  Radio,
  Settings2,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
  PanelTop,
  Zap,
  Pause,
} from 'lucide-react';
import {
  type Conversation,
  type KnowledgeDocument,
  type ModelConfig,
  type TranscriptSegment,
  type AppEvent,
  directionLabels,
  stageLabels,
  roleLabels,
} from '@sufler/shared';
import { DEMO_SCENARIO } from '@sufler/shared/demo';
import { api, post, patch, formatTime } from '@/lib/api';
import { useSession } from '@/hooks/use-session';
import { useAudio } from '@/hooks/use-audio';
import { Shell, LoadingScreen } from './shell';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { HintCard } from './hint-card';
import { ChatPanel } from './chat-panel';
import { Brand } from './brand';

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(options: { width: number; height: number }): Promise<Window>;
    };
  }
}
export function Workspace() {
  const { user, error: sessionError } = useSession();
  const [conversation, setConversation] = useState<Conversation | null>(null),
    [models, setModels] = useState<ModelConfig[]>([]),
    [docs, setDocs] = useState<KnowledgeDocument[]>([]),
    [runtime, setRuntime] = useState({ ragEnabled: true, defaultAssistanceMode: 'rag' }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [toast, setToast] = useState('');
  const [text, setText] = useState(''),
    [role, setRole] = useState<'customer' | 'consultant'>('customer'),
    [chat, setChat] = useState(false),
    [source, setSource] = useState(false),
    [settings, setSettings] = useState(false),
    [edit, setEdit] = useState<TranscriptSegment | null>(null),
    [editText, setEditText] = useState(''),
    [editRole, setEditRole] = useState<TranscriptSegment['role']>('customer');
  const [pip, setPip] = useState<Window | null>(null),
    [partial, setPartial] = useState(''),
    [boundary, setBoundary] = useState<{ text: string; speakerId: string } | null>(null),
    [contextStatus, setContextStatus] = useState(''),
    [editingCard, setEditingCard] = useState(false),
    [cardIntent, setCardIntent] = useState(''),
    [cardLabel, setCardLabel] = useState(''),
    [cardRegion, setCardRegion] = useState('Все регионы');
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const notify = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(''), 5000);
  }, []);
  const onEvent = useCallback(
    (event: AppEvent) => {
      if (event.type === 'conversation.updated') {
        const c = event.data as Conversation;
        const current = conversationRef.current;
        if (
          c.id === current?.id ||
          ((!current || current.status !== 'active') && c.status === 'active')
        ) {
          conversationRef.current = c;
          setConversation((prev) =>
            !prev || prev.id !== c.id || c.card.revision >= prev.card.revision ? c : prev,
          );
        }
      }
      if (event.type === 'transcript.partial') setPartial((event.data as { text: string }).text);
      if (event.type === 'session.boundary')
        setBoundary((current) =>
          current?.speakerId === (event.data as { speakerId: string }).speakerId
            ? current
            : (event.data as { text: string; speakerId: string }),
        );
      if (event.type === 'context.status' && event.conversationId === conversationRef.current?.id)
        setContextStatus((event.data as { message: string }).message);
      if (event.type === 'error') {
        setError(String(event.data));
        setPartial('');
      }
      if (event.type === 'audio.status') {
        const data = event.data as { message?: string; status: string };
        if (data.message) notify(data.message);
        if (['stopped', 'enrolled'].includes(data.status)) setPartial('');
      }
    },
    [notify],
  );
  const audio = useAudio(conversation?.id, onEvent);
  useEffect(() => {
    if (!user) return;
    Promise.all([
      api<Conversation[]>('/conversations'),
      api<ModelConfig[]>('/models'),
      api<KnowledgeDocument[]>('/knowledge'),
      api<{ ragEnabled: boolean; defaultAssistanceMode: string }>('/config'),
    ])
      .then(async ([history, list, knowledge, settings]) => {
        setRuntime(settings);
        setModels(list);
        setDocs(knowledge);
        const active = history.find((c) => c.status === 'active');
        setConversation(active || (await post<Conversation>('/conversations')));
      })
      .catch((e) => setError(e.message));
  }, [user]);
  useEffect(() => {
    if (!conversation?.id) return;
    const id = conversation.id;
    const timer = setInterval(
      () =>
        api<Conversation>(`/conversations/${id}`)
          .then((c) =>
            setConversation((prev) =>
              prev?.id === id && c.card.revision >= prev.card.revision ? c : prev,
            ),
          )
          .catch(() => {}),
      3500,
    );
    return () => clearInterval(timer);
  }, [conversation?.id]);
  useEffect(() => () => pip?.close(), [pip]);
  async function refresh() {
    if (conversationRef.current)
      setConversation(await api<Conversation>(`/conversations/${conversationRef.current.id}`));
  }
  async function run(action: () => Promise<unknown>) {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(false);
    }
  }
  async function newClient() {
    audio.stop();
    setPartial('');
    setBoundary(null);
    setContextStatus('');
    const created = await post<Conversation>('/conversations', { modelId: conversation?.modelId });
    const mode = conversation?.assistanceMode;
    setConversation(
      mode && (mode === 'scripts' || runtime.ragEnabled)
        ? await patch<Conversation>(`/conversations/${created.id}`, { assistanceMode: mode })
        : created,
    );
  }
  async function hint() {
    if (conversation)
      await run(async () => {
        await post(`/conversations/${conversation.id}/hint`);
        await refresh();
      });
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!conversation || !text.trim()) return;
    const value = text;
    setText('');
    await run(async () =>
      setConversation(
        await post<Conversation>(`/conversations/${conversation.id}/segments`, {
          text: value,
          role,
        }),
      ),
    );
  }
  async function change(values: Record<string, unknown>) {
    if (conversation)
      await run(async () =>
        setConversation(await patch<Conversation>(`/conversations/${conversation.id}`, values)),
      );
  }
  async function demo() {
    await run(async () => {
      audio.stop();
      const next = await post<Conversation>('/conversations', { modelId: conversation?.modelId });
      setConversation(next);
      for (const line of DEMO_SCENARIO) {
        const c = await post<Conversation>(`/conversations/${next.id}/segments`, line);
        setConversation(c);
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      await post(`/conversations/${next.id}/hint`);
      setConversation(await api<Conversation>(`/conversations/${next.id}`));
    });
  }
  async function openPip() {
    if (!window.documentPictureInPicture) {
      notify(
        'Этот режим доступен в Chrome на компьютере. На телефоне используйте карточку на странице.',
      );
      return;
    }
    try {
      if (pip) {
        pip.close();
        setPip(null);
        return;
      }
      const target = await window.documentPictureInPicture.requestWindow({
        width: 410,
        height: 390,
      });
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const style = target.document.createElement('style');
          style.textContent = Array.from(sheet.cssRules)
            .map((r) => r.cssText)
            .join('\n');
          target.document.head.appendChild(style);
        } catch {
          if (sheet.href) {
            const link = target.document.createElement('link');
            link.rel = 'stylesheet';
            link.href = sheet.href;
            target.document.head.appendChild(link);
          }
        }
      }
      target.document.title = 'Суфлёр';
      target.addEventListener('pagehide', () => setPip(null));
      setPip(target);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не удалось открыть виджет');
    }
  }
  const currentHint = conversation?.hints.filter((h) => h.status === 'current').at(-1);
  const currentDoc = docs.find((d) => d.id === currentHint?.blocks[0]?.documentId);
  const upcoming = currentDoc?.blocks.find(
    (b) =>
      currentHint?.blocks.some((ref) => ref.blockId === b.id) &&
      b.kind === 'step' &&
      !conversation?.card.completedSteps.includes(b.id),
  );
  const card = conversation?.card;
  const live = ['listening', 'enrolling', 'connecting', 'finishing'].includes(audio.status);
  const Hint = (
    <HintCard
      hint={currentHint}
      emptyMessage={
        conversation?.error ||
        ((conversation?.assistanceMode || runtime.defaultAssistanceMode) === 'scripts' &&
        !conversation?.salesScriptId
          ? 'База знаний не нужна: начните разговор или нажмите «Подскажи». Модель предложит следующий вопрос по промпту продаж.'
          : undefined)
      }
      busy={busy}
      onHint={() => void hint()}
      onChat={() => {
        setChat(true);
        window.focus();
      }}
      onSource={() => {
        setSource(true);
        window.focus();
      }}
      onComplete={() => upcoming && void change({ completedStep: upcoming.id })}
    />
  );
  if (!user) return <LoadingScreen error={sessionError} />;
  return (
    <Shell user={user}>
      <div className="page-heading">
        <div>
          <h1>Диалог с клиентом</h1>
          <p>Сосредоточьтесь на разговоре. Подсказки — на нас.</p>
        </div>
        <div className="heading-actions">
          <div className="model-select">
            <select
              aria-label="Режим подсказок"
              value={conversation?.assistanceMode || runtime.defaultAssistanceMode}
              disabled={busy}
              onChange={(e) => void change({ assistanceMode: e.target.value })}
            >
              <option value="scripts">Продажи · промпт или скрипт</option>
              {runtime.ragEnabled && <option value="rag">По базе знаний</option>}
            </select>
          </div>
          <div className="model-select">
            <Sparkles size={14} />
            <select
              aria-label="Модель подсказок"
              value={conversation?.modelId || ''}
              onChange={(e) => void change({ modelId: e.target.value })}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <Button className="pip-trigger" variant="outline" onClick={() => void openPip()}>
            <PanelTop size={15} />
            Поверх окон
          </Button>
          <Button variant="outline" onClick={() => void run(newClient)} disabled={busy}>
            <Plus size={15} />
            Новый клиент
          </Button>
        </div>
      </div>
      {(conversation?.assistanceMode || runtime.defaultAssistanceMode) === 'scripts' && (
        <div className="info-banner" style={{ marginBottom: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            Режим продаж
            <select
              aria-label="Скрипт продажи"
              value={conversation?.salesScriptId || ''}
              disabled={busy}
              onChange={(e) => void change({ salesScriptId: e.target.value || null })}
            >
              <option value="">По промпту · без базы знаний</option>
              {docs
                .filter((d) => d.type === 'process' && d.direction === 'sales')
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
            </select>
          </label>
          <p style={{ marginTop: 8 }}>
            Без выбранного скрипта работают промпты продаж и чата. При выборе скрипта подтверждайте
            выполненные шаги.
          </p>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="error-banner"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          {error}
          <button className="icon-btn" onClick={() => setError('')} aria-label="Закрыть ошибку">
            <X size={16} />
          </button>
        </div>
      )}
      <div className="work-grid">
        <div className="work-main">
          <section className="panel">
            <div className="audio-strip">
              <span className={`mic-symbol ${live ? 'live' : ''}`}>
                <Mic size={18} />
              </span>
              <div className="audio-copy">
                <strong>
                  {audio.status === 'paused'
                    ? 'Микрофон на паузе'
                    : audio.status === 'finishing'
                      ? 'Обрабатываем последние реплики…'
                      : audio.status === 'enrolling'
                        ? 'Знакомимся с вашим голосом…'
                        : audio.status === 'listening'
                          ? 'Суфлёр слушает разговор'
                          : audio.status === 'connecting'
                            ? 'Подключаем микрофон…'
                            : 'Микрофон выключен'}
                </strong>
                <small>
                  {live
                    ? 'Запись активна · текст и аудио сохраняются 30 дней'
                    : user.demo
                      ? 'Учебный диалог · звук не записывается'
                      : 'Выберите микрофон и начните консультацию'}
                </small>
              </div>
              <span className={`wave ${live ? 'live' : ''}`} aria-hidden>
                {[7, 13, 9, 18, 24, 15, 10, 20, 14, 8, 16].map((h, i) => (
                  <i
                    key={i}
                    style={
                      {
                        height: live ? Math.max(4, h * audio.level) : h * 0.45,
                        '--i': i,
                      } as React.CSSProperties
                    }
                  />
                ))}
              </span>
              <Button
                disabled={audio.draining && !live}
                variant={live ? 'secondary' : 'outline'}
                onClick={() => {
                  if (user.demo) {
                    notify(
                      'В демо используйте «Запустить пример» или введите реплику. Реальный микрофон доступен после настройки сервисов.',
                    );
                    return;
                  }
                  live ? audio.stop() : void audio.start();
                }}
              >
                {live ? <Pause size={13} /> : <Mic size={13} />}{' '}
                {live
                  ? 'Пауза'
                  : audio.draining
                    ? 'Завершаем обработку…'
                    : audio.status === 'paused'
                      ? 'Продолжить'
                      : 'Включить'}
              </Button>
              <button
                className="icon-btn"
                onClick={() => {
                  setSettings(!settings);
                  void audio.refreshDevices().catch(() => {});
                }}
                aria-label="Настройки микрофона"
              >
                <Settings2 size={16} />
              </button>
            </div>
            {settings && (
              <div className="audio-settings">
                <select
                  value={audio.deviceId}
                  onChange={(e) => audio.setDeviceId(e.target.value)}
                  aria-label="Устройство записи"
                >
                  <option value="">Микрофон по умолчанию</option>
                  {audio.devices.map((d, i) => (
                    <option value={d.deviceId} key={d.deviceId || i}>
                      {d.label || `Микрофон ${i + 1}`}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={live || user.demo}
                  onClick={() => void audio.start(true)}
                >
                  {audio.enrolled ? 'Перезаписать голос' : 'Записать мой голос · 25 с'}
                </Button>
              </div>
            )}
          </section>
          {Hint}
          <section className="panel next-step">
            <span className="next-step-icon">
              <CheckCheck size={17} />
            </span>
            <div className="next-step-copy">
              <span>ПРОЦЕСС ПОД КОНТРОЛЕМ</span>
              <strong>
                {upcoming
                  ? 'Подтвердите шаг после его выполнения'
                  : 'Каждый шаг — с опорой на регламент'}
              </strong>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!upcoming || busy}
              onClick={() => upcoming && void change({ completedStep: upcoming.id })}
            >
              <Check size={13} />
              Шаг выполнен
            </Button>
          </section>
          <section className="panel">
            <div className="panel-header transcript-header">
              <h3>
                <AudioLines size={16} />
                Ход разговора
              </h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {user.demo && (
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => void demo()}
                  >
                    <Play size={12} />
                    Запустить пример
                  </button>
                )}
                <span className="live-label">
                  <Radio size={12} />
                  {conversation?.segments.length || 0} реплик
                </span>
              </div>
            </div>
            {boundary && (
              <section
                className="panel speaker-notice"
                aria-label="Назначить новый голос"
                style={{ margin: '16px 0', padding: 20 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                    <strong>Неизвестный голос</strong>
                    <p className="muted">Эта реплика пока вне контекста. Запись продолжается.</p>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      audio.assign(boundary.speakerId, 'bystander');
                      setBoundary(null);
                    }}
                  >
                    Не учитывать
                  </Button>
                </div>
                <p className="source-quote">{boundary?.text}</p>
                <div className="form-actions" style={{ flexWrap: 'wrap' }}>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (boundary) audio.assign(boundary.speakerId, 'bystander');
                      setBoundary(null);
                    }}
                  >
                    Посторонний
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      audio.assign(boundary.speakerId, 'consultant');
                      setBoundary(null);
                    }}
                  >
                    Это мой голос
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void run(async () => {
                        if (boundary && conversation) {
                          audio.assign(boundary.speakerId, 'customer');
                          setBoundary(null);
                        }
                      })
                    }
                  >
                    Текущий клиент
                  </Button>
                  <Button
                    onClick={() =>
                      void run(async () => {
                        if (boundary) {
                          audio.stop();
                          const c = await post<Conversation>('/conversations', {
                            modelId: conversation?.modelId,
                          });
                          setConversation(
                            await post<Conversation>(`/conversations/${c.id}/segments`, {
                              text: boundary.text,
                              role: 'customer',
                            }),
                          );
                          setBoundary(null);
                        }
                      })
                    }
                  >
                    Новый клиент
                  </Button>
                </div>
              </section>
            )}
            <div className="transcript-list">
              {!conversation?.segments.length && (
                <div className="empty-state" style={{ padding: 15 }}>
                  <AudioLines size={24} />
                  <p>Здесь появятся реплики консультанта и клиента.</p>
                </div>
              )}
              {conversation?.segments.map((s) => (
                <div className={`transcript-row ${s.excluded ? 'excluded' : ''}`} key={s.id}>
                  <span className={`speaker-avatar ${s.role === 'customer' ? 'customer' : ''}`}>
                    {s.role === 'consultant' ? <AudioLines size={13} /> : <UserRound size={13} />}
                  </span>
                  <div className="speech-content">
                    <div className="speech-meta">
                      <strong>{roleLabels[s.role]}</strong>
                      <time>{formatTime(s.createdAt)}</time>
                      {s.excluded && <span className="tag gray">Вне контекста</span>}
                    </div>
                    <p>{s.text}</p>
                  </div>
                  <button
                    className="icon-btn speech-edit"
                    aria-label="Исправить реплику"
                    onClick={() => {
                      setEdit(s);
                      setEditText(s.text);
                      setEditRole(s.role);
                    }}
                  >
                    <Edit3 size={12} />
                  </button>
                </div>
              ))}
              {partial && (
                <p aria-live="polite" style={{ fontSize: 15 }}>
                  <span className="muted">Сейчас говорят · предварительный текст</span>
                  <br />
                  {partial}
                </p>
              )}
            </div>
            <form className="transcript-input" onSubmit={send}>
              <select
                aria-label="Кто говорит"
                value={role}
                onChange={(e) => setRole(e.target.value as typeof role)}
              >
                <option value="customer">Клиент</option>
                <option value="consultant">Консультант</option>
              </select>
              <input
                aria-label="Реплика"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Добавьте реплику вручную…"
              />
              <Button size="icon" disabled={busy || !text.trim()} aria-label="Добавить реплику">
                <ArrowUp size={16} />
              </Button>
            </form>
            <div className="transcript-tip">
              В контекст попадают только подтверждённые реплики вашего диалога
            </div>
          </section>
        </div>
        <aside>
          <section className="panel context-panel">
            <div className="panel-header">
              <h3>
                <UserRound size={15} />
                Контекст клиента
              </h3>
              <button
                className="icon-btn"
                aria-label="Редактировать контекст"
                onClick={() => {
                  setEditingCard(true);
                  setCardLabel(card?.label || '');
                  setCardIntent(card?.intent || 'unknown');
                  setCardRegion(conversation?.region || 'Все регионы');
                }}
              >
                <Edit3 size={13} />
              </button>
            </div>
            <div className="context-intro">
              <span className="customer-icon">
                <UserRound size={21} />
              </span>
              <div>
                <strong>{card?.label || 'Новый клиент'}</strong>
                <p>
                  <span className="green-dot" style={{ display: 'inline-block', marginRight: 4 }} />
                  Консультация в процессе
                </p>
              </div>
            </div>
            <div className="context-body">
              <dl className="context-group">
                <dt>Направление</dt>
                <dd>
                  <span className="tag">{directionLabels[card?.direction || 'unknown']}</span>
                </dd>
              </dl>
              <dl className="context-group">
                <dt>Намерение</dt>
                <dd>
                  {docs.find((d) => d.intent === card?.intent)?.title || 'Уточняем запрос клиента'}
                </dd>
              </dl>
              <dl className="context-group">
                <dt>Что важно клиенту</dt>
                <dd className="context-needs">
                  {card?.needs.length
                    ? card.needs.map((n) => (
                        <span key={n}>
                          <Check size={11} />
                          {n}
                        </span>
                      ))
                    : 'Потребности пока не определены'}
                  {card?.facts.map((f) => (
                    <span key={f.key}>
                      <Check size={11} />
                      {f.value}
                    </span>
                  ))}
                </dd>
              </dl>
              <dl className="context-group">
                <dt>Этап диалога</dt>
                <dd>
                  <span className="tag green">{stageLabels[card?.stage || 'discovery']}</span>
                </dd>
              </dl>
              {card?.missing.length ? (
                <div className="context-note">
                  <Info size={13} />
                  <span>{card.missing.join('. ')}</span>
                </div>
              ) : null}
            </div>
            {conversation?.error && (
              <div className="context-note" role="status">
                Контекст не обновлён: {conversation.error}
              </div>
            )}
            <div className="context-footer">
              <Sparkles size={12} />
              {contextStatus ||
                (card?.classificationSource === 'demo'
                  ? 'Учебная классификация'
                  : card?.classificationSource === 'manual'
                    ? 'Уточнено консультантом'
                    : card?.classificationSource === 'qwen'
                      ? 'Контекст · резервный Qwen'
                      : card?.classificationSource === 'kev'
                        ? 'Контекст обновлён · KEV 4B'
                        : 'KEV ещё не определил контекст')}
              <span style={{ marginLeft: 'auto' }}>v{card?.revision || 0}</span>
            </div>
          </section>
          <div className="panel flow-panel">
            <h3>ОТ РАЗГОВОРА К РЕШЕНИЮ</h3>
            <div className="flow-stages">
              <span className="flow-node">Речь</span>
              <ChevronRight size={10} />
              <span className="flow-node active">Контекст</span>
              <ChevronRight size={10} />
              <span className="flow-node">Подсказка</span>
            </div>
            <p>
              Суфлёр помнит потребность клиента,
              <br />а факты проверяет в базе знаний.
            </p>
          </div>
        </aside>
      </div>
      <div className="bottom-toolbar">
        <div className="mode-switch">
          <button
            className={conversation?.autoHints ? 'selected' : ''}
            onClick={() => void change({ autoHints: true })}
          >
            <Zap size={12} />
            Автоматически
          </button>
          <button
            className={!conversation?.autoHints ? 'selected' : ''}
            onClick={() => void change({ autoHints: false })}
          >
            <Sparkles size={12} />
            По запросу
          </button>
        </div>
        <span className="keyboard-tip">
          <ShieldCheck size={12} />
          Ничего лишнего. Только следующий полезный шаг.
        </span>
        <Button variant="ghost" size="sm" onClick={() => void openPip()} className="pip-trigger">
          <PanelTop size={13} />
          Открыть компактный виджет
          <ArrowRight size={12} />
        </Button>
      </div>
      <div className="privacy-note">
        <ShieldCheck size={11} />
        Данные доступны только вашей организации · Хранятся 30 дней
      </div>
      <Dialog
        open={chat}
        onOpenChange={setChat}
        title="Продолжим консультацию"
        description={`${card?.label || 'Диалог'} · ${models.find((m) => m.id === conversation?.modelId)?.name || ''}`}
        wide
      >
        {conversation && (
          <ChatPanel
            key={conversation.id}
            conversation={conversation}
            onSent={() => void refresh()}
          />
        )}
      </Dialog>
      <Dialog
        open={source}
        onOpenChange={setSource}
        title="Источник подсказки"
        description="Точная выдержка из опубликованной базы знаний"
      >
        {currentHint?.blocks.map((b) => (
          <div key={b.blockId} style={{ marginBottom: 20 }}>
            <h3 style={{ marginBottom: 10 }}>{b.title}</h3>
            <div className="source-meta">
              <span className="tag green">Опубликован</span>
              <span className="tag gray">Версия {b.version}</span>
              <span className="tag gray">{b.region}</span>
            </div>
            <blockquote className="source-quote">{b.quote}</blockquote>
          </div>
        ))}
      </Dialog>
      <Dialog
        open={!!edit}
        onOpenChange={(v) => !v && setEdit(null)}
        title="Исправить реплику"
        description="Связанный контекст и подсказки будут пересчитаны"
      >
        <div className="form-grid">
          <label className="full">
            Говорящий
            <select
              value={editRole}
              onChange={(e) => setEditRole(e.target.value as typeof editRole)}
            >
              {Object.entries(roleLabels).map(([k, v]) => (
                <option value={k} key={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="full">
            Текст
            <textarea rows={4} value={editText} onChange={(e) => setEditText(e.target.value)} />
          </label>
        </div>
        <div className="form-actions">
          <Button
            onClick={() =>
              void run(async () => {
                if (edit && conversation) {
                  setConversation(
                    await patch<Conversation>(
                      `/conversations/${conversation.id}/segments/${edit.id}`,
                      {
                        role: editRole,
                        text: editText,
                        excluded: editRole === 'unknown' || editRole === 'bystander',
                      },
                    ),
                  );
                  setEdit(null);
                }
              })
            }
          >
            Сохранить
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={editingCard}
        onOpenChange={setEditingCard}
        title="Уточнить контекст"
        description="Исправление применится сейчас. Новые реплики могут уточнить намерение."
      >
        <div className="form-grid">
          <label className="full">
            Обозначение клиента
            <input
              value={cardLabel}
              onChange={(e) => setCardLabel(e.target.value)}
              maxLength={80}
            />
          </label>
          <label className="full">
            Регион консультации
            <select value={cardRegion} onChange={(e) => setCardRegion(e.target.value)}>
              {[...new Set(['Все регионы', ...docs.map((d) => d.region)])].map((region) => (
                <option key={region}>{region}</option>
              ))}
            </select>
          </label>
          <label className="full">
            Основное намерение
            <select value={cardIntent} onChange={(e) => setCardIntent(e.target.value)}>
              <option value="unknown">Пока неизвестно</option>
              {Array.from(new Map(docs.map((d) => [d.intent, d])).values()).map((d) => (
                <option value={d.intent} key={d.intent}>
                  {d.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-actions">
          <Button
            onClick={() =>
              void change({ intent: cardIntent, label: cardLabel, region: cardRegion }).then(() =>
                setEditingCard(false),
              )
            }
          >
            Обновить карточку
          </Button>
        </div>
      </Dialog>
      {pip &&
        createPortal(
          <div className="pip-content">
            <div className="pip-header">
              <Brand />
              <span className="tag">{card?.label}</span>
            </div>
            {Hint}
            <div className="pip-actions">
              <Button
                variant="outline"
                onClick={() =>
                  live
                    ? audio.stop()
                    : user.demo
                      ? notify('Деморежим: звук не записывается')
                      : void audio.start()
                }
              >
                {live ? <MicOff size={14} /> : <Mic size={14} />} {live ? 'Пауза' : 'Микрофон'}
              </Button>
              <Button variant="outline" onClick={() => void run(newClient)}>
                <Plus size={14} />
                Новый клиент
              </Button>
            </div>
          </div>,
          pip.document.body,
        )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </Shell>
  );
}
