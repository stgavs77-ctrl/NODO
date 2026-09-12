"""Installed launchd entry, preserving existing watch config and persistent paths."""
import importlib.util
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if __name__ == '__main__':
    gate = load('gate', 'periodic-gate.py')
    root = Path.home() / 'Library/Application Support/NODO/maintenance/bridge-watch'
    mode = sys.argv[1] if len(sys.argv) > 1 else 'run'
    if mode == 'pause':
        gate.pause(root, sys.argv[2])
    elif mode == 'resume':
        gate.resume(root, sys.argv[2])
    elif mode == 'run':
        watch = load('watch', 'bridge-watch-source.py')
        sys.argv = [str(HERE / 'bridge-watch-source.py'), '--quiet']

        def flush():
            for name in ['watch.json', 'watch-alerts.jsonl', 'send-ledger.jsonl']:
                file = watch.PLUGIN / name
                if name == 'watch.json' or file.exists():
                    with file.open('rb') as stream:
                        os.fsync(stream.fileno())

        gate.invoke(root, watch.main, flush)
    else:
        raise RuntimeError('Unsupported bridge-watch lifecycle action')
