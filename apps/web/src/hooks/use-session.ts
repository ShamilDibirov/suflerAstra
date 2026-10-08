'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SessionUser } from '@sufler/shared';
import { api, ApiError } from '@/lib/api';
export function useSession(admin = false) {
  const [user, setUser] = useState<SessionUser | null>(null),
    [error, setError] = useState('');
  const router = useRouter();
  useEffect(() => {
    api<SessionUser>('/session')
      .then((user) => {
        if (admin && user.role === 'consultant') {
          setError('Этот раздел доступен администратору организации.');
          return;
        }
        setUser(user);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401)
          router.replace(admin ? '/admin/login' : '/login');
        else setError(e.message);
      });
  }, [admin, router]);
  return { user, error };
}
