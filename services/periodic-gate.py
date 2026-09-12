"""Cooperative admission/drain for one pinned synchronous bridge-watch invocation.

No signal-based shutdown. An exclusive lock spans all work and fsync. A pause
marker prevents the next invocation; the installer waits for that same lock.
Legacy processes do not implement this protocol and MUST NOT be acknowledged.
"""
import fcntl
import json
import os
from pathlib import Path


def durable(path, value):
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fd = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def invoke(root, work, flush):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / 'work.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (root / 'pause.json').exists():
            return False
        durable(root / 'status.json', {'protocol': 1, 'pid': os.getpid(), 'state': 'working'})
        # Failure leaves status non-quiescent. No cancelled send becomes success.
        work()
        flush()
        durable(root / 'status.json', {'protocol': 1, 'pid': os.getpid(), 'state': 'flushed'})
        return True


def pause(root, nonce):
    root = Path(root)
    if not (root / 'status.json').exists():
        raise RuntimeError('LEGACY_WATCH_DRAIN_UNSUPPORTED')
    marker = root / 'pause.json'
    if marker.exists() and json.loads(marker.read_text()).get('nonce') != nonce:
        raise RuntimeError('Pause transaction mismatch')
    durable(root / 'pause.json', {'nonce': nonce})
    with (root / 'work.lock').open('a') as lock:
        # Caller polls; never holds a blocked installer indefinitely.
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        status = json.loads((root / 'status.json').read_text())
        if status.get('protocol') != 1 or status.get('state') != 'flushed':
            raise RuntimeError('WATCH_FLUSH_UNCONFIRMED')
        durable(root / 'ack.json', {'nonce': nonce, 'protocol': 1, 'drained': True})
        return True


def resume(root, nonce):
    marker = Path(root) / 'pause.json'
    if marker.exists():
        if json.loads(marker.read_text()).get('nonce') != nonce:
            raise RuntimeError('Pause transaction mismatch')
        marker.unlink()
