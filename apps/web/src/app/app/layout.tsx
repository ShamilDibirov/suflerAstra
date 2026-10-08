import { requirePageSession } from '@/lib/server-session';
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requirePageSession();
  return children;
}
