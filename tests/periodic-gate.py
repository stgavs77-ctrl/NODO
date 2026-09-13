import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location('gate', Path(__file__).resolve().parents[1] / 'services/periodic-gate.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class GateTests(unittest.TestCase):
    def test_drain_and_resume(self):
        with tempfile.TemporaryDirectory(prefix='nodo-gate-') as folder:
            root = Path(folder)
            started, release = threading.Event(), threading.Event()
            writes = []

            def work():
                started.set()
                if not release.wait(5):
                    raise RuntimeError('test timeout')
                writes.append('send completed')

            job = threading.Thread(target=lambda: gate.invoke(root, work, lambda: writes.append('fsync')))
            job.start()
            self.assertTrue(started.wait(5))
            with self.assertRaises(BlockingIOError):
                gate.pause(root, 'transaction-1')
            self.assertFalse((root / 'ack.json').exists())
            release.set()
            job.join(5)
            self.assertFalse(job.is_alive())
            self.assertTrue(gate.pause(root, 'transaction-1'))
            self.assertEqual(writes, ['send completed', 'fsync'])
            self.assertFalse(gate.invoke(root, lambda: writes.append('unexpected'), lambda: None))
            with self.assertRaises(RuntimeError):
                gate.resume(root, 'foreign')
            gate.resume(root, 'transaction-1')
            self.assertTrue(gate.invoke(root, lambda: writes.append('resumed'), lambda: None))

    def test_legacy_and_failed_flush_rejected(self):
        with tempfile.TemporaryDirectory(prefix='nodo-gate-') as folder:
            root = Path(folder)
            with self.assertRaisesRegex(RuntimeError, 'LEGACY'):
                gate.pause(root, 'x')

            def failed():
                raise OSError('synthetic disk failure')

            with self.assertRaises(OSError):
                gate.invoke(root, lambda: None, failed)
            with self.assertRaisesRegex(RuntimeError, 'FLUSH_UNCONFIRMED'):
                gate.pause(root, 'x')
            self.assertFalse((root / 'ack.json').exists())


if __name__ == '__main__':
    unittest.main()
