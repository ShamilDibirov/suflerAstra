'use client';
import { useRef, useState, useEffect } from 'react';
import { encodeAudioFrame, type AppEvent } from '@sufler/shared';
import { socketUrl } from '@/lib/api';
export function useAudio(conversationId: string | undefined, onEvent: (event: AppEvent) => void) {
  const [status, setStatus] = useState('stopped'),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [deviceId, setDeviceId] = useState(''),
    [level, setLevel] = useState(0),
    [enrolled, setEnrolled] = useState(false),
    [draining, setDraining] = useState(false);
  const paused = useRef(false);
  const captureEpoch = useRef(0);
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
    if (!conversationId) return;
    const ws = new WebSocket(socketUrl(conversationId));
    socket.current = ws;
    ws.onmessage = (e) => {
      const event = JSON.parse(e.data) as AppEvent;
      if (event.type === 'audio.status') {
        const s = event.data as { status: string };
        setStatus(
          paused.current && ['listening', 'enrolling', 'finishing', 'stopped'].includes(s.status)
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
      if (event.type === 'error') {
        setDraining(false);
        cleanup();
        setStatus('stopped');
      }
      eventRef.current(event);
    };
    ws.onerror = () => {
      setDraining(false);
      setStatus('stopped');
      cleanup();
      eventRef.current({
        type: 'error',
        data: 'Связь с аудиосервисом прервана. Повторно включите микрофон.',
      });
    };
    ws.onclose = () => {
      setDraining(false);
      cleanup();
      setStatus('stopped');
    };
    return () => {
      cleanup();
      ws.close();
      socket.current = null;
    };
  }, [conversationId]);
  async function refreshDevices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list.filter((d) => d.kind === 'audioinput'));
  }
  async function start(enroll = false) {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) {
      eventRef.current({
        type: 'error',
        data: 'Аудиоканал ещё подключается. Повторите через секунду.',
      });
      return;
    }
    try {
      if (draining) return;
      const epoch = ++captureEpoch.current;
      paused.current = false;
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
        data: e instanceof Error ? e.message : 'Нет доступа к микрофону',
      });
    }
  }
  function stop() {
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
    draining,
    start,
    stop,
    assign,
    refreshDevices,
  };
}
