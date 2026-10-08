import { createAuthClient } from 'better-auth/react';
export const authClient = createAuthClient();
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ message: 'Сервер недоступен' }));
    throw new ApiError(
      Array.isArray(data.message)
        ? data.message.join(', ')
        : data.message || 'Не удалось выполнить запрос',
      response.status,
    );
  }
  return response.json();
}
export const post = <T>(path: string, data: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const patch = <T>(path: string, data: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
export function socketUrl(conversationId?: string) {
  const override = process.env.NEXT_PUBLIC_WS_URL;
  const url = override
    ? new URL(override)
    : new URL(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}${location.port === '3000' ? ':4000' : location.port ? `:${location.port}` : ''}/api/live`,
      );
  if (conversationId) url.searchParams.set('conversationId', conversationId);
  return url.toString();
}
export const formatTime = (date: string) =>
  new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(date));
export const formatDate = (date: string) =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(date));
