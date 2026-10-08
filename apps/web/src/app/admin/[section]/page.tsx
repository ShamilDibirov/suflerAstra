import { requirePageSession } from '@/lib/server-session';
import { notFound } from 'next/navigation';
import { Admin } from '@/components/admin';
export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  await requirePageSession(true);
  const { section } = await params;
  if (
    ![
      'knowledge',
      'processes',
      'catalog',
      'prompts',
      'models',
      'users',
      'history',
      'metrics',
    ].includes(section)
  )
    notFound();
  return <Admin section={section} />;
}
