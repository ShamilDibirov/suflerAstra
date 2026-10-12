"""One continuous cloud ASR/diarization socket per consultation."""
import asyncio
import contextlib
import json
import os
import uuid
from urllib.parse import urlencode
from websockets.asyncio.client import connect


def groups(words):
    result = []
    for word in words:
        if not isinstance(word.get('start'), (int, float)) or not isinstance(word.get('end'), (int, float)):
            continue
        speaker = word.get('speaker')
        label = str(speaker) if isinstance(speaker, int) and speaker >= 0 else f"unassigned-{word['start']}"
        if not result or result[-1]['speaker'] != label:
            result.append({'speaker': label, 'start': word['start'], 'end': word['end'], 'words': []})
        group = result[-1]
        group['words'].append(word)
        group['end'] = word['end']
    return result


def turn_confidence(words):
    # A single uncertain filler must not discard an otherwise clear whole turn.
    return sum(float(w.get('confidence', 0)) for w in words) / len(words) if words else 0


async def listen(ws):
    key = os.environ.get('DEEPGRAM_API_KEY', '')
    if not key:
        raise ValueError('Добавьте DEEPGRAM_API_KEY и пересоздайте speech.')
    query = urlencode({'model': os.getenv('DEEPGRAM_MODEL', 'nova-3'), 'language': os.getenv('DEEPGRAM_LANGUAGE', 'ru'),
                       'encoding': 'linear16', 'sample_rate': '16000', 'channels': '1', 'diarize': 'true',
                       'interim_results': 'true', 'endpointing': '300', 'punctuate': 'true', 'smart_format': 'true'})
    namespace = uuid.uuid4().hex[:12]
    roles, seen = {}, set()
    finished = False
    async with connect('wss://api.deepgram.com/v1/listen?' + query,
                       additional_headers={'Authorization': 'Token ' + key},
                       open_timeout=12, close_timeout=5, max_size=2**20) as upstream:
        async def heartbeat():
            while not finished:
                await asyncio.sleep(4)
                if not finished:
                    await upstream.send(json.dumps({'type': 'KeepAlive'}))

        async def publish(words):
            await ws.send_json({'type': 'partial', 'text': '', 'speakerId': namespace})
            turns = groups(words)
            for group in turns:
                speaker = group['speaker']
                text = ' '.join(w.get('punctuated_word') or w.get('word', '') for w in group['words']).strip()
                signature = (speaker, group['start'], group['end'], text)
                if not text or signature in seen:
                    continue
                seen.add(signature)
                if len(seen) > 2000:
                    seen.clear()
                    seen.add(signature)
                ambiguous = any(other['speaker'] != speaker and group['start'] < other['end'] and other['start'] < group['end'] for other in turns)
                role = 'unknown' if ambiguous else roles.get(speaker, 'unknown')
                if role == 'bystander':
                    continue
                confidence = turn_confidence(group['words'])
                await ws.send_json({'type': 'segment', 'text': text, 'role': role,
                                    'speakerId': f'{namespace}:{speaker}', 'startMs': round(group['start'] * 1000),
                                    'endMs': round(group['end'] * 1000), 'confidence': confidence,
                                    'newSpeaker': False, 'roleInference': not ambiguous and not speaker.startswith('unassigned'), 'ambiguous': ambiguous})

        async def receive():
            pending = []
            final_words = set()
            async for raw in upstream:
                data = json.loads(raw)
                if data.get('type') == 'Error':
                    raise RuntimeError('Deepgram transcription error')
                if data.get('type') != 'Results':
                    continue
                alternatives = data.get('channel', {}).get('alternatives', [])
                if not alternatives:
                    continue
                alternative = alternatives[0]
                prefix = ' '.join(w.get('punctuated_word') or w.get('word', '') for w in pending)
                if not data.get('is_final'):
                    await ws.send_json({'type': 'partial', 'text': (prefix + ' ' + alternative.get('transcript', '')).strip(), 'speakerId': namespace})
                    continue
                for word in alternative.get('words', []):
                    signature = (word.get('speaker'), word.get('start'), word.get('end'), word.get('word'))
                    if signature not in final_words:
                        pending.append(word)
                        final_words.add(signature)
                if len(final_words) > 5000:
                    final_words.clear()
                # Feed complete turns into the card; keep completed ASR chunks visible meanwhile.
                duration = pending[-1].get('end', 0) - pending[0].get('start', 0) if pending else 0
                if pending and (data.get('speech_final') or data.get('from_finalize') or duration >= 5):
                    await publish(pending)
                    pending = []
                elif pending:
                    await ws.send_json({'type': 'partial', 'text': ' '.join(w.get('punctuated_word') or w.get('word', '') for w in pending), 'speakerId': namespace})
            if pending:
                await publish(pending)

        receiver = asyncio.create_task(receive())
        keeper = asyncio.create_task(heartbeat())
        await ws.send_json({'type': 'ready'})
        try:
            while True:
                packet_task = asyncio.create_task(ws.receive())
                try:
                    done, _ = await asyncio.wait([packet_task, receiver, keeper], return_when=asyncio.FIRST_COMPLETED)
                    if receiver in done:
                        receiver.result()
                        raise ConnectionResetError('Deepgram connection ended unexpectedly')
                    if keeper in done:
                        keeper.result()
                        raise RuntimeError('Deepgram heartbeat ended unexpectedly')
                    packet = packet_task.result()
                finally:
                    if not packet_task.done():
                        packet_task.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await packet_task
                if packet['type'] == 'websocket.disconnect':
                    return
                if packet.get('text'):
                    message = json.loads(packet['text'])
                    if message.get('type') == 'stop':
                        finished = True
                        await upstream.send(json.dumps({'type': 'CloseStream'}))
                        await asyncio.wait_for(receiver, timeout=15)
                        return
                    if message.get('type') == 'assign' and message.get('role') in ('consultant', 'customer', 'bystander'):
                        label = str(message.get('speakerId', ''))
                        if label.startswith(namespace + ':'):
                            roles[label.split(':', 1)[1]] = message['role']
                    continue
                binary = packet.get('bytes', b'')
                if not binary or len(binary) > 6400 or len(binary) % 2:
                    raise ValueError('Неверный PCM-фрагмент')
                await upstream.send(binary)
        finally:
            finished = True
            for task in [receiver, keeper]:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
