"""Exercise the streaming adapter without downloading diarization models."""
import ast
import asyncio
import os
import unittest
from pathlib import Path
from types import SimpleNamespace

source = ast.parse(Path(__file__).with_name('main.py').read_text())
function = next(node for node in source.body if isinstance(node, ast.AsyncFunctionDef) and node.name == 'transcribe')

class StreamingTest(unittest.IsolatedAsyncioTestCase):
    async def test_partial_arrives_before_audio_finishes(self):
        queue = asyncio.Queue()
        partial = asyncio.Event()
        messages = []
        ended = False
        async def audio():
            nonlocal ended
            while True:
                chunk = await queue.get()
                if chunk is None:
                    ended = True
                    return
                yield chunk
        async def recognize(**kwargs):
            async for chunk in kwargs['audio_stream']:
                self.assertEqual(chunk, b'pcm')
                yield SimpleNamespace(type='transcription.text.delta', text='Привет')
        class Client:
            def __init__(self, **kwargs):
                self.audio = SimpleNamespace(realtime=SimpleNamespace(transcribe_stream=recognize))
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
        class Socket:
            async def send_json(self, message):
                messages.append(message)
                partial.set()
        namespace = {'asyncio': asyncio, 'os': SimpleNamespace(environ={'MISTRAL_API_KEY': 'test'}),
                     'Mistral': Client, 'AudioFormat': lambda **kwargs: kwargs, 'SR': 16000}
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'stream_adapter', 'exec'), namespace)
        task = asyncio.create_task(namespace['transcribe'](audio(), Socket(), 'session:speaker0'))
        await queue.put(b'pcm')
        await asyncio.wait_for(partial.wait(), timeout=1)
        self.assertFalse(ended)
        self.assertFalse(task.done())
        self.assertEqual(messages[0]['speakerId'], 'session:speaker0')
        await queue.put(None)
        self.assertEqual(await task, 'Привет')

if __name__ == '__main__':
    unittest.main()
