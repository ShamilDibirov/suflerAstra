import { requirePageSession } from '@/lib/server-session';
import { Admin } from '@/components/admin';
export default async function Page() {
  await requirePageSession(true);
  return <Admin section="overview" />;
}
