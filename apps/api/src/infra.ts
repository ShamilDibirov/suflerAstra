import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { config } from './config';
import { store } from './store';
import { deleteFile } from './storage';
import { ingestDocument } from './knowledge';
import type { Conversation } from '@sufler/shared';
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
  for (const audio of c.recordings) await deleteFile(audio.key);
  await store.removeConversationRecords(org, c.id);
  await store.remove(org, 'conversation', c.id);
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
