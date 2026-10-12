"""Private employee voice profiles, independent of conversation recording retention."""
import base64
import hashlib
import json
import math
import os
import tempfile
from pathlib import Path
from datetime import datetime, timezone

MODEL = 'pyannote/wespeaker-voxceleb-resnet34-LM'

class ProfileStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def path(self, identity):
        if not identity or len(identity) > 200:
            raise ValueError('Неверный профиль')
        return self.directory / (hashlib.sha256(identity.encode()).hexdigest() + '.json')

    def load(self, identity):
        path = self.path(identity)
        if not path.exists():
            return None
        data = json.loads(path.read_text())
        vector = data.get('vector', [])
        if data.get('model') != MODEL or not 1 <= len(vector) <= 4096 or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in vector):
            raise ValueError('Профиль голоса повреждён. Перезапишите образец.')
        return data

    def save(self, identity, vector, pcm):
        if len(pcm) > 16000 * 2 * 30:
            raise ValueError('Образец слишком длинный')
        target = self.path(identity)
        data = {'model': MODEL, 'vector': list(vector), 'pcm': base64.b64encode(pcm).decode(), 'savedAt': datetime.now(timezone.utc).isoformat()}
        fd, temporary = tempfile.mkstemp(dir=self.directory)
        try:
            with os.fdopen(fd, 'w') as file:
                json.dump(data, file)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return data

    def delete(self, identity):
        self.path(identity).unlink(missing_ok=True)
