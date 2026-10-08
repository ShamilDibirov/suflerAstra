'use client';
import { useState, useEffect } from 'react';
import { ArrowRight, ShieldCheck, Sparkles } from 'lucide-react';
import { Brand } from './brand';
import { Button } from './ui/button';
import { api, authClient } from '@/lib/api';
export function Login({ admin = false }: { admin?: boolean }) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [demo, setDemo] = useState(false);
  useEffect(() => {
    api<{ demo: boolean }>('/config')
      .then((c) => setDemo(c.demo))
      .catch(() => {});
  }, []);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) throw new Error(result.error.message || 'Проверьте email и пароль');
      location.assign(admin ? '/admin' : '/app');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка входа');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-story">
        <Brand />
        <div>
          <span className="eyebrow">
            <Sparkles size={15} /> ПОМОЩНИК, КОТОРЫЙ РЯДОМ
          </span>
          <h1>
            Внимание — клиенту.
            <br />
            Всё остальное
            <br />
            <em>подскажет Суфлёр.</em>
          </h1>
          <p>Нужные знания и следующий шаг — прямо во время разговора.</p>
          <div className="login-example">
            <span className="purple-icon">
              <Sparkles size={22} />
            </span>
            <div>
              <strong>Следующий шаг уже перед вами</strong>
              <p>Коротко. По делу. С подтверждённым источником.</p>
            </div>
          </div>
        </div>
        <small>Суфлёр · AI для телеком-розницы</small>
      </div>
      <div className="login-form-wrap">
        <form onSubmit={login} className="login-form">
          <div className="login-symbol">
            <ShieldCheck size={28} />
          </div>
          <h2>{admin ? 'Вход в администрирование' : 'Рады видеть вас'}</h2>
          <p>
            {admin
              ? 'Управляйте знаниями, моделями и командой.'
              : 'Войдите, чтобы начать консультацию.'}
          </p>
          {error && <div className="error-banner">{error}</div>}
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.ru"
              required
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Ваш пароль"
              required
              minLength={12}
            />
          </label>
          <Button disabled={busy || demo} type="submit">
            {busy ? 'Входим…' : 'Войти'}
            <ArrowRight size={17} />
          </Button>
          {demo && (
            <div className="demo-login">
              <strong>Сейчас открыт учебный режим</strong>
              <p>Авторизация Better Auth работает в реальном режиме с PostgreSQL.</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => location.assign(admin ? '/admin' : '/app')}
              >
                Открыть демо <ArrowRight size={16} />
              </Button>
            </div>
          )}
          <small>Нет доступа? Обратитесь к администратору вашей организации.</small>
        </form>
      </div>
    </div>
  );
}
