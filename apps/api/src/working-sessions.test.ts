import { it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { newConversation } from '@sufler/shared/engine';
import {
  SegmentSchema,
  type SessionUser,
  type Conversation,
  type ModelCallLog,
} from '@sufler/shared';
import { store } from './store';
import {
  ensureSession,
  switchClient,
  undoClientSwitch,
  saveSessionAudio,
  requireWorkSession,
  finishWorkingSession,
} from './working-sessions';
import { audioLayout, audioBytes } from './unified-audio';
import { putFile, getFile } from './storage';
vi.mock('./conversations', () => ({ cancel: vi.fn(), reclassify: vi.fn(async () => {}) }));
async function fixture() {
  const user: SessionUser = {
    id: randomUUID(),
    orgId: randomUUID(),
    role: 'owner',
    orgName: 'Test',
    name: 'Test',
    email: 'a@b.test',
    demo: true,
  };
  const c = newConversation(user.orgId, user.id, 'q', 'Client');
  c.sessionId = c.id;
  c.audioStartMs = 0;
  c.segments = ['Спасибо, до свидания', 'Здравствуйте', 'Нужен новый тариф'].map((text, i) =>
    SegmentSchema.parse({
      id: `s${i}`,
      text,
      role: 'customer',
      speakerId: 'a',
      startMs: i * 1000,
      endMs: (i + 1) * 1000,
      createdAt: new Date().toISOString(),
    }),
  );
  c.recordings = [{ key: 'one', startMs: 0, endMs: 3000 }];
  await store.put(user.orgId, 'conversation', c.id, c);
  await ensureSession(user, c);
  return { user, c };
}
it('splits inside an audio block, preserves settings and reverses atomically without duplicate costs', async () => {
  const { user, c } = await fixture();
  const next = await switchClient(user, c.id, {
    segmentId: 's1',
    expectedRevision: 0,
    expectedConversation: c.id,
  });
  expect(next?.conversation.segments.map((s) => s.id)).toEqual(['s1', 's2']);
  expect(next?.conversation.recordings).toEqual([
    { key: 'one', startMs: 1000, endMs: 3000, sourceStartMs: 0 },
  ]);
  expect(
    (await store.get<Conversation>(user.orgId, 'conversation', c.id))?.recordings[0].endMs,
  ).toBe(1000);
  expect(await switchClient(user, c.id)).toBeNull();
  await saveSessionAudio(user, c.id, { key: 'two', startMs: 3000, endMs: 4000 }, 4000);
  await store.put(user.orgId, 'model-call', 'call', {
    id: 'call',
    conversationId: next!.conversation.id,
    sessionId: c.id,
    costUsd: 0.1,
  });
  const undone = await undoClientSwitch(user, c.id, next!.boundary.id);
  expect(undone.conversation.segments).toHaveLength(3);
  expect(undone.conversation.recordings.reduce((n, r) => n + r.endMs - r.startMs, 0)).toBe(4000);
  expect((await store.list<ModelCallLog>(user.orgId, 'model-call'))[0].conversationId).toBe(c.id);
  const { reclassify } = await import('./conversations');
  const callsBeforeRetry = vi.mocked(reclassify).mock.calls.length;
  expect((await undoClientSwitch(user, c.id, next!.boundary.id)).conversation.id).toBe(c.id);
  expect(vi.mocked(reclassify).mock.calls.length).toBe(callsBeforeRetry);
  expect(await switchClient(user, c.id, { segmentId: 's1' })).toBeNull();
});
it('routes a delayed block across both clients and rejects cross-tenant undo and stale decisions', async () => {
  const { user, c } = await fixture();
  const next = await switchClient(user, c.id, { segmentId: 's1' });
  await saveSessionAudio(user, c.id, { key: 'delayed', startMs: 500, endMs: 1500 }, 3000);
  const old = await store.get<Conversation>(user.orgId, 'conversation', c.id),
    fresh = await store.get<Conversation>(user.orgId, 'conversation', next!.conversation.id);
  expect(old?.recordings.at(-1)?.endMs).toBe(1000);
  expect(fresh?.recordings.at(-1)?.startMs).toBe(1000);
  await expect(
    undoClientSwitch({ ...user, orgId: 'other' }, c.id, next!.boundary.id),
  ).rejects.toThrow();
  expect(await switchClient(user, c.id, { segmentId: 's2', expectedRevision: 0 })).toBeNull();
  const s = await requireWorkSession(user, c.id);
  s.boundaries[0].undoUntil = new Date(0).toISOString();
  await store.put(user.orgId, 'work-session', s.id, s);
  await expect(undoClientSwitch(user, c.id, next!.boundary.id)).rejects.toThrow('Время отмены');
});
it('streams a single WAV with precise byte ranges across internal blocks and a clipped boundary', async () => {
  const data = Buffer.alloc(44 + 64000);
  for (let i = 44; i < data.length; i++) data[i] = i % 251;
  await putFile('wave', data, 'audio/wav');
  const slices = [
    { key: 'wave', startMs: 0, endMs: 1000 },
    { key: 'wave', startMs: 1000, endMs: 2000, sourceStartMs: 0 },
  ];
  const full = Buffer.concat(await collect(audioBytes(slices, 0, audioLayout(slices).length - 1)));
  expect(full.subarray(0, 4).toString()).toBe('RIFF');
  expect(full.length).toBe(64044);
  expect(full.subarray(44)).toEqual(data.subarray(44));
  const part = Buffer.concat(await collect(audioBytes(slices, 32040, 32060)));
  expect(part).toEqual(full.subarray(32040, 32061));
  const clip = [{ key: 'wave', startMs: 1000, endMs: 2000, sourceStartMs: 0 }];
  expect(Buffer.concat(await collect(audioBytes(clip, 44, 32043)))).toEqual(data.subarray(32044));
});

async function collect(source: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

it('does not append new speech to completed legacy conversations in the same session', async () => {
  const { user, c } = await fixture();
  const old = {
    ...c,
    id: 'legacy',
    status: 'completed' as const,
    audioStartMs: undefined,
    recordings: [],
  };
  await store.put(user.orgId, 'conversation', old.id, old);
  await saveSessionAudio(user, c.id, { key: 'new', startMs: 3000, endMs: 4000 }, 4000);
  expect(
    (await store.get<Conversation>(user.orgId, 'conversation', old.id))?.recordings,
  ).toHaveLength(0);
});
it('retains a shared block until its last reference is deleted and removes the session on retention', async () => {
  const { deleteConversation } = await import('./infra');
  const { user, c } = await fixture();
  await putFile('one', Buffer.alloc(100), 'audio/wav');
  const next = await switchClient(user, c.id, { segmentId: 's1' });
  await deleteConversation(user.orgId, c);
  expect((await getFile('one')).body.length).toBe(100);
  await deleteConversation(user.orgId, next!.conversation);
  await expect(getFile('one')).rejects.toThrow();
  expect(await store.get(user.orgId, 'work-session', c.id)).toBeNull();
});

it('ends the entire session after a concurrent client switch and rejects late undo or another switch', async () => {
  const { user, c } = await fixture();
  const next = await switchClient(user, c.id, { segmentId: 's1' });
  const ended = await finishWorkingSession(user, c.id);
  expect(ended.id).toBe(next!.conversation.id);
  expect(ended.status).toBe('completed');
  expect((await finishWorkingSession(user, c.id)).id).toBe(ended.id);
  await expect(undoClientSwitch(user, c.id, next!.boundary.id)).rejects.toThrow();
  await expect(switchClient(user, c.id)).rejects.toThrow('Сессия завершена');
});
