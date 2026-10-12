'use client';
import { useRef, useState, useEffect } from 'react';
import { encodeAudioFrame, type AppEvent } from '@sufler/shared';
import { isAudioFailure, shouldRetrySpeech } from '@/lib/audio-events';
import { api, socketUrl } from '@/lib/api';
export function useAudio(conversationId: string | undefined, onEvent: (event: AppEvent) => void) {
  const [status, setStatus] = useState('stopped'),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [deviceId, setDeviceId] = useState(''),
    [level, setLevel] = useState(0),
    [enrolled, setEnrolled] = useState(false),
    [provider, setProvider] = useState(''),
    [draining, setDraining] = useState(false);
  const paused = useRef(false);
  const enrolling = useRef(false);
  const captureEpoch = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  const resumeRef = useRef<() => void>(() => {});
  resumeRef.current = () => {
    void start(false, true);
  };
  const socket = useRef<WebSocket | null>(null),
    stream = useRef<MediaStream | null>(null),
    context = useRef<AudioContext | null>(null),
    eventRef = useRef(onEvent),
    stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  eventRef.current = onEvent;
  const cleanup = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void context.current?.close().catch(() => {});
    context.current = null;
    if (stopTimer.current) clearTimeout(stopTimer.current);
    setLevel(0);
  };
  useEffect(() => {
    captureEpoch.current++;
    setDraining(false);
    setStatus('stopped');
    setEnrolled(false);
    setProvider('');
    let current = true;
    void api<{ available: boolean; provider?: string; model?: string }>('/voice-profile')
      .then((profile) => {
        if (!current) return;
        setEnrolled(profile.available);
        setProvider([profile.provider, profile.model].filter(Boolean).join(' · '));
      })
      .catch(() => {});
    if (!conversationId)
      return () => {
        current = false;
      };
    const ws = new WebSocket(socketUrl(conversationId));
    socket.current = ws;
    ws.onmessage = (e) => {
      if (socket.current !== ws) return;
      const event = JSON.parse(e.data) as AppEvent;
      if (event.type === 'audio.status') {
        const s = event.data as { status: string };
        setStatus(
          retryTimer.current
            ? 'reconnecting'
            : paused.current &&
                ['listening', 'enrolling', 'finishing', 'stopped'].includes(s.status)
              ? 'paused'
              : s.status,
        );
        if (s.status === 'stopped') setDraining(false);
        if (s.status === 'enrolled') {
          setEnrolled(true);
          cleanup();
        }
        if (['stopped', 'demo', 'finishing'].includes(s.status)) cleanup();
      }
      if (isAudioFailure(event)) {
        setDraining(false);
        cleanup();
        setStatus('stopped');
        if (shouldRetrySpeech(event, attempts.current, paused.current || enrolling.current)) {
          attempts.current++;
          setStatus('reconnecting');
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            if (!paused.current) resumeRef.current();
          }, 1500 * attempts.current);
        }
      }
      eventRef.current(event);
    };
    ws.onerror = () => {
      if (socket.current !== ws) return;
      setDraining(false);
      setStatus('stopped');
      cleanup();
      eventRef.current({
        type: 'error',
        scope: 'audio',
        data: 'Связь с аудиосервисом прервана. Повторно включите микрофон.',
      });
    };
    ws.onclose = () => {
      if (socket.current !== ws) return;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      setDraining(false);
      cleanup();
      setStatus('stopped');
    };
    return () => {
      current = false;
      captureEpoch.current++;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      cleanup();
      ws.close();
      socket.current = null;
    };
  }, [conversationId]);
  async function refreshDevices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list.filter((d) => d.kind === 'audioinput'));
  }
  async function start(enroll = false, retry = false) {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) {
      eventRef.current({
        type: 'error',
        scope: 'audio',
        data: 'Аудиоканал ещё подключается. Повторите через секунду.',
      });
      return;
    }
    try {
      if (draining) return;
      if (!retry) attempts.current = 0;
      const epoch = ++captureEpoch.current;
      paused.current = false;
      enrolling.current = enroll;
      setStatus('connecting');
      const capture = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      if (paused.current || epoch !== captureEpoch.current) {
        capture.getTracks().forEach((track) => track.stop());
        setDraining(false);
        return;
      }
      stream.current = capture;
      await refreshDevices();
      const ctx = new AudioContext();
      context.current = ctx;
      await ctx.audioWorklet.addModule('/audio-worklet.js');
      await ctx.resume();
      if (paused.current || epoch !== captureEpoch.current) {
        cleanup();
        setDraining(false);
        return;
      }
      const source = ctx.createMediaStreamSource(capture),
        worklet = new AudioWorkletNode(ctx, 'pcm-processor'),
        mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(worklet);
      worklet.connect(mute);
      mute.connect(ctx.destination);
      let ready = false,
        sequence = 0,
        receivedSamples = 0;
      const ws = socket.current;
      const acknowledge = (event: MessageEvent) => {
        const payload = JSON.parse(event.data);
        if (
          payload.type === 'audio.status' &&
          ['listening', 'enrolling'].includes(payload.data.status)
        ) {
          ready = true;
          ws.removeEventListener('message', acknowledge);
        }
      };
      ws.addEventListener('message', acknowledge);
      worklet.port.onmessage = (e) => {
        const buffer = e.data as ArrayBuffer;
        const samples = new Int16Array(buffer);
        let sum = 0;
        for (const v of samples) sum += v * v;
        setLevel(Math.min(1, Math.sqrt(sum / samples.length) / 7000));
        if (!paused.current && ready && ws.readyState === WebSocket.OPEN) {
          if (ws.bufferedAmount > 64000) {
            stop();
            eventRef.current({
              type: 'error',
              data: 'Соединение не успевает передавать звук. Запись приостановлена.',
            });
            return;
          }
          ws.send(encodeAudioFrame(buffer, sequence++, receivedSamples));
          receivedSamples += buffer.byteLength / 2;
        }
      };
      ws.send(JSON.stringify({ type: 'audio.start', mode: enroll ? 'enroll' : 'listen' }));
      if (enroll) stopTimer.current = setTimeout(() => stop(), 35000);
    } catch (e) {
      cleanup();
      setStatus('stopped');
      eventRef.current({
        type: 'error',
        scope: 'audio',
        data: e instanceof Error ? e.message : 'Нет доступа к микрофону',
      });
    }
  }
  function stop() {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    captureEpoch.current++;
    paused.current = true;
    setDraining(['connecting', 'listening', 'enrolling'].includes(status));
    socket.current?.readyState === WebSocket.OPEN &&
      socket.current.send(JSON.stringify({ type: 'audio.stop' }));
    cleanup();
    setStatus('paused');
  }
  function assign(speakerId: string, role: 'customer' | 'consultant' | 'bystander') {
    socket.current?.send(JSON.stringify({ type: 'audio.assign', speakerId, role }));
  }
  return {
    status,
    devices,
    deviceId,
    setDeviceId,
    level,
    enrolled,
    provider,
    setEnrolled,
    draining,
    start,
    stop,
    assign,
    refreshDevices,
  };
}
