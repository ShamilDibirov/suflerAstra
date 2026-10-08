import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { z } from 'zod';
import { session, assertOrigin } from './auth';
import { config } from './config';
import { events, emit } from './events';
import { addSegment, requireConversation, createConversation } from './conversations';
import { store } from './store';
import { putFile, deleteFile } from './storage';
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
      const id = url.searchParams.get('conversationId');
      if (id) await requireConversation(user, id, true);
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
        let writeChain = Promise.resolve();
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
          const target = conversationId;
          writeChain = writeChain
            .then(async () => {
              const c = await store.get<Conversation>(user.orgId, 'conversation', target);
              if (!c) return;
              const key = `${user.orgId}/recordings/${target}/${randomUUID()}.wav`;
              await putFile(key, wav(pcm), 'audio/wav');
              const saved = await store.mutateConversation(user.orgId, target, (v) => ({
                ...v,
                recordings: [...v.recordings, { key, startMs, endMs: startMs + pcm.length / 32 }],
              }));
              if (!saved) await deleteFile(key);
            })
            .catch(() => send({ type: 'error', data: 'Не удалось сохранить часть аудиозаписи' }));
        };
        const stopAudio = (graceful = false) => {
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
          if (hadSpeech) send({ type: 'audio.status', data: { status: 'stopped' } });
        };
        const onEvent = (event: AppEvent) => {
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
              sequence++;
              receivedSamples += frame.length / 2;
              const second = Math.floor(Date.now() / 1000);
              if (second !== lastFrame) {
                lastFrame = second;
                frameCount = 0;
              }
              if (++frameCount > 25) throw new Error('Аудиопоток слишком быстрый');
              if (speech.bufferedAmount > 32000 * 3)
                throw new Error('Обработка отстаёт. Запись приостановлена');
              speech.send(frame);
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
                role: z.enum(['customer', 'bystander']).optional(),
              })
              .parse(JSON.parse(data.toString()));
            if (message.type === 'audio.stop') {
              stopAudio(true);
              if (!draining) send({ type: 'audio.status', data: { status: 'stopped' } });
              return;
            }
            if (message.type === 'audio.assign') {
              if (!message.speakerId || !message.role) throw new Error('Выберите говорящего');
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
            const current = await requireConversation(user, conversationId, true);
            if (current.status !== 'active') throw new Error('Диалог завершён');
            if (speech) throw new Error('Микрофон уже подключён');
            enrolling = message.mode === 'enroll';
            draining = false;
            sequence = 0;
            receivedSamples = 0;
            offset = Math.max(
              0,
              ...current.recordings.map((r) => r.endMs),
              ...current.segments.map((s) => s.endMs),
            );
            const sessionOffset = offset;
            const targetId = conversationId;
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
                  send({ type: 'error', data: event.message });
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
                      gapMs: z.number().optional(),
                    })
                    .parse(event);
                  parsed.startMs += sessionOffset;
                  parsed.endMs += sessionOffset;
                  if (parsed.newSpeaker && parsed.role === 'unknown') {
                    const active = await requireConversation(user, conversationId, true);
                    if (
                      active.card.ending &&
                      parsed.confidence >= 0.85 &&
                      (parsed.gapMs || 0) >= 2500 &&
                      /здравств|добрый|подскажите/i.test(parsed.text)
                    ) {
                      stopAudio();
                      const next = await createConversation(user, active.modelId);
                      conversationId = next.id;
                      await addSegment(user, next.id, {
                        ...parsed,
                        id: randomUUID(),
                        role: 'customer',
                        final: true,
                        excluded: false,
                        createdAt: new Date().toISOString(),
                      });
                      send({
                        type: 'audio.status',
                        data: {
                          status: 'stopped',
                          message: 'Начат новый разговор. Включите микрофон.',
                        },
                      });
                      return;
                    }
                    send({ type: 'session.boundary', conversationId, data: parsed });
                    return;
                  }
                  await addSegment(user, targetId, {
                    ...parsed,
                    id: randomUUID(),
                    final: true,
                    excluded: !['customer', 'consultant'].includes(parsed.role),
                    createdAt: new Date().toISOString(),
                  });
                }
              } catch {
                send({ type: 'error', data: 'Не удалось обработать результат распознавания' });
              }
            });
            speech.on('error', () => {
              if (speech !== channel) return;
              send({
                type: 'error',
                data: 'Сервис речи недоступен. Проверьте подключение и состояние моделей.',
              });
              stopAudio();
            });
            speech.on('close', () => {
              if (speech !== channel) return;
              speech = null;
              draining = false;
              flush();
              send({ type: 'audio.status', data: { status: 'stopped' } });
            });
          } catch (e) {
            send({ type: 'error', data: e instanceof Error ? e.message : 'Ошибка аудиопотока' });
            stopAudio();
          }
        });
        ws.on('close', () => {
          if (closed) return;
          closed = true;
          clearInterval(check);
          events.off(`${user.orgId}:${user.id}`, onEvent);
          stopAudio();
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
