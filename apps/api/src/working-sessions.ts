import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type {
  WorkingSession,
  Conversation,
  SessionUser,
  AudioSlice,
  ClientBoundary,
} from '@sufler/shared';
import { newConversation, invalidate } from '@sufler/shared/engine';
import { store } from './store';
import { emit } from './events';
import { inferBoundary } from './ai';

export const sessionKey = (org: string, id: string) => `work-session:${org}:${id}`;
export async function ensureSession(user: SessionUser, c: Conversation) {
  const id = c.sessionId || c.id;
  return store.withLock(sessionKey(user.orgId, id), async () => {
    const saved = await store.get<WorkingSession>(user.orgId, 'work-session', id);
    if (saved) {
      if (saved.userId !== user.id) throw new NotFoundException();
      return saved;
    }
    const s: WorkingSession = {
      id,
      orgId: user.orgId,
      userId: user.id,
      activeId: c.id,
      status: c.status,
      revision: 0,
      timelineMs: Math.max(
        0,
        ...c.recordings.map((r) => r.endMs),
        ...c.segments.map((r) => r.endMs),
      ),
      boundaries: [],
      createdAt: c.createdAt,
    };
    await store.put(user.orgId, 'work-session', id, s);
    return s;
  });
}
export async function requireWorkSession(user: SessionUser, id: string) {
  const s = await store.get<WorkingSession>(user.orgId, 'work-session', id);
  if (!s || s.userId !== user.id) throw new NotFoundException();
  return s;
}
export function clipRecording(r: AudioSlice, start: number, end: number): AudioSlice | null {
  const lo = Math.max(r.startMs, start),
    hi = Math.min(r.endMs, end);
  return hi > lo
    ? { ...r, startMs: lo, endMs: hi, sourceStartMs: r.sourceStartMs ?? r.startMs }
    : null;
}
export async function saveSessionAudio(
  user: SessionUser,
  id: string,
  audio: AudioSlice | null,
  timelineMs: number,
) {
  await store.withLock(sessionKey(user.orgId, id), () =>
    store.sessionTransaction(user.orgId, id, (records, put) => {
      const s = records.get(`work-session:${id}`) as WorkingSession;
      if (!s) return;
      s.timelineMs = Math.max(s.timelineMs, timelineMs);
      put('work-session', id, s);
      if (!audio) return;
      for (const [key, c] of records) {
        if (
          !key.startsWith('conversation:') ||
          c.mergedInto ||
          (c.status === 'completed' && c.audioEndMs === undefined)
        )
          continue;
        const piece = clipRecording(audio, c.audioStartMs ?? 0, c.audioEndMs ?? Infinity);
        if (
          piece &&
          !c.recordings.some((r: AudioSlice) => r.key === piece.key && r.startMs === piece.startMs)
        ) {
          c.recordings.push(piece);
          put('conversation', c.id, c);
        }
      }
    }),
  );
}
const clocks = new Map<string, number>();
export function noteSessionTime(id: string, time: number) {
  clocks.set(id, Math.max(clocks.get(id) || 0, time));
}
export function forgetSessionTime(id: string) {
  clocks.delete(id);
}
const jobs = new Map<string, Promise<void>>();
export function checkClientBoundary(user: SessionUser, id: string) {
  if (jobs.has(id)) return jobs.get(id)!;
  const job = (async () => {
    let last = '';
    for (;;) {
      const session = await requireWorkSession(user, id);
      if (
        session.status !== 'active' ||
        session.boundaries.some(
          (b) => b.status === 'applied' && Date.parse(b.undoUntil) > Date.now(),
        )
      )
        return;
      const c = await store.get<Conversation>(user.orgId, 'conversation', session.activeId);
      if (!c || c.segments.at(-1)?.id === last) return;
      last = c.segments.at(-1)?.id || '';
      if (!last) return;
      const candidate = await inferBoundary(c, new AbortController().signal);
      if (candidate && !session.boundaries.some((b) => b.segmentId === candidate)) {
        const switched = await switchClient(user, id, {
          segmentId: candidate,
          expectedRevision: session.revision,
          expectedConversation: c.id,
        });
        if (switched) return;
      }
    }
  })().finally(() => jobs.delete(id));
  jobs.set(id, job);
  return job;
}
export async function switchClient(
  user: SessionUser,
  id: string,
  options: {
    segmentId?: string;
    atMs?: number;
    expectedRevision?: number;
    expectedConversation?: string;
  } = {},
) {
  const { cancel, reclassify } = await import('./conversations');
  const result = await store.withLock(sessionKey(user.orgId, id), () =>
    store.sessionTransaction(user.orgId, id, (records, put) => {
      const s = records.get(`work-session:${id}`) as WorkingSession;
      if (!s || s.userId !== user.id) throw new NotFoundException();
      if (s.status !== 'active') throw new BadRequestException('Сессия завершена');
      if (
        options.expectedRevision !== undefined &&
        (s.revision !== options.expectedRevision || s.activeId !== options.expectedConversation)
      )
        return null;
      if (s.boundaries.some((b) => b.status === 'applied' && Date.parse(b.undoUntil) > Date.now()))
        return null;
      const c = records.get(`conversation:${s.activeId}`) as Conversation;
      const index = options.segmentId
        ? c.segments.findIndex((x) => x.id === options.segmentId)
        : -1;
      if (
        options.segmentId &&
        (index < 1 || s.boundaries.some((b) => b.segmentId === options.segmentId))
      )
        return null;
      const atMs =
        index >= 0 ? c.segments[index].startMs : (options.atMs ?? clocks.get(id) ?? s.timelineMs);
      const next = newConversation(
        user.orgId,
        user.id,
        c.modelId,
        `Клиент №${String([...records.keys()].filter((k) => k.startsWith('conversation:')).length + 1).padStart(2, '0')}`,
      );
      Object.assign(next, {
        sessionId: id,
        audioStartMs: atMs,
        autoHints: c.autoHints,
        assistanceMode: c.assistanceMode,
        salesScriptId: c.salesScriptId,
        region: c.region,
        speakerRoles: c.speakerRoles,
      });
      next.segments = index >= 0 ? c.segments.slice(index) : [];
      next.lastConfirmedAt = next.segments.at(-1)?.createdAt;
      next.recordings = c.recordings.flatMap((r) => {
        const p = clipRecording(r, atMs, Infinity);
        return p ? [p] : [];
      });
      const old = invalidate(c);
      if (options.segmentId) {
        const revision = old.card.revision;
        old.card = newConversation(user.orgId, user.id, c.modelId, c.card.label).card;
        old.card.revision = revision;
        old.card.id = old.id;
      }
      old.status = 'completed';
      old.endedAt = new Date().toISOString();
      old.audioEndMs = atMs;
      old.segments = index >= 0 ? c.segments.slice(0, index) : c.segments;
      old.recordings = c.recordings.flatMap((r) => {
        const p = clipRecording(r, 0, atMs);
        return p ? [p] : [];
      });
      const b: ClientBoundary = {
        id: randomUUID(),
        fromId: c.id,
        toId: next.id,
        atMs,
        segmentId: options.segmentId || `manual:${randomUUID()}`,
        at: new Date().toISOString(),
        undoUntil: new Date(Date.now() + 15000).toISOString(),
        status: 'applied',
      };
      s.activeId = next.id;
      s.revision++;
      s.boundaries.push(b);
      cancel(c.id);
      put('conversation', c.id, old);
      put('conversation', next.id, next);
      put('work-session', id, s);
      return { conversation: next, previous: old, boundary: b, session: s };
    }),
  );
  if (result) {
    emit(user.orgId, user.id, {
      type: 'client.switched',
      conversationId: result.conversation.id,
      data: result,
    });
    void reclassify(user, result.conversation).catch(() => {});
    void reclassify(user, result.previous).catch(() => {});
  }
  return result;
}
export async function undoClientSwitch(user: SessionUser, id: string, boundaryId: string) {
  const { cancel, reclassify } = await import('./conversations');
  const result = await store.withLock(sessionKey(user.orgId, id), () =>
    store.sessionTransaction(user.orgId, id, (records, put) => {
      const s = records.get(`work-session:${id}`) as WorkingSession;
      if (!s || s.userId !== user.id) throw new NotFoundException();
      const b = s.boundaries.find((b) => b.id === boundaryId);
      if (!b) throw new NotFoundException();
      if (b.status === 'undone')
        return {
          alreadyUndone: true,
          conversation: records.get(`conversation:${b.fromId}`) as Conversation,
          boundary: b,
          session: s,
        };
      if (s.status !== 'active' || s.activeId !== b.toId || Date.parse(b.undoUntil) < Date.now())
        throw new BadRequestException('Время отмены истекло');
      const old = records.get(`conversation:${b.fromId}`) as Conversation,
        next = records.get(`conversation:${b.toId}`) as Conversation;
      if (!old || !next) throw new NotFoundException();
      cancel(old.id);
      cancel(next.id);
      const restored = invalidate(old);
      // Rebuild facts from all confirmed speech, rather than retaining facts from the wrong split.
      restored.card = newConversation(user.orgId, user.id, old.modelId, old.card.label).card;
      restored.card.id = old.id;
      restored.card.revision = Math.max(old.card.revision, next.card.revision) + 1;
      restored.status = 'active';
      restored.endedAt = null;
      delete restored.audioEndMs;
      restored.segments = [...old.segments, ...next.segments].sort((a, b) => a.startMs - b.startMs);
      restored.recordings = [...old.recordings, ...next.recordings].sort(
        (a, b) => a.startMs - b.startMs,
      );
      restored.messages = [...old.messages, ...next.messages];
      restored.hints = [
        ...restored.hints,
        ...next.hints.map((h) => ({ ...h, status: 'stale' as const })),
      ];
      restored.speakerRoles = { ...old.speakerRoles, ...next.speakerRoles };
      delete restored.lastConfirmedAt;
      next.status = 'completed';
      next.mergedInto = old.id;
      next.recordings = [];
      next.segments = [];
      next.hints = [];
      next.messages = [];
      s.activeId = old.id;
      s.revision++;
      b.status = 'undone';
      for (const [key, call] of records)
        if (key.startsWith('model-call:') && call.conversationId === next.id)
          put('model-call', call.id, { ...call, conversationId: old.id });
      put('conversation', old.id, restored);
      put('conversation', next.id, next);
      put('work-session', id, s);
      return { conversation: restored, boundary: b, session: s };
    }),
  );
  if ('alreadyUndone' in result) return result;
  emit(user.orgId, user.id, {
    type: 'client.switched',
    conversationId: result.conversation.id,
    data: result,
  });
  void reclassify(user, result.conversation).catch(() => {});
  return result;
}

/** End the work session even if a client transition won the race with the stop button. */
export async function finishWorkingSession(user: SessionUser, id: string) {
  const { cancel } = await import('./conversations');
  const result = await store.withLock(sessionKey(user.orgId, id), () =>
    store.sessionTransaction(user.orgId, id, (records, put) => {
      const s = records.get(`work-session:${id}`) as WorkingSession;
      if (!s || s.userId !== user.id) throw new NotFoundException();
      const c = records.get(`conversation:${s.activeId}`) as Conversation;
      if (!c) throw new NotFoundException();
      if (s.status === 'completed') return c;
      cancel(c.id);
      const ended = invalidate(c);
      ended.status = 'completed';
      ended.endedAt = new Date().toISOString();
      ended.audioEndMs = Math.max(s.timelineMs, clocks.get(id) || 0);
      s.status = 'completed';
      s.revision++;
      put('conversation', c.id, ended);
      put('work-session', id, s);
      return ended;
    }),
  );
  emit(user.orgId, user.id, {
    type: 'conversation.updated',
    conversationId: result.id,
    data: result,
  });
  return result;
}
