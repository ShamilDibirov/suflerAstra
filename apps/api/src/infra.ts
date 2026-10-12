import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { config } from './config';
import { store } from './store';
import { deleteFile } from './storage';
import { ingestDocument } from './knowledge';
import type { Conversation, WorkingSession } from '@sufler/shared';
export const redis = config.redis ? new Redis(config.redis, { maxRetriesPerRequest: null }) : null;
export const jobs = redis ? new Queue('sufler', { connection: redis as never }) : null;
export async function enqueueIngest(orgId: string, id: string) {
  if (!jobs) throw new Error('Для обработки документов требуется Redis');
  await jobs.add(
    'ingest',
    { orgId, id },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  );
}
export async function deleteConversation(org: string, c: Conversation) {
  const sid = c.sessionId || c.id;
  await store.withLock(`work-session:${org}:${sid}`, async () => {
    const current = await store.get<Conversation>(org, 'conversation', c.id);
    if (!current) return;
    const siblings = (await store.list<Conversation>(org, 'conversation')).filter(
      (v) => v.id !== c.id,
    );
    const referenced = new Set(siblings.flatMap((v) => v.recordings.map((r) => r.key)));
    for (const key of new Set(current.recordings.map((r) => r.key)))
      if (!referenced.has(key)) await deleteFile(key);
    await store.removeConversationRecords(org, c.id);
    await store.remove(org, 'conversation', c.id);
    const work = await store.get<WorkingSession>(org, 'work-session', sid);
    if (work) {
      if (!siblings.some((v) => (v.sessionId || v.id) === sid))
        await store.remove(org, 'work-session', sid);
      else {
        work.boundaries = work.boundaries.filter((b) => b.fromId !== c.id && b.toId !== c.id);
        await store.put(org, 'work-session', sid, work);
      }
    }
  });
}
export async function retention() {
  const cutoff = Date.now() - config.retentionDays * 86400000;
  for (const org of await store.organizations())
    for (const c of await store.list<Conversation>(org, 'conversation'))
      if (new Date(c.createdAt).getTime() < cutoff) await deleteConversation(org, c);
}
export async function startJobs() {
  if (!redis || !jobs) return null;
  const worker = new Worker(
    'sufler',
    async (job) => {
      if (job.name === 'ingest') await ingestDocument(job.data.orgId, job.data.id);
      if (job.name === 'retention') await retention();
    },
    { connection: redis as never, concurrency: 2 },
  );
  worker.on('failed', (job, error) => console.error('Job failed', job?.name, error.message));
  await jobs.upsertJobScheduler(
    'retention-hourly',
    { every: 3600000 },
    { name: 'retention', data: {}, opts: { removeOnComplete: 10, removeOnFail: 20 } },
  );
  return worker;
}
