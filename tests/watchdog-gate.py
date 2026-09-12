import runpy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock

m = runpy.run_path('build/watchdog-candidate.py')
gate = m['nodo_lifecycle_gate']
g = gate.__globals__
g['HOME'] = Path('/tmp/nodo-watchdog-fixture')
profile = g['HOME'] / 'Library/Application Support/NODO'
g['DSH_HOME'] = profile / 'dsh'
g['log'] = Mock()
g['write_json'] = Mock()
g['RESTART'] = Path('/tmp/nodo-watchdog-fixture/stable-launcher')
def configure(marker, instance):
    g['read_json'] = lambda p, default=None: marker if p.name == 'intentional-stop.json' else ({} if p.name == 'watchdog-last-launch.json' else instance)
configure({'intentional': True, 'reason': 'user'}, {})
with patch('subprocess.run') as run, patch('subprocess.Popen') as launch:
    assert gate() is False
    run.assert_not_called()
    launch.assert_not_called()
configure({}, {'pid': 123})
with patch('subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=str(g['HOME'] / 'Applications/NODO.app/Contents/MacOS/NODO'))) as run:
    assert gate() is True
configure({}, {})
g['port_listening'] = lambda: False
with patch('subprocess.Popen') as launch:
    assert gate() is False
    launch.assert_called_once()
configure({}, {'dshSocket': str(profile / 'tmp/test/dsh.sock')})
g['port_listening'] = Mock(side_effect=[True, False, False])
responses = iter([
    {'result': {'protocol': 1, 'activeTurns': 0}},
    {'result': {'pid': 456}},
    {'result': {'activeTurns': 0, 'services': [{'drained': True}]}}
])
conn = Mock()
conn.getresponse.side_effect = lambda: SimpleNamespace(read=lambda: json.dumps(next(responses)).encode())
exe = str(g['HOME'] / 'Applications/NODO.app/Contents/Resources/project/runtime/node')
with patch('http.client.HTTPConnection', return_value=conn), patch('socket.socket'), patch('subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=exe)), patch('subprocess.Popen') as launch, patch('os.kill') as kill:
    assert gate() is False
    kill.assert_called_once_with(456, 15)
    assert [c.args[2] for c in conn.request.call_args_list] == [json.dumps({'method': x, 'params': {}}) for x in ['lifecycle.status', 'health', 'lifecycle.pause']]
    launch.assert_called_once()
g['port_listening'] = lambda: True
conn = Mock()
conn.getresponse.return_value.read.return_value = json.dumps({'result': {'protocol': 1, 'activeTurns': 1}}).encode()
with patch('http.client.HTTPConnection', return_value=conn), patch('socket.socket'), patch('subprocess.Popen') as launch, patch('os.kill') as kill:
    assert gate() is False
    kill.assert_not_called()
    launch.assert_not_called()
for failed in [{'error': 'drain failed'}, {'result': {'activeTurns': 0, 'services': [{'drained': False}]}}]:
    responses = iter([{'result': {'protocol': 1, 'activeTurns': 0}}, {'result': {'pid': 456}}, failed, {'result': {'paused': False}}])
    conn = Mock()
    conn.getresponse.side_effect = lambda: SimpleNamespace(read=lambda: json.dumps(next(responses)).encode())
    with patch('http.client.HTTPConnection', return_value=conn), patch('socket.socket'), patch('subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=exe)), patch('subprocess.Popen') as launch, patch('os.kill') as kill:
        assert gate() is False
        assert json.loads(conn.request.call_args_list[-1].args[2])['method'] == 'lifecycle.resume'
        kill.assert_not_called()
        launch.assert_not_called()
g['read_json'] = lambda p, default=None: {'at': g['time'].time()} if p.name == 'watchdog-last-launch.json' else {}
with patch('subprocess.Popen') as launch:
    assert gate() is False
    launch.assert_not_called()
print('PASS intentional stop, exact orphan drain-before-SIGTERM, busy untouched, failed-drain resume, restart cooldown')
