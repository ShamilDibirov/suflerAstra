import asyncio
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

client = types.ModuleType('websockets.asyncio.client')
client.connect = None
with patch.dict(sys.modules, {'websockets': types.ModuleType('websockets'), 'websockets.asyncio': types.ModuleType('websockets.asyncio'), 'websockets.asyncio.client': client}):
    spec = importlib.util.spec_from_file_location('speech_deepgram', Path(__file__).with_name('deepgram_stream.py'))
    gateway = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gateway)

class DeepgramTest(unittest.IsolatedAsyncioTestCase):
    async def test_continuous_stream_has_interim_speaker_profile_and_graceful_stop(self):
        await self.run_stream(.95)

    async def test_unrecognized_voice_is_not_assumed_to_be_a_customer(self):
        await self.run_stream(.1)

    async def run_stream(self, score):
        received, sends, count = asyncio.Queue(), [], 0
        packets = asyncio.Queue()
        for _ in range(10):
            packets.put_nowait({'type': 'websocket.receive', 'bytes': bytes(6400)})
        events = []
        class Socket:
            async def receive(self): return await packets.get()
            async def send_json(self, value):
                events.append(value)
                if value['type'] == 'segment':
                    packets.put_nowait({'type': 'websocket.receive', 'text': '{"type":"stop"}'})
        class Upstream:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def send(self, value):
                nonlocal count
                sends.append(value)
                if isinstance(value, bytes):
                    count += 1
                    if count == 10:
                        await received.put(json.dumps({'type': 'Results', 'is_final': False, 'channel': {'alternatives': [{'transcript': 'Здравствуйте'}]}}))
                        await received.put(json.dumps({'type': 'Results', 'is_final': True, 'speech_final': False, 'channel': {'alternatives': [{'words': [{'word': 'Здравствуйте', 'start': 0, 'end': 1, 'speaker': 7, 'confidence': .99}]}]}}))
                        await received.put(json.dumps({'type': 'Results', 'is_final': True, 'speech_final': True, 'channel': {'alternatives': [{'words': [{'word': 'помогу', 'start': 1, 'end': 2, 'speaker': 7, 'confidence': .99}]}]}}))
                elif json.loads(value)['type'] == 'CloseStream':
                    await received.put(None)
            def __aiter__(self): return self
            async def __anext__(self):
                value = await received.get()
                if value is None: raise StopAsyncIteration
                return value
        connection = []
        def connect(url, **kwargs):
            connection.append((url, kwargs))
            return Upstream()
        async def identify(audio, reference):
            self.assertEqual(len(audio), 64000)
            return score
        with patch.object(gateway, 'connect', connect), patch.dict('os.environ', {'DEEPGRAM_API_KEY': 'test-key'}):
            await asyncio.wait_for(gateway.listen(Socket(), [1.0], identify), timeout=1)
        self.assertIn('diarize=true', connection[0][0])
        self.assertIn('language=ru', connection[0][0])
        self.assertEqual(connection[0][1]['additional_headers']['Authorization'], 'Token test-key')
        self.assertTrue(any(e['type'] == 'partial' and e['text'] for e in events))
        self.assertEqual(next(e for e in events if e['type'] == 'segment')['role'], 'consultant' if score >= .65 else 'unknown')
        self.assertEqual(sum(e['type'] == 'segment' for e in events), 1)
        self.assertEqual(sum(isinstance(v, bytes) for v in sends), 10)
        self.assertEqual(json.loads(sends[-1])['type'], 'CloseStream')

    def test_groups_preserve_speakers_and_missing_labels_are_not_guessed(self):
        words = [{'word': 'a', 'start': 0, 'end': 1, 'speaker': 0}, {'word': 'b', 'start': 1, 'end': 2, 'speaker': 1}, {'word': 'c', 'start': 2, 'end': 3}]
        result = gateway.groups(words)
        self.assertEqual([g['speaker'] for g in result[:2]], ['0', '1'])
        self.assertTrue(result[2]['speaker'].startswith('unassigned'))
