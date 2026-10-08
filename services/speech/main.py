"""Private streaming diarization gateway. No transcript from an unassigned voice enters RAG.

Model weights are loaded at startup; no keyword heuristic replaces diarization if loading fails.
One API instance maintains session profiles in RAM, expiring after 12 hours.
"""
import asyncio
import contextlib
import hmac
import os
import time
from contextlib import asynccontextmanager

import numpy as np
import torch
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Header, HTTPException
from pyannote.core import SlidingWindow, SlidingWindowFeature
from diart import SpeakerDiarization, SpeakerDiarizationConfig
from diart.models import SegmentationModel, EmbeddingModel
from silero_vad import load_silero_vad, get_speech_timestamps
from mistralai.client import Mistral
from mistralai.client.models import AudioFormat

SR = 16000
TOKEN = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
profiles: dict[str, tuple[np.ndarray, float]] = {}
models = {}
inference_lock = asyncio.Lock()
capacity = asyncio.Semaphore(int(os.getenv("SPEECH_MAX_SESSIONS", "10")))


def resolve_device():
    name = os.getenv("SPEECH_DEVICE", "cpu")
    if name not in {"cpu", "cuda"}:
        raise RuntimeError("SPEECH_DEVICE must be cpu or cuda")
    if name == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("SPEECH_DEVICE=cuda requires a CUDA build, NVIDIA GPU and Container Toolkit")
    return torch.device(name)


def load_models():
    device = resolve_device()
    torch.set_num_threads(int(os.getenv("TORCH_THREADS", "2")))
    token = os.getenv("HF_TOKEN")
    segmentation = SegmentationModel.from_pretrained("pyannote/segmentation-3.0", use_hf_token=token)
    embedding = EmbeddingModel.from_pretrained("pyannote/wespeaker-voxceleb-resnet34-LM", use_hf_token=token)
    segmentation.load()
    embedding.load()
    segmentation.to(device).eval()
    embedding.to(device).eval()
    return {"segmentation": segmentation, "embedding": embedding, "vad": load_silero_vad(), "device": device}


@asynccontextmanager
async def lifespan(app):
    if len(TOKEN) < 32:
        raise RuntimeError("INTERNAL_SERVICE_TOKEN must have at least 32 characters")
    if not os.getenv("MISTRAL_API_KEY"):
        raise RuntimeError("MISTRAL_API_KEY is required")
    models.update(await asyncio.to_thread(load_models))
    yield
    profiles.clear()


app = FastAPI(lifespan=lifespan)


@app.get("/health")
def health(x_internal_token: str = Header(default="")):
    if not TOKEN or not hmac.compare_digest(x_internal_token, TOKEN):
        raise HTTPException(401)
    return {"ok": bool(models), "diarization": "diart", "asr": "voxtral-realtime", "device": str(models.get("device", "unloaded"))}


def vector(audio: np.ndarray):
    with torch.inference_mode():
        value = models["embedding"](torch.from_numpy(audio.copy())[None, None, :].to(models["device"])).detach().cpu().numpy()[0]
    value = np.nan_to_num(value)
    norm = np.linalg.norm(value)
    if norm < 1e-7:
        raise ValueError("Недостаточно чистой речи для определения голоса")
    return value / norm


async def embed(audio):
    async with inference_lock:
        return await asyncio.to_thread(vector, audio)


async def transcribe(audio, ws, speaker):
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()

    async def chunks():
        for index in range(0, len(pcm), 3200):
            yield pcm[index:index + 3200]
            await asyncio.sleep(0)

    text = ""
    async with Mistral(api_key=os.environ["MISTRAL_API_KEY"]) as client, asyncio.timeout(25):
        async for event in client.audio.realtime.transcribe_stream(
            audio_stream=chunks(), model="voxtral-mini-transcribe-realtime-2602",
            audio_format=AudioFormat(encoding="pcm_s16le", sample_rate=SR),
            target_streaming_delay_ms=500,
        ):
            event_type = getattr(event, "type", "")
            if event_type == "transcription.text.delta":
                text += event.text
                await ws.send_json({"type": "partial", "text": text, "speakerId": speaker})
            elif event_type == "error":
                raise RuntimeError("Voxtral сообщил об ошибке распознавания")
    return text.strip()


