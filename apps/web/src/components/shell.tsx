'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  AudioLines,
  BookOpen,
  ChartNoAxesCombined,
  CircleHelp,
  History,
  LayoutDashboard,
  LogOut,
  Settings2,
  ShoppingBag,
  Users,
  Workflow,
  ChevronDown,
  ArrowUpRight,
  Sparkles,
} from 'lucide-react';
import type { SessionUser } from '@sufler/shared';
import { Brand } from './brand';
import { authClient, api, post } from '@/lib/api';
const workNav = [
  { href: '/app', label: 'Суфлёр', icon: AudioLines },
  { href: '/app/history', label: 'История диалогов', icon: History },
  { href: '/app/knowledge', label: 'База знаний', icon: BookOpen },
];
const adminNav = [
  { href: '/admin', label: 'Обзор', icon: LayoutDashboard },
  { href: '/admin/knowledge', label: 'База знаний', icon: BookOpen },
  { href: '/admin/processes', label: 'Процессы', icon: Workflow },
  { href: '/admin/catalog', label: 'Каталог', icon: ShoppingBag },
  { href: '/admin/prompts', label: 'Промпты', icon: Settings2 },
  { href: '/admin/models', label: 'AI-модели', icon: Sparkles },
  { href: '/admin/users', label: 'Команда', icon: Users },
  { href: '/admin/history', label: 'История диалогов', icon: History },
  { href: '/admin/metrics', label: 'Метрики', icon: ChartNoAxesCombined },
];
export function Shell({
  user,
  admin = false,
  children,
}: {
  user: SessionUser;
  admin?: boolean;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const [organizations, setOrganizations] = useState<{ id: string; name: string }[]>([]),
    [orgError, setOrgError] = useState('');
  useEffect(() => {
    api<{ id: string; name: string }[]>('/organizations')
      .then(setOrganizations)
      .catch(() => {});
  }, [user.orgId]);
  async function switchOrg(id: string) {
    try {
      await post('/organizations/switch', { id });
      location.assign('/app');
    } catch (e) {
      setOrgError(e instanceof Error ? e.message : 'Не удалось сменить организацию');
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href={admin ? '/admin' : '/app'} aria-label="Суфлёр — главная">
          <Brand />
        </Link>
        <div className="workspace-switch">
          <span className="org-avatar">{user.orgName.charAt(0)}</span>
          <div>
            <select
              aria-label="Организация"
              value={user.orgId}
              disabled={organizations.length < 2}
              onChange={(e) => void switchOrg(e.target.value)}
            >
              {(organizations.length
                ? organizations
                : [{ id: user.orgId, name: user.orgName }]
              ).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <span>{admin ? 'Администрирование' : 'Рабочее пространство'}</span>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="nav-caption">{admin ? 'УПРАВЛЕНИЕ' : 'ПРОСТРАНСТВО'}</div>
        <nav>
          {(admin ? adminNav : workNav).map((item) => (
            <Link
              key={item.href}
              className={`nav-item ${path === item.href ? 'active' : ''}`}
              href={item.href}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {item.href === '/app' && <span className="nav-live" />}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-icon">
              <CircleHelp size={18} />
            </span>
            <strong>Всегда на вашей стороне</strong>
            <p>Нужный шаг. В нужный момент.</p>
            <Link href="/app/knowledge">
              Открыть базу знаний <ArrowUpRight size={14} />
            </Link>
          </div>
          {user.role !== 'consultant' && (
            <Link className="nav-item admin-link" href={admin ? '/app' : '/admin'}>
              <Settings2 size={18} />
              {admin ? 'Вернуться к консультации' : 'Администрирование'}
            </Link>
          )}
          <div className="user-card">
            <span className="avatar">{user.name.slice(0, 1)}</span>
            <div>
              <strong>{user.name}</strong>
              <span>{user.role === 'consultant' ? 'Консультант' : 'Администратор'}</span>
            </div>
            <button
              className="icon-btn"
              title={user.demo ? 'Учебный режим без авторизации' : 'Выйти'}
              disabled={user.demo}
              onClick={() => authClient.signOut().then(() => location.assign('/login'))}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Рабочее пространство <span>/</span>{' '}
            <strong>{admin ? 'Администрирование' : 'Помощник консультанта'}</strong>
          </div>
          <div className="topbar-right">
            <span className="system-status">
              <i /> Рабочая сессия
            </span>
            {user.demo && <span className="demo-badge">Демо · учебные данные</span>}
          </div>
        </header>
        <main className="main-content">
          {orgError && (
            <div className="error-banner" role="alert">
              {orgError}
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
export function LoadingScreen({ error }: { error?: string }) {
  return (
    <div className="loading-screen">
      <Brand />
      <p>{error || 'Готовим рабочее пространство…'}</p>
      {error && (
        <button className="btn btn-outline" onClick={() => location.reload()}>
          Повторить
        </button>
      )}
    </div>
  );
}
