'use client';
import { useEffect, useState } from 'react';
import { BookOpen, Search, Clock3, ArrowUpRight } from 'lucide-react';
import type { KnowledgeDocument, Conversation } from '@sufler/shared';
import { roleLabels } from '@sufler/shared';
import { api, formatDate, formatTime } from '@/lib/api';
import { useSession } from '@/hooks/use-session';
import { Shell, LoadingScreen } from './shell';
import { Dialog } from './ui/dialog';
import { Button } from './ui/button';
export function Library({ history = false }: { history?: boolean }) {
  const { user, error } = useSession();
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [search, setSearch] = useState(''),
    [selected, setSelected] = useState<KnowledgeDocument | null>(null),
    [dialog, setDialog] = useState<Conversation | null>(null),
    [failure, setFailure] = useState('');
  useEffect(() => {
    if (user)
      (history
        ? api<Conversation[]>('/conversations').then(setConversations)
        : api<KnowledgeDocument[]>('/knowledge').then(setDocs)
      ).catch((e) => setFailure(e.message));
  }, [user, history]);
  if (!user) return <LoadingScreen error={error} />;
  return (
    <Shell user={user}>
      <div className="page-heading">
        <div>
          <h1>{history ? 'Ваши диалоги' : 'Ваша база знаний'}</h1>
          <p>
            {history
              ? 'Контекст, подсказки и записи консультаций за последние 30 дней.'
              : 'Проверенные инструкции и условия вашей организации.'}
          </p>
        </div>
      </div>
      {failure && <div className="error-banner">{failure}</div>}
      {!history && (
        <>
          <div className="search-box" style={{ marginBottom: 25 }}>
            <Search size={17} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Найти инструкцию…"
              aria-label="Поиск инструкции"
            />
          </div>
          <div className="documents-grid">
            {docs
              .filter((d) => `${d.title} ${d.content}`.toLowerCase().includes(search.toLowerCase()))
              .map((d) => (
                <button className="panel document-card" key={d.id} onClick={() => setSelected(d)}>
                  <BookOpen size={24} />
                  <h3>{d.title}</h3>
                  <p>{d.description}</p>
                  <span className="tag green">Опубликован</span>
                  <small style={{ float: 'right' }}>
                    Версия {d.version} <ArrowUpRight size={12} style={{ display: 'inline' }} />
                  </small>
                </button>
              ))}
          </div>
        </>
      )}
      {history && (
        <section className="panel">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Клиент</th>
                  <th>Дата</th>
                  <th>Реплики</th>
                  <th>Статус</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {conversations.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.card.label}</strong>
                    </td>
                    <td>
                      {formatDate(c.createdAt)} · {formatTime(c.createdAt)}
                    </td>
                    <td>{c.segments.length}</td>
                    <td>
                      <span className={`tag ${c.status === 'active' ? 'green' : 'gray'}`}>
                        {c.status === 'active' ? 'В процессе' : 'Завершён'}
                      </span>
                    </td>
                    <td>
                      <Button size="sm" variant="ghost" onClick={() => setDialog(c)}>
                        Открыть
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!conversations.length && (
            <div className="empty-state">
              <Clock3 size={30} />
              <p>Вы ещё не начали ни одного разговора.</p>
            </div>
          )}
        </section>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
        title={selected?.title || 'Материал'}
        description={`${selected?.region} · Версия ${selected?.version}`}
        wide
      >
        {selected?.blocks.map((b, i) => (
          <div key={b.id} className="source-quote" style={{ marginBottom: 12 }}>
            <small>Фрагмент {i + 1}</small>
            <p>{b.text}</p>
          </div>
        ))}
      </Dialog>
      <Dialog
        open={!!dialog}
        onOpenChange={(v) => !v && setDialog(null)}
        title={dialog?.card.label || 'Диалог'}
        description="Расшифровка и запись"
        wide
      >
        <div className="history-detail">
          {dialog?.recordings.map((r, i) => (
            <audio key={r.key} controls preload="none" src={`/api/recordings/${dialog.id}/${i}`} />
          ))}
          {dialog?.segments.map((s) => (
            <div key={s.id}>
              <small>
                {roleLabels[s.role]} · {formatTime(s.createdAt)}
              </small>
              <p style={{ fontSize: 13, marginTop: 5 }}>{s.text}</p>
            </div>
          ))}
          <Button
            variant="destructive"
            onClick={async () => {
              if (!dialog) return;
              try {
                await api(`/conversations/${dialog.id}`, { method: 'DELETE' });
                setConversations(conversations.filter((c) => c.id !== dialog.id));
                setDialog(null);
              } catch (e) {
                setFailure(e instanceof Error ? e.message : 'Ошибка удаления');
              }
            }}
          >
            Удалить диалог и записи
          </Button>
        </div>
      </Dialog>
    </Shell>
  );
}
