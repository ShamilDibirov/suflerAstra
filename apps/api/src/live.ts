import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { z } from 'zod';
import { session, assertOrigin } from './auth';
import { config } from './config';
import { events, emit } from './events';
import { addSegment, requireConversation, assignSpeaker } from './conversations';
import { maskPII } from '@sufler/shared/engine';
import { store } from './store';
import {
  ensureSession,
  requireWorkSession,
  saveSessionAudio,
  checkClientBoundary,
  noteSessionTime,
  forgetSessionTime,
  sessionKey,
} from './working-sessions';
import { putFile } from './storage';
import { decodeAudioFrame, type AppEvent, type Conversation } from '@sufler/shared';

function wav(pcm: Buffer) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const connections = new Set<string>();
export function setupLive(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '/', config.origin);
    if (url.pathname !== '/api/live') {
      socket.destroy();
      return;
    }
    try {
      assertOrigin(req);
      const user = await session(req);
      const requested = url.searchParams.get('sessionId');
      const legacy = url.searchParams.get('conversationId');
      const initial = requested
        ? await requireWorkSession(user, requested)
        : legacy
          ? await ensureSession(user, await requireConversation(user, legacy, true))
          : null;
      if (!initial || initial.status !== 'active' || connections.has(initial.id))
        throw new Error('Сессия недоступна или уже подключена');
      const id = initial.activeId,
        workId = initial.id;
      connections.add(workId);
      wss.handleUpgrade(req, socket, head, (ws) => {
        let speech: WebSocket | null = null,
          conversationId = id,
          raw: Buffer[] = [],
          bytes = 0,
          offset = 0,
          enrolling = false,
          closed = false,
          lastFrame = 0,
          frameCount = 0,
          draining = false,
          sequence = 0,
          receivedSamples = 0;
        let audioEpoch = 0,
          streamStart = initial.timelineMs;
        const promptedSpeakers = new Set<string>();
        let writeChain = Promise.resolve();
        const pendingSegments = new Set<Promise<unknown>>();
        const send = (event: AppEvent) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
        };
        const flush = () => {
          if (!bytes || !conversationId) {
            raw = [];
            bytes = 0;
            return;
          }
          const pcm = Buffer.concat(raw);
          const startMs = offset;
          offset += pcm.length / 32;
          raw = [];
          bytes = 0;
          writeChain = writeChain
            .then(async () => {
              const key = `${user.orgId}/recordings/${workId}/${randomUUID()}.wav`;
              await putFile(key, wav(pcm), 'audio/wav');
              await saveSessionAudio(
                user,
                workId,
                { key, startMs, endMs: startMs + pcm.length / 32 },
                startMs + pcm.length / 32,
              );
            })
            .catch(() =>
              send({
                type: 'error',
                scope: 'storage',
                data: 'Не удалось сохранить аудио. Запись продолжается, в истории будет отмечен пропуск.',
              }),
            );
        };
        const stopAudio = (graceful = false) => {
          audioEpoch++;
          if (graceful && speech?.readyState === WebSocket.OPEN && !enrolling) {
            if (!draining) {
              draining = true;
              speech.send(JSON.stringify({ type: 'stop' }));
              send({ type: 'audio.status', data: { status: 'finishing' } });
            }
            flush();
            return;
          }
          const hadSpeech = !!speech;
          speech?.close();
          speech = null;
          draining = false;
          flush();
          if (hadSpeech)
            void Promise.allSettled([writeChain, ...pendingSegments]).then(async () => {
              await saveSessionAudio(user, workId, null, streamStart + receivedSamples / 16);
              send({ type: 'audio.status', data: { status: 'stopped' } });
            });
        };
        const onEvent = (event: AppEvent) => {
          if (event.type === 'client.switched' && (event.data as any).session.id === workId)
            conversationId = (event.data as any).conversation.id;
          send(event);
          if (
            event.type === 'conversation.updated' &&
            event.conversationId === conversationId &&
            (event.data as Conversation).status === 'completed'
          )
            stopAudio();
        };
        events.on(`${user.orgId}:${user.id}`, onEvent);
        const check = setInterval(async () => {
          try {
            const refreshed = await session(req);
            if (refreshed.id !== user.id || refreshed.orgId !== user.orgId)
              ws.close(4001, 'Session changed');
            if (conversationId) {
              const c = await requireConversation(refreshed, conversationId, true);
              if (c.status !== 'active') stopAudio();
            }
          } catch {
            ws.close(4001, 'Session expired');
          }
        }, 15000);
        ws.on('message', async (data, binary) => {
          try {
            if (binary) {
              // PCM already in transit may arrive after enrollment or stop closes
              // the upstream. Ignore it instead of replacing a successful result
              // with an error. Upstream failures are reported by their own handlers.
              if (draining || !speech || speech.readyState !== WebSocket.OPEN) return;
              const decoded = decodeAudioFrame(
                Buffer.from(data as Buffer),
                sequence,
                receivedSamples,
              );
              const frame = Buffer.from(decoded);
              const second = Math.floor(Date.now() / 1000);
              if (second !== lastFrame) {
                lastFrame = second;
                frameCount = 0;
              }
              if (++frameCount > 25) throw new Error('Аудиопоток слишком быстрый');
              if (speech.bufferedAmount > 32000 * 3)
                throw new Error('Обработка отстаёт. Запись приостановлена');
              speech.send(frame);
              sequence++;
              receivedSamples += frame.length / 2;
              noteSessionTime(workId, streamStart + receivedSamples / 16);
              if (!enrolling && config.recordAudio) {
                raw.push(frame);
                bytes += frame.length;
                if (bytes >= 32000 * 30) flush();
              }
              return;
            }
            const message = z
              .object({
                type: z.enum(['audio.start', 'audio.stop', 'audio.assign']),
                mode: z.enum(['enroll', 'listen']).optional(),
                speakerId: z.string().max(80).optional(),
                role: z.enum(['customer', 'consultant', 'bystander']).optional(),
              })
              .parse(JSON.parse(data.toString()));
            if (message.type === 'audio.stop') {
              stopAudio(true);
              if (!draining) send({ type: 'audio.status', data: { status: 'stopped' } });
              return;
            }
            if (message.type === 'audio.assign') {
              if (!message.speakerId || !message.role) throw new Error('Выберите говорящего');
              if (conversationId)
                await assignSpeaker(user, conversationId, message.speakerId, message.role);
              speech?.send(
                JSON.stringify({
                  type: 'assign',
                  speakerId: message.speakerId,
                  role: message.role,
                }),
              );
              return;
            }
            if (config.demo) {
              send({
                type: 'audio.status',
                data: {
                  status: 'demo',
                  message: 'В демо микрофон не отправляется в AI. Используйте пример диалога.',
                },
              });
              return;
            }
            if (!conversationId) throw new Error('Сначала начните диалог');
            const requestEpoch = ++audioEpoch;
            const current = await requireConversation(user, conversationId, true);
            if (requestEpoch !== audioEpoch || ws.readyState !== WebSocket.OPEN) return;
            if (current.status !== 'active') throw new Error('Диалог завершён');
            if (speech) throw new Error('Микрофон уже подключён');
            promptedSpeakers.clear();
            enrolling = message.mode === 'enroll';
            draining = false;
            sequence = 0;
            receivedSamples = 0;
            const work = await requireWorkSession(user, workId);
            if (
              requestEpoch !== audioEpoch ||
              ws.readyState !== WebSocket.OPEN ||
              work.status !== 'active'
            )
              return;
            conversationId = work.activeId;
            offset = Math.max(offset, work.timelineMs);
            streamStart = offset;
            const sessionOffset = offset;
            const upstream = new URL(config.speech);
            upstream.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
            upstream.pathname = '/stream';
            speech = new WebSocket(upstream, {
              headers: { 'X-Internal-Token': config.internalToken },
              maxPayload: 1024 * 1024,
              handshakeTimeout: 10_000,
            });
            const channel = speech;
            speech.on('open', () => {
              if (speech !== channel) return;
              channel.send(
                JSON.stringify({
                  type: 'start',
                  profileId: `${user.orgId}:${user.id}`,
                  mode: message.mode || 'listen',
                }),
              );
            });
            speech.on('message', async (buffer) => {
              try {
                if (speech !== channel) return;
                const event = JSON.parse(buffer.toString());
                if (event.type === 'ready') {
                  send({
                    type: 'audio.status',
                    data: { status: enrolling ? 'enrolling' : 'listening' },
                  });
                  return;
                }
                if (event.type === 'enrolled') {
                  enrolling = false;
                  send({ type: 'audio.status', data: { status: 'enrolled' } });
                  stopAudio();
                  return;
                }
                if (event.type === 'partial') {
                  send({
                    type: 'transcript.partial',
                    conversationId: conversationId!,
                    data: event,
                  });
                  return;
                }
                if (event.type === 'status') {
                  send({ type: 'audio.status', data: event });
                  return;
                }
                if (event.type === 'error') {
                  send({
                    type: 'error',
                    scope: 'audio',
                    recoverable: event.recoverable === true,
                    data: event.message,
                  });
                  stopAudio();
                  return;
                }
                if (event.type === 'segment' && conversationId) {
                  const parsed = z
                    .object({
                      text: z.string().min(1).max(4000),
                      role: z.enum(['consultant', 'customer', 'unknown', 'bystander']),
                      speakerId: z.string(),
                      startMs: z.number().nonnegative(),
                      endMs: z.number().nonnegative(),
                      confidence: z.number().min(0).max(1),
                      newSpeaker: z.boolean().optional(),
                      roleInference: z.boolean().optional(),
                      ambiguous: z.boolean().optional(),
                      gapMs: z.number().optional(),
                    })
                    .parse(event);
                  parsed.startMs += sessionOffset;
                  parsed.endMs += sessionOffset;
                  const saving = store.withLock(sessionKey(user.orgId, workId), async () => {
                    const work = await requireWorkSession(user, workId);
                    conversationId = work.activeId;
                    const history = (
                      await store.list<Conversation>(user.orgId, 'conversation')
                    ).filter((c) => (c.sessionId || c.id) === workId && !c.mergedInto);
                    const destination = history.find(
                      (c) =>
                        !(c.status === 'completed' && c.audioEndMs === undefined) &&
                        (c.audioStartMs ?? 0) <= parsed.startMs &&
                        (c.audioEndMs ?? Infinity) > parsed.startMs,
                    );
                    // Final ASR results received after a switch belong to their original time range.
                    const targetId = destination?.id || conversationId;
                    return destination?.status === 'completed'
                      ? store.mutateConversation(user.orgId, targetId, (v) => ({
                          ...v,
                          segments: [
                            ...v.segments,
                            {
                              ...parsed,
                              text: maskPII(parsed.text),
                              id: randomUUID(),
                              final: true,
                              excluded:
                                !!parsed.ambiguous ||
                                parsed.role === 'bystander' ||
                                (parsed.role === 'unknown' && !parsed.roleInference),
                              createdAt: new Date().toISOString(),
                            },
                          ],
                        }))
                      : addSegment(user, targetId, {
                          ...parsed,
                          id: randomUUID(),
                          final: true,
                          excluded:
                            !!parsed.ambiguous ||
                            parsed.role === 'bystander' ||
                            (parsed.role === 'unknown' && !parsed.roleInference),
                          createdAt: new Date().toISOString(),
                        });
                  });
                  pendingSegments.add(saving);
                  try {
                    await saving;
                    void checkClientBoundary(user, workId).catch(() => {});
                  } finally {
                    pendingSegments.delete(saving);
                  }
                }
              } catch {
                send({
                  type: 'error',
                  scope: 'assistant',
                  data: 'Не удалось сохранить расшифровку. Аудиоканал продолжает работать.',
                });
              }
            });
            speech.on('error', () => {
              if (speech !== channel) return;
              send({
                type: 'error',
                scope: 'audio',
                recoverable: true,
                data: 'Сервис речи недоступен. Проверьте подключение и состояние моделей.',
              });
              stopAudio();
            });
            speech.on('close', () => {
              if (speech !== channel) return;
              speech = null;
              draining = false;
              flush();
              void Promise.allSettled([writeChain, ...pendingSegments]).then(async () => {
                await saveSessionAudio(user, workId, null, streamStart + receivedSamples / 16);
                send({ type: 'audio.status', data: { status: 'stopped' } });
              });
            });
          } catch (e) {
            send({
              type: 'error',
              scope: 'audio',
              data: e instanceof Error ? e.message : 'Ошибка аудиопотока',
            });
            stopAudio();
          }
        });
        ws.on('close', () => {
          if (closed) return;
          closed = true;
          clearInterval(check);
          events.off(`${user.orgId}:${user.id}`, onEvent);
          stopAudio();
          void writeChain
            .finally(async () => {
              try {
                await saveSessionAudio(user, workId, null, streamStart + receivedSamples / 16);
              } finally {
                connections.delete(workId);
                forgetSessionTime(workId);
              }
            })
            .catch(() => {});
        });
        ws.on('error', () => ws.close());
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });
  return wss;
}
