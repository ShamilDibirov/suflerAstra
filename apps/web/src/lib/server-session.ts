import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { SessionUser } from '@sufler/shared';
export async function requirePageSession(admin = false) {
  const cookie = (await cookies()).toString();
  const response = await fetch(
    `${process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000'}/api/session`,
    { headers: { Cookie: cookie }, cache: 'no-store', signal: AbortSignal.timeout(8000) },
  );
  if (!response.ok) redirect(admin ? '/admin/login' : '/login');
  const user = (await response.json()) as SessionUser;
  if (admin && user.role === 'consultant') redirect('/app');
  return user;
}
