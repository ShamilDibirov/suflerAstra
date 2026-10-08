'use client';
import Link from 'next/link';
import { useState, useEffect, useRef } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
  Workflow,
  X,
  Archive,
  Eye,
  Zap,
  ChartNoAxesCombined,
  Activity,
  Settings2,
} from 'lucide-react';
import type { KnowledgeDocument, ModelConfig, Conversation } from '@sufler/shared';
import { directionLabels, roleLabels } from '@sufler/shared';
import { api, post, patch, formatDate, formatTime } from '@/lib/api';
import { useSession } from '@/hooks/use-session';
import { Shell, LoadingScreen } from './shell';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
type Overview = {
  documents: number;
  published: number;
  conversations: number;
  active: number;
  hints: number;
  grounded: number;
  avgLatency: number;
  tokens: number;
  demo: boolean;
};
type Member = { id: string; name: string; email: string; role: string };
type Block = {
  id?: string;
  text: string;
  kind: 'step' | 'fact' | 'offer' | 'question';
  requiredFacts: string[];
  urgent?: boolean;
};
const headings: Record<string, [string, string]> = {
  overview: ['Всё под контролем', 'Знания, команда и AI — в одном пространстве.'],
  knowledge: ['База знаний', 'Проверенные знания — основа точных подсказок.'],
  processes: ['Сервисные процессы', 'Понятные шаги для каждой ситуации клиента.'],
  catalog: ['Каталог предложений', 'Тарифы, устройства, услуги и аксессуары.'],
  models: ['AI-модели', 'Выбирайте баланс скорости, качества и стоимости.'],
  users: ['Ваша команда', 'Личные учётные записи и доступ к организации.'],
  history: ['История диалогов', 'Посмотрите, как Суфлёр помогает вашей команде.'],
  metrics: ['Качество и эффективность', 'Измеряем пользу, задержку и расход токенов.'],
};
const stateLabel: Record<string, string> = {
  draft: 'Черновик',
  review: 'На проверке',
  published: 'Опубликован',
  archived: 'В архиве',
  processing: 'Обрабатывается',
  failed: 'Ошибка обработки',
};
const kindLabel = { article: 'Статья', process: 'Процесс', catalog: 'Каталог' };
export function Admin({ section }: { section: string }) {
  const { user, error: sessionError } = useSession(true);
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]),
    [models, setModels] = useState<ModelConfig[]>([]),
    [history, setHistory] = useState<Conversation[]>([]),
    [members, setMembers] = useState<Member[]>([]),
    [overview, setOverview] = useState<Overview | null>(null),
    [search, setSearch] = useState(''),
    [error, setError] = useState(''),
    [toast, setToast] = useState(''),
    [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState(false),
    [editing, setEditing] = useState<KnowledgeDocument | null>(null),
    [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [type, setType] = useState<KnowledgeDocument['type']>('article'),
    [intent, setIntent] = useState(''),
    [direction, setDirection] = useState<KnowledgeDocument['direction']>('service'),
    [content, setContent] = useState(''),
    [region, setRegion] = useState('Все регионы'),
    [validFrom, setValidFrom] = useState(''),
    [validUntil, setValidUntil] = useState(''),
    [blocks, setBlocks] = useState<Block[] | null>(null);
  const [modelDialog, setModelDialog] = useState(false),
    [modelName, setModelName] = useState(''),
    [modelId, setModelId] = useState(''),
    [memberDialog, setMemberDialog] = useState(false),
    [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [memberRole, setMemberRole] = useState('consultant'),
    [detail, setDetail] = useState<Conversation | null>(null),
    [statusFilter, setStatusFilter] = useState('all');
  const [runtime, setRuntime] = useState({ ragEnabled: true });
  const fileRef = useRef<HTMLInputElement>(null);
  async function load() {
    const [d, m, h, u, o, settings] = await Promise.all([
      api<KnowledgeDocument[]>('/admin/documents'),
      api<ModelConfig[]>('/admin/models'),
      api<Conversation[]>('/admin/history'),
      api<Member[]>('/admin/users'),
      api<Overview>('/admin/overview'),
      api<{ ragEnabled: boolean }>('/config'),
    ]);
    setRuntime(settings);
    setDocs(d);
    setModels(m);
    setHistory(h);
    setMembers(u);
    setOverview(o);
  }
  useEffect(() => {
    if (user) void load().catch((e) => setError(e.message));
  }, [user]);
  useEffect(() => {
    if (!docs.some((d) => d.status === 'processing')) return;
    const t = setInterval(() => void load().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [docs]);
  function notify(message: string) {
    setToast(message);
    setTimeout(() => setToast(''), 5000);
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(false);
    }
  }
  function openEditor(doc?: KnowledgeDocument) {
    setEditing(doc || null);
    setTitle(doc?.title || '');
    setDescription(doc?.description || '');
    setType(
      doc?.type ||
        (section === 'processes' ? 'process' : section === 'catalog' ? 'catalog' : 'article'),
    );
    setIntent(doc?.intent || '');
    setDirection(doc?.direction || (section === 'catalog' ? 'sales' : 'service'));
    setContent(doc?.content || '');
    setRegion(doc?.region || 'Все регионы');
    setValidFrom(doc?.validFrom || '');
    setValidUntil(doc?.validUntil || '');
    setBlocks(doc?.blocks || null);
    setEditor(true);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const data = {
        title,
        description,
        type,
        intent: intent || 'unknown',
        direction,
        content: blocks ? blocks.map((b) => b.text).join('\n\n') : content,
        region,
        validFrom,
        validUntil,
        blocks: blocks || undefined,
      };
      if (editing) await patch(`/admin/documents/${editing.id}`, data);
      else await post('/admin/documents', data);
      setEditor(false);
      notify('Черновик сохранён. Проверьте и опубликуйте его.');
    });
  }
  async function upload(file: File) {
    await run(async () => {
      const data = new FormData();
      data.append('file', file);
      const d = await api<KnowledgeDocument>('/admin/upload', { method: 'POST', body: data });
      notify(
        d.status === 'processing'
          ? 'Файл загружен и отправлен на обработку'
          : 'Файл загружен. Проверьте намерение и содержание перед публикацией.',
      );
    });
  }
  const filtered = docs.filter(
    (d) =>
      (section !== 'processes' || d.type === 'process') &&
      (section !== 'catalog' || d.type === 'catalog') &&
      (statusFilter === 'all' || d.status === statusFilter) &&
      `${d.title} ${d.intent}`.toLowerCase().includes(search.toLowerCase()),
  );
  if (!user) return <LoadingScreen error={sessionError} />;
  const isDocs = ['knowledge', 'processes', 'catalog'].includes(section);
  return (
    <Shell user={user} admin>
      <div className="page-heading">
        <div>
          <h1>{headings[section][0]}</h1>
          <p>{headings[section][1]}</p>
        </div>
        <div className="heading-actions">
          {isDocs && (
            <>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept={runtime.ragEnabled ? '.pdf,.docx,.txt,.md,.csv' : '.txt,.md,.csv'}
                onChange={(e) => {
                  if (e.target.files?.[0]) void upload(e.target.files[0]);
                  e.target.value = '';
                }}
              />
              <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Upload size={15} />
                Загрузить файл
              </Button>
              <Button onClick={() => openEditor()}>
                <Plus size={15} />
                Создать {section === 'processes' ? 'процесс' : 'материал'}
              </Button>
            </>
          )}
          {['knowledge', 'processes'].includes(section) && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await post('/admin/sales-templates');
                  notify('Заготовки добавлены. Проверьте и опубликуйте скрипт и практики.');
                })
              }
            >
              Примеры продаж
            </Button>
          )}
          {section === 'models' && (
            <Button onClick={() => setModelDialog(true)}>
              <Plus size={15} />
              Добавить модель
            </Button>
          )}
          {section === 'users' && (
            <Button onClick={() => setMemberDialog(true)}>
              <Plus size={15} />
              Добавить сотрудника
            </Button>
          )}
          {section === 'overview' && (
            <Button asChild>
              <Link href="/app">
                <Sparkles size={15} />
                Открыть Суфлёр
                <ArrowUpRight size={14} />
              </Link>
            </Button>
          )}
        </div>
      </div>
      {!runtime.ragEnabled && isDocs && (
        <div className="info-banner" style={{ marginBottom: 16 }}>
          Продажи без поиска по базе: создайте процесс с направлением «Продажи» для скрипта.
          Практики добавляйте как статью с intent sales_best_practices. После проверки публикуйте
          материалы. Для импорта доступны Markdown, TXT и CSV; PDF/DOCX предварительно преобразуйте
          в текст.
        </div>
      )}
      {error && (
        <div role="alert" className="error-banner">
          {error}
          <button
            className="icon-btn"
            onClick={() => setError('')}
            aria-label="Закрыть ошибку"
            style={{ float: 'right' }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {(section === 'overview' || section === 'metrics') && (
        <>
          <div className="stat-grid">
            {[
              {
                title: 'Материалов в базе',
                value: overview?.documents || 0,
                note: `${overview?.published || 0} опубликовано`,
                icon: BookOpen,
              },
              {
                title: 'Диалогов',
                value: overview?.conversations || 0,
                note: `${overview?.active || 0} сейчас активны`,
                icon: Users,
              },
              {
                title: 'Подсказок',
                value: overview?.hints || 0,
                note: `${overview?.grounded || 0} с источником`,
                icon: Sparkles,
              },
              {
                title: 'Средняя задержка',
                value: overview?.demo
                  ? 'Демо'
                  : `${((overview?.avgLatency || 0) / 1000).toFixed(1)} с`,
                note: overview?.demo ? 'API не вызывались' : 'Поиск и проверка источников',
                icon: Clock3,
              },
            ].map((stat) => (
              <div className="panel stat-card" key={stat.title}>
                <div className="stat-top">
                  <span>{stat.title}</span>
                  <stat.icon size={16} />
                </div>
                <strong>{stat.value}</strong>
                <small>{stat.note}</small>
              </div>
            ))}
          </div>
          <div className="admin-two-col">
            <section className="panel welcome-panel">
              <span className="eyebrow">
                <Sparkles size={14} />
                ЗНАНИЯ ПРЕВРАЩАЮТСЯ В ПОМОЩЬ
              </span>
              <h2>У вашей команды есть Суфлёр</h2>
              <p>
                Загрузите регламенты, проверьте процессы и опубликуйте их. Каждая подсказка будет
                опираться на вашу базу знаний.
              </p>
              <Button asChild variant="outline">
                <Link href="/admin/knowledge">
                  Управлять знаниями
                  <ArrowRight size={15} />
                </Link>
              </Button>
            </section>
            <section className="panel">
              <div className="panel-header">
                <h3>Готовность пространства</h3>
                <span className="tag">{user.demo ? 'Учебный режим' : 'Рабочий режим'}</span>
              </div>
              <div className="checklist">
                <Link href="/admin/knowledge">
                  <CheckCircle2 size={17} />
                  База знаний · {overview?.published || 0} материалов
                  <ChevronRight size={15} />
                </Link>
                <Link href="/admin/models">
                  <CheckCircle2 size={17} />
                  Модели · {models.filter((m) => m.enabled).length} доступны
                  <ChevronRight size={15} />
                </Link>
                <Link href="/admin/users">
                  <CheckCircle2 size={17} />
                  Команда · {members.length} сотрудников
                  <ChevronRight size={15} />
                </Link>
                <Link href="/app">
                  <ShieldCheck size={17} />
                  Изоляция данных организации
                  <ChevronRight size={15} />
                </Link>
              </div>
            </section>
          </div>
          {section === 'metrics' && (
            <section className="panel" style={{ marginTop: 22 }}>
              <div className="panel-header">
                <h3>Наблюдаемые показатели</h3>
                <span className="tag gray">Без содержимого диалогов в логах</span>
              </div>
              <div className="metric-line">
                <span>Вход + выход</span>
                <strong>{overview?.tokens || 0} токенов</strong>
              </div>
              <div className="metric-line">
                <span>С источником</span>
                <div className="metric-bar">
                  <i
                    style={{
                      width: `${overview?.hints ? (overview.grounded / overview.hints) * 100 : 0}%`,
                    }}
                  />
                </div>
                <strong>
                  {overview?.hints ? Math.round((overview.grounded / overview.hints) * 100) : 0}%
                </strong>
              </div>
              <div className="metric-line">
                <span>Хранение</span>
                <strong>30 дней</strong>
              </div>
              <div className="info-banner" style={{ margin: 22 }}>
                {user.demo
                  ? 'Демо не измеряет реальную задержку и стоимость. Для замеров подключите провайдеров.'
                  : 'Цель пилота: p95 до 6 секунд. Подтверждается нагрузочным тестом с реальными провайдерами.'}
              </div>
            </section>
          )}
        </>
      )}
      {isDocs && (
        <section className="panel">
          <div className="table-toolbar">
            <div className="search-box">
              <Search size={16} />
              <input
                aria-label="Поиск по базе"
                placeholder="Найти материал…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <small>{filtered.length} материалов</small>
              <select
                style={{ fontSize: 11, padding: '7px 10px' }}
                aria-label="Статус документов"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="all">Все статусы</option>
                {Object.entries(stateLabel).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Материал</th>
                  <th>Тип</th>
                  <th>Статус</th>
                  <th>Обновлён</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <button
                        className="table-title"
                        onClick={() => openEditor(d)}
                        style={{
                          border: 0,
                          background: 'transparent',
                          textAlign: 'left',
                          padding: 0,
                        }}
                      >
                        <span className="file-icon">
                          <FileText size={17} />
                        </span>
                        <div>
                          <strong>{d.title}</strong>
                          <small>
                            {d.region} · Версия {d.version}
                          </small>
                          {d.error && (
                            <small
                              style={{ color: '#bf7676', maxWidth: 260, whiteSpace: 'normal' }}
                            >
                              {d.error}
                            </small>
                          )}
                        </div>
                      </button>
                    </td>
                    <td>{kindLabel[d.type]}</td>
                    <td>
                      <span
                        className={`tag ${d.status === 'published' ? 'green' : d.status === 'failed' ? 'red' : d.status === 'review' ? 'amber' : 'gray'}`}
                      >
                        {stateLabel[d.status]}
                      </span>
                    </td>
                    <td>{formatDate(d.updatedAt)}</td>
                    <td>
                      <div className="table-actions">
                        <Button variant="ghost" size="sm" onClick={() => openEditor(d)}>
                          Открыть
                        </Button>
                        {!['published', 'processing', 'failed'].includes(d.status) && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await post(`/admin/documents/${d.id}/status`, {
                                  status: 'published',
                                });
                                notify('Материал опубликован');
                              })
                            }
                          >
                            <Check size={12} />
                            Публикация
                          </Button>
                        )}
                        {d.status === 'published' && (
                          <button
                            className="icon-btn"
                            title="В архив"
                            onClick={() =>
                              void run(() =>
                                post(`/admin/documents/${d.id}/status`, { status: 'archived' }),
                              )
                            }
                          >
                            <Archive size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!filtered.length && (
            <div className="empty-state">
              <FolderOpen size={30} />
              <h3>Здесь будут ваши знания</h3>
              <p>Загрузите файл или создайте первый материал.</p>
              <Button variant="outline" onClick={() => openEditor()}>
                <Plus size={14} />
                Добавить материал
              </Button>
            </div>
          )}
        </section>
      )}
      {section === 'models' && (
        <>
          <div className="info-banner">
            <strong>Классификатор контекста — KEV 4B.</strong> Его фактический статус показан в
            карточке диалога. Модель ниже отвечает за подсказки и чат. Смена модели сохраняет
            карточку клиента. Резервный классификатор настраивается на сервере отдельно.
          </div>
          <div className="model-grid">
            {models.map((m) => (
              <section className="panel model-card" key={m.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span className="model-logo">{m.id.startsWith('qwen') ? 'Q' : 'K'}</span>
                  {m.isDefault ? (
                    <span className="tag" style={{ alignSelf: 'start' }}>
                      По умолчанию
                    </span>
                  ) : (
                    <span
                      className={`tag ${m.enabled ? 'green' : 'gray'}`}
                      style={{ alignSelf: 'start' }}
                    >
                      {m.enabled ? 'Включена' : 'Отключена'}
                    </span>
                  )}
                </div>
                <h3>{m.name}</h3>
                <code>{m.id}</code>
                <p>
                  {m.testedAt
                    ? `Подключение проверено ${formatDate(m.testedAt)}`
                    : 'Подключение ещё не проверено'}
                </p>
                {m.testError && <p style={{ color: '#bc7777' }}>{m.testError}</p>}
                <div className="model-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const r = await post<{ demo: boolean }>('/admin/models/test', {
                          id: m.id,
                        }).finally(() => load());
                        notify(
                          r.demo
                            ? 'Деморежим: реальный API не вызывался'
                            : 'Модель отвечает и поддерживает JSON',
                        );
                      })
                    }
                  >
                    <Zap size={12} />
                    Проверить
                  </Button>
                  {!m.isDefault && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          post('/admin/models', { ...m, enabled: true, isDefault: true }),
                        )
                      }
                    >
                      По умолчанию
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || m.isDefault}
                    onClick={() =>
                      void run(() => post('/admin/models', { ...m, enabled: !m.enabled }))
                    }
                  >
                    {m.enabled ? 'Отключить' : 'Включить'}
                  </Button>
                </div>
              </section>
            ))}
          </div>
        </>
      )}
      {section === 'users' && (
        <section className="panel">
          <div className="table-toolbar">
            <h3>Участники организации</h3>
            <span className="tag gray">{members.length} участников</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Email</th>
                  <th>Роль</th>
                  <th>Доступ</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="table-title">
                        <span className="avatar">{m.name.slice(0, 1)}</span>
                        <strong>{m.name}</strong>
                      </div>
                    </td>
                    <td>{m.email}</td>
                    <td>
                      {m.role === 'owner'
                        ? 'Владелец'
                        : m.role === 'admin'
                          ? 'Администратор'
                          : 'Консультант'}
                    </td>
                    <td>
                      <span className="tag green">Активен</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {section === 'history' && (
        <section className="panel">
          <div className="table-toolbar">
            <h3>Консультации</h3>
            <small>Аудио и текст хранятся 30 дней</small>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Диалог</th>
                  <th>Направление</th>
                  <th>Реплики</th>
                  <th>Модель</th>
                  <th>Статус</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.card.label}</strong>
                      <small style={{ display: 'block' }}>
                        {formatDate(c.createdAt)} · {formatTime(c.createdAt)}
                      </small>
                    </td>
                    <td>{directionLabels[c.card.direction]}</td>
                    <td>{c.segments.length}</td>
                    <td>{c.modelId.split('/')[1]}</td>
                    <td>
                      <span className={`tag ${c.status === 'active' ? 'green' : 'gray'}`}>
                        {c.status === 'active' ? 'В процессе' : 'Завершён'}
                      </span>
                    </td>
                    <td>
                      <Button size="sm" variant="ghost" onClick={() => setDetail(c)}>
                        <Eye size={13} />
                        Посмотреть
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!history.length && (
            <div className="empty-state">
              <Clock3 size={30} />
              <p>Здесь появятся завершённые консультации.</p>
            </div>
          )}
        </section>
      )}
      <Dialog
        open={editor}
        onOpenChange={setEditor}
        title={editing ? 'Редактировать материал' : 'Новый материал'}
        description="Изменения сохраняются как черновик. Подсказки используют только опубликованные версии."
        wide
      >
        <form onSubmit={save}>
          <div className="form-grid">
            <label className="full">
              Название
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                minLength={3}
              />
            </label>
            <label>
              Тип
              <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                {Object.entries(kindLabel).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Intent · ключ сценария
              <input
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="sim_replacement"
                required
              />
            </label>
            <label>
              Направление
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as typeof direction)}
              >
                {Object.entries(directionLabels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Регион
              <input value={region} onChange={(e) => setRegion(e.target.value)} />
            </label>
            <label className="full">
              Краткое описание
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <label>
              Действует с
              <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </label>
            <label>
              Действует до
              <input
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </label>
            <label className="full">
              Исходное содержание
              <textarea
                rows={7}
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setBlocks(null);
                }}
                required
                minLength={10}
              />
            </label>
            <div className="full" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setBlocks(
                    content
                      .split(/\n\s*\n/)
                      .filter(Boolean)
                      .map((text) => ({
                        id: crypto.randomUUID(),
                        text,
                        kind: 'step',
                        requiredFacts: [],
                      })),
                  )
                }
              >
                <Workflow size={13} />
                Разбить на шаги
              </Button>
              {editing && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await post<{ blocks: Block[] }>(
                        `/admin/documents/${editing.id}/draft-process`,
                      );
                      setBlocks(result.blocks.map((b) => ({ ...b, id: crypto.randomUUID() })));
                      notify('Черновик шагов готов. Проверьте каждый перед публикацией.');
                    })
                  }
                >
                  <Sparkles size={13} />
                  AI-черновик
                </Button>
              )}
            </div>
            {blocks && (
              <div className="full" style={{ display: 'grid', gap: 10 }}>
                {blocks.map((b, i) => (
                  <div className="block-editor" key={b.id || i}>
                    <div className="block-row">
                      <small>Шаг {i + 1}</small>
                      <select
                        aria-label={`Тип шага ${i + 1}`}
                        value={b.kind}
                        onChange={(e) =>
                          setBlocks(
                            blocks.map((x, j) =>
                              j === i ? { ...x, kind: e.target.value as Block['kind'] } : x,
                            ),
                          )
                        }
                      >
                        <option value="step">Действие</option>
                        <option value="question">Уточняющий вопрос</option>
                        <option value="fact">Условие / факт</option>
                        <option value="offer">Предложение</option>
                      </select>
                      <select
                        aria-label={`Зависимость шага ${i + 1}`}
                        value={b.requiredFacts[0] || ''}
                        onChange={(e) =>
                          setBlocks(
                            blocks.map((x, j) =>
                              j === i
                                ? { ...x, requiredFacts: e.target.value ? [e.target.value] : [] }
                                : x,
                            ),
                          )
                        }
                      >
                        <option value="">Без предварительного шага</option>
                        {blocks.slice(0, i).map((x, j) => (
                          <option value={x.id} key={x.id}>
                            После подтверждения шага {j + 1}
                          </option>
                        ))}
                      </select>
                      <label
                        style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}
                      >
                        <input
                          type="checkbox"
                          checked={!!b.urgent}
                          onChange={(e) =>
                            setBlocks(
                              blocks.map((x, j) =>
                                j === i ? { ...x, urgent: e.target.checked } : x,
                              ),
                            )
                          }
                        />
                        Срочный шаг
                      </label>
                    </div>
                    <textarea
                      rows={2}
                      value={b.text}
                      onChange={(e) =>
                        setBlocks(
                          blocks.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="form-actions">
            <Button variant="outline" type="button" onClick={() => setEditor(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={busy}>
              Сохранить черновик
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={modelDialog}
        onOpenChange={setModelDialog}
        title="Добавить AI-модель"
        description="Укажите точный идентификатор модели OpenRouter"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await post('/admin/models', {
                id: modelId,
                name: modelName,
                enabled: true,
                isDefault: false,
              });
              setModelDialog(false);
              setModelId('');
              setModelName('');
            });
          }}
        >
          <div className="form-grid">
            <label className="full">
              Название
              <input
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="Qwen 3.5 · 9B"
                required
              />
            </label>
            <label className="full">
              Идентификатор OpenRouter
              <input
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="qwen/qwen3.5-9b"
                required
              />
            </label>
          </div>
          <div className="form-actions">
            <Button disabled={busy}>Добавить модель</Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={memberDialog}
        onOpenChange={setMemberDialog}
        title="Новый сотрудник"
        description="Учётная запись получит доступ только к вашей организации"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await post('/admin/users', { name, email, password, role: memberRole });
              setMemberDialog(false);
              setPassword('');
              notify('Учётная запись создана');
            });
          }}
        >
          <div className="form-grid">
            <label className="full">
              Имя
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={2}
              />
            </label>
            <label className="full">
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label className="full">
              Начальный пароль
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={12}
                required
              />
              <small>Не менее 12 символов</small>
            </label>
            <label className="full">
              Роль
              <select value={memberRole} onChange={(e) => setMemberRole(e.target.value)}>
                <option value="consultant">Консультант</option>
                <option value="admin">Администратор</option>
              </select>
            </label>
          </div>
          <div className="form-actions">
            <Button disabled={busy}>Создать учётную запись</Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={!!detail}
        onOpenChange={(v) => !v && setDetail(null)}
        title={detail?.card.label || 'Диалог'}
        description={detail ? `${formatDate(detail.createdAt)} · ${detail.modelId}` : ''}
        wide
      >
        <div className="history-detail">
          {detail?.recordings.map((r, i) => (
            <div key={r.key}>
              <small>
                Аудио · {Math.round(r.startMs / 1000)}–{Math.round(r.endMs / 1000)} с
              </small>
              <audio controls preload="none" src={`/api/recordings/${detail.id}/${i}`} />
            </div>
          ))}
          {detail?.segments.map((s) => (
            <div key={s.id} className="transcript-row">
              <span className="speaker-avatar">
                <Users size={12} />
              </span>
              <div className="speech-content">
                <div className="speech-meta">
                  <strong>{roleLabels[s.role]}</strong>
                  <time>{formatTime(s.createdAt)}</time>
                </div>
                <p>{s.text}</p>
              </div>
            </div>
          ))}
          {detail?.hints.map((h) => (
            <div className="source-quote" key={h.id}>
              <small>
                Подсказка · {h.modelId} · {h.inputTokens + h.outputTokens} токенов
              </small>
              <p>{h.text}</p>
            </div>
          ))}
        </div>
      </Dialog>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </Shell>
  );
}