@app.websocket("/stream")
async def stream(ws: WebSocket):
    if not TOKEN or not hmac.compare_digest(ws.headers.get("x-internal-token", ""), TOKEN):
        await ws.close(code=4401)
        return
    await ws.accept()
    if capacity.locked():
        await ws.send_json({"type": "error", "message": "Все каналы речи заняты"})
        await ws.close()
        return
    async with capacity:
        consumer = None
        try:
            init = await asyncio.wait_for(ws.receive_json(), timeout=10)
            profile_id = str(init.get("profileId", ""))[:200]
            if init.get("type") != "start" or not profile_id:
                raise ValueError("Неверная аудиосессия")
            for key, (_, expiry) in list(profiles.items()):
                if expiry < time.time():
                    profiles.pop(key, None)
            if init.get("mode") == "enroll":
                await ws.send_json({"type": "ready"})
                parts, size = [], 0
                while size < 25 * SR:
                    packet = await asyncio.wait_for(ws.receive_bytes(), timeout=10)
                    if len(packet) > 6400 or len(packet) % 2:
                        raise ValueError("Неверный PCM")
                    chunk = np.frombuffer(packet, dtype="<i2").astype(np.float32) / 32768
                    parts.append(chunk)
                    size += len(chunk)
                audio = np.concatenate(parts)
                async with inference_lock:
                    speech = await asyncio.to_thread(get_speech_timestamps, torch.from_numpy(audio), models["vad"], sampling_rate=SR)
                clean = np.concatenate([audio[item["start"]:item["end"]] for item in speech]) if speech else np.array([], dtype=np.float32)
                if len(clean) < SR * 8:
                    raise ValueError("Нужно не менее 8 секунд чистой речи. Запишите образец ещё раз.")
                vectors = [await embed(clean[i:i + 3 * SR]) for i in range(0, len(clean) - 3 * SR + 1, 3 * SR)]
                value = np.mean(vectors, axis=0)
                profiles[profile_id] = (value / np.linalg.norm(value), time.time() + 12 * 3600)
                await ws.send_json({"type": "enrolled"})
                return
            if profile_id not in profiles:
                raise ValueError("Сначала запишите образец голоса консультанта в настройках микрофона")
            staff = profiles[profile_id][0]
            pipeline = SpeakerDiarization(SpeakerDiarizationConfig(
                segmentation=models["segmentation"], embedding=models["embedding"],
                duration=5, step=.5, latency=2, sample_rate=SR, max_speakers=8,
                device=models["device"],
            ))
            queue = asyncio.Queue(maxsize=4)
            roles = {}
            customer = None
            last_staff_end = -100
            last_speech_end = 0.0
            turn_speaker = None
            turn_audio = []
            turn_start = 0.0
            turn_end = 0.0
            turn_gap = 0.0

            async def consume():
                nonlocal customer, last_staff_end, last_speech_end
                while True:
                    speaker, samples, start, end, gap = await queue.get()
                    try:
                        if len(samples) < SR * .65:
                            continue
                        identity = await embed(samples)
                        similarity = float(np.dot(staff, identity))
                        role = roles.get(speaker, "unknown")
                        if similarity >= float(os.getenv("STAFF_SIMILARITY_THRESHOLD", "0.65")):
                            role = "consultant"
                            roles[speaker] = role
                            last_staff_end = end
                        elif speaker == customer:
                            role = "customer"
                        elif customer is None and start - last_staff_end < 8 and similarity < .35 and len(samples) >= 2 * SR:
                            customer = speaker
                            role = "customer"
                            roles[speaker] = role
                        if role == "bystander":
                            continue
                        text = await transcribe(samples, ws, speaker)
                        if text:
                            await ws.send_json({"type": "segment", "text": text, "role": role,
                                "speakerId": speaker, "startMs": round(start * 1000), "endMs": round(end * 1000),
                                "confidence": .9 if role != "unknown" else .5,
                                "newSpeaker": role == "unknown", "gapMs": round(gap * 1000)})
                    finally:
                        queue.task_done()

            consumer = asyncio.create_task(consume())

            async def finish_turn():
                nonlocal turn_audio, turn_speaker, last_speech_end
                if turn_audio:
                    if queue.full():
                        raise ValueError("Распознавание отстаёт. Приостановите запись и проверьте соединение.")
                    queue.put_nowait((turn_speaker, np.concatenate(turn_audio), turn_start, turn_end, turn_gap))
                    last_speech_end = turn_end
                turn_audio, turn_speaker = [], None

            rolling = np.zeros(0, dtype=np.float32)
            total, since_step = 0, 0
            # Prefix with silence so the first utterance is not lost while warming the 5s window.
            rolling = np.zeros(5 * SR, dtype=np.float32)

            async def feed(values):
                nonlocal rolling, total, since_step, turn_speaker, turn_start, turn_gap, turn_end
                rolling = np.concatenate((rolling, values))[-5 * SR:]
                total += len(values)
                since_step += len(values)
                if since_step < SR // 2:
                    return
                since_step -= SR // 2
                window = SlidingWindowFeature(rolling[:, None].copy(), SlidingWindow(start=(total - len(rolling)) / SR, duration=1 / SR, step=1 / SR))
                async with inference_lock:
                    results = await asyncio.to_thread(pipeline, [window])
                for annotation, stable in results:
                    labels = annotation.labels()
                    start, end = stable.extent.start, stable.extent.end
                    if end <= 0:
                        continue
                    samples = stable.data[:, 0].astype(np.float32)
                    if start < 0:
                        samples = samples[round(-start * SR):]
                        start = 0
                    if len(labels) != 1:
                        await finish_turn()
                        if len(labels) > 1:
                            await ws.send_json({"type": "status", "status": "listening", "message": "Перекрывающаяся речь исключена из контекста"})
                        continue
                    speaker = str(labels[0])
                    if speaker != turn_speaker:
                        await finish_turn()
                        turn_speaker, turn_start, turn_gap = speaker, start, max(0, start - last_speech_end)
                    turn_audio.append(samples)
                    turn_end = end
                    if end - turn_start >= 10:
                        await finish_turn()

            await ws.send_json({"type": "ready"})
            while True:
                if consumer.done():
                    consumer.result()
                packet = await asyncio.wait_for(ws.receive(), timeout=30)
                if packet["type"] == "websocket.disconnect":
                    break
                if packet.get("text"):
                    import json
                    msg = json.loads(packet["text"])
                    if msg.get("type") == "stop":
                        # Release Diart's delayed tail before closing the upstream ASR streams.
                        for _ in range(10):
                            await feed(np.zeros(SR // 2, dtype=np.float32))
                        await finish_turn()
                        async with asyncio.timeout(30):
                            await queue.join()
                        if consumer.done():
                            consumer.result()
                        break
                    if msg.get("type") == "assign" and msg.get("role") in ("customer", "bystander"):
                        roles[str(msg["speakerId"])] = msg["role"]
                        if msg["role"] == "customer":
                            customer = str(msg["speakerId"])
                    continue
                binary = packet.get("bytes", b"")
                if not binary or len(binary) > 6400 or len(binary) % 2:
                    raise ValueError("Неверный PCM-фрагмент")
                await feed(np.frombuffer(binary, dtype="<i2").astype(np.float32) / 32768)
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            with contextlib.suppress(Exception):
                # Never echo provider payloads or secrets to the browser.
                await ws.send_json({"type": "error", "message": str(exc) if isinstance(exc, ValueError) else "Ошибка сервиса речи. Проверьте модели, ключ Mistral и соединение."})
        finally:
            if consumer:
                consumer.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await consumer
            with contextlib.suppress(Exception):
                await ws.close()
