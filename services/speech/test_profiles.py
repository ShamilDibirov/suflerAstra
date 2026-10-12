import tempfile
import unittest
from pathlib import Path
from profile_store import ProfileStore

class ProfileTest(unittest.TestCase):
    def test_sample_and_embedding_survive_restart_and_are_user_scoped(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ProfileStore(directory)
            saved = store.save('org-a:user-a', [1.0, 0.0], bytes(32000))
            restarted = ProfileStore(directory)
            self.assertEqual(restarted.load('org-a:user-a'), saved)
            self.assertIsNone(restarted.load('org-b:user-a'))
            self.assertEqual(restarted.path('org-a:user-a').stat().st_mode & 0o777, 0o600)
            restarted.delete('org-a:user-a')
            self.assertIsNone(store.load('org-a:user-a'))
    def test_identity_never_becomes_a_filesystem_path(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ProfileStore(directory)
            store.save('../../outside', [1.0], b'pcm')
            self.assertEqual(store.path('../../outside').parent, Path(directory))
