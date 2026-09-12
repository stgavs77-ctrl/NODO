#!/usr/bin/env python3
"""Сторож потока входящих NODO Workspace (DSH-мост Telegram).

Проверяет раз в минуту, что входящие от клиентов реально доезжают:

- мост жив: пульс состояния моста не старше heartbeat_stale секунд;
- входящее не застряло: старое недоставленное в очереди моста;
- ничего не потеряно молча: карантин моста пуст;
- приём работает: heartbeat приёмника свежий, ошибок подряд нет, процесс есть;
- мост не отстал: смещение приёмника и курсор моста не разъехались.

Только чтение: файлы состояния, список процессов. Читает лишь то, что доступно
фоновой задаче без прав на Documents (журнал читает сам мост и он же сообщает о
сбоях чтения тревогой). Ничего не меняет и ничего не отправляет, пока в
watch-config.json не включено {"telegram": true, "chat": <id>}.

Запуск: /usr/bin/python3 watch.py   (LaunchAgent com.local.dsh-bridge-watch)
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
PLUGIN = HOME / '.dsh' / 'plugins' / 'telegram-bridge'
APP_ROOT = HOME / 'Library' / 'Application Support' / 'nodo-optionalOrderInbox'
DEFAULTS = {
    'state': PLUGIN / 'state.json',
    'sender': PLUGIN / 'send_message.py',
    'config': PLUGIN / 'watch-config.json',
    'out': PLUGIN / 'watch.json',
    'alerts': PLUGIN / 'watch-alerts.jsonl',
    'receiver_health': APP_ROOT / 'receiver-health.json',
    'receiver_offset': APP_ROOT / 'offset.txt',
    'receiver_err': APP_ROOT / 'receiver.err',
    'python': '/usr/bin/python3',
    'heartbeat_stale': 180,
    'pending_old': 600,
    'receiver_error_recent': 300,
    'receiver_failures_alert': 3,
    'receiver_stale_success': 300,
    'offset_drift': 50,
}


def error_age(now, health, marker_age):
    """Возраст текущей ошибки: из health.error_since, иначе по маркеру."""
    since = health.get('error_since')
    try:
        return now - float(since)
    except (TypeError, ValueError):
        return marker_age


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def read_text(path, default=''):
    try:
        return Path(path).read_text(encoding='utf-8').strip()
    except OSError:
        return default


def processes():
    try:
        result = subprocess.run(['ps', '-axo', 'command'], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return ''
    return result.stdout


def age(now, stamp):
    """Возраст метки в секундах. Пульс моста пишется в миллисекундах, приёмника - в секундах."""
    try:
        value = float(stamp)
    except (TypeError, ValueError):
        return None
    if value > 1e11:
        value = value / 1000.0
    return int(now - value) if value > 0 else None


def collect(options, now=None):
    now = time.time() if now is None else now
    state = read_json(options['state'], {}) or {}
    pending = state.get('pending') or []
    quarantine = state.get('quarantine') or []
    cursor = state.get('cursor') or 0
    ages = [max(0, int(now - float(item.get('at') or now))) for item in pending]
    oldest_pending = max(ages) if ages else 0

    health = read_json(options['receiver_health'], {}) or {}
    receiver_heartbeat = age(now, health.get('heartbeat_at') or health.get('last_successful_poll_at'))
    offset_text = read_text(options['receiver_offset'])
    try:
        offset = int(offset_text)
    except ValueError:
        offset = None

    listing = processes()
    receiver_running = 'telegram_core.legacy_receiver' in listing
    harness_running = 'dsh web' in listing
    receiver_err_age = age(now, Path(options['receiver_err']).stat().st_mtime
                           if Path(options['receiver_err']).exists() else 0)
    no_success = age(now, health.get('last_successful_poll_at'))

    alerts = []
    bridge_heartbeat = age(now, state.get('at'))
    if bridge_heartbeat is None or bridge_heartbeat > options['heartbeat_stale']:
        alerts.append({'kind': 'bridge-stalled', 'age_seconds': bridge_heartbeat,
                       'harness_running': harness_running})
    if not receiver_running:
        alerts.append({'kind': 'receiver-down', 'health_pid': health.get('pid')})
    if receiver_heartbeat is None or receiver_heartbeat > options['heartbeat_stale']:
        alerts.append({'kind': 'receiver-stalled', 'age_seconds': receiver_heartbeat,
                       'last_error': str(health.get('last_error') or '')[:200]})
    elif no_success is not None and no_success > options.get('receiver_stale_success',
                                                             DEFAULTS['receiver_stale_success']):
        # Считаем проблемой не сам факт сбоев (интернет на этом маке рвётся и приёмник
        # переживает это сам), а отсутствие успешных опросов: если Telegram не отвечает
        # дольше пяти минут, сообщения копятся - вот это тревога.
        alerts.append({'kind': 'receiver-no-success', 'failures': health.get('consecutive_failures'),
                       'last_error': str(health.get('last_error') or '')[:200],
                       'no_success_seconds': no_success})
    if receiver_err_age is not None and receiver_err_age < options['receiver_error_recent']:
        alerts.append({'kind': 'receiver-restarting', 'age_seconds': receiver_err_age})
    if oldest_pending > options['pending_old']:
        alerts.append({'kind': 'undelivered', 'count': len(pending), 'oldest_seconds': oldest_pending,
                       'update_id': pending[0].get('update_id'), 'chat_id': pending[0].get('chat_id')})
    if quarantine:
        alerts.append({'kind': 'quarantined', 'count': len(quarantine),
                       'update_id': quarantine[-1].get('update_id'), 'chat_id': quarantine[-1].get('chat_id')})
    if offset is not None and cursor and offset - cursor > options['offset_drift']:
        alerts.append({'kind': 'bridge-behind', 'offset': offset, 'cursor': cursor, 'diff': offset - cursor})

    return {
        'at': int(now),
        'ok': not alerts,
        'cursor': cursor,
        'bridge_heartbeat_age_seconds': bridge_heartbeat,
        'pending': len(pending),
        'oldest_pending_seconds': oldest_pending,
        'quarantine': len(quarantine),
        'delivered': state.get('delivered') or 0,
        'failed': state.get('failed') or 0,
        'receiver_offset': offset,
        'receiver_heartbeat_age_seconds': receiver_heartbeat,
        'receiver_failures': int(health.get('consecutive_failures') or 0),
        'receiver_last_error': str(health.get('last_error') or '')[:200],
        'receiver_running': receiver_running,
        'receiver_err_age_seconds': receiver_err_age,
        'harness_running': harness_running,
        'alerts': alerts,
    }


def ping(options, alerts):
    """Служебное сообщение владельцу. По умолчанию выключено."""
    config = read_json(options['config'], {}) or {}
    if config.get('telegram') is not True:
        return None
    chat = int(config.get('chat') or 784290345)
    lines = [item['kind'] + ': ' + json.dumps({k: v for k, v in item.items() if k != 'kind'}, ensure_ascii=False)
             for item in alerts]
    text = 'Сторож NODO Workspace: ' + '; '.join(lines)
    env = dict(os.environ)
    env.setdefault('HOME', str(HOME))
    env.setdefault('LANG', 'en_US.UTF-8')
    try:
        result = subprocess.run([options['python'], str(options['sender']), '--chat', str(chat), '--text', text],
                                capture_output=True, text=True, env=env)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        return {'ok': False, 'error': f'{type(error).__name__}: {error}'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', default=str(DEFAULTS['state']))
    parser.add_argument('--sender', default=str(DEFAULTS['sender']))
    parser.add_argument('--config', default=str(DEFAULTS['config']))
    parser.add_argument('--out', default=str(DEFAULTS['out']))
    parser.add_argument('--alerts', default=str(DEFAULTS['alerts']))
    parser.add_argument('--receiver-health', default=str(DEFAULTS['receiver_health']))
    parser.add_argument('--receiver-offset', default=str(DEFAULTS['receiver_offset']))
    parser.add_argument('--receiver-err', default=str(DEFAULTS['receiver_err']))
    parser.add_argument('--heartbeat-stale', type=int, default=DEFAULTS['heartbeat_stale'])
    parser.add_argument('--pending-old', type=int, default=DEFAULTS['pending_old'])
    parser.add_argument('--receiver-error-recent', type=int, default=DEFAULTS['receiver_error_recent'])
    parser.add_argument('--offset-drift', type=int, default=DEFAULTS['offset_drift'])
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args()
    options = {
        'state': Path(args.state), 'sender': Path(args.sender), 'config': Path(args.config),
        'out': Path(args.out), 'alerts': Path(args.alerts),
        'receiver_health': Path(args.receiver_health), 'receiver_offset': Path(args.receiver_offset),
        'receiver_err': Path(args.receiver_err), 'python': DEFAULTS['python'],
        'heartbeat_stale': args.heartbeat_stale, 'pending_old': args.pending_old,
        'receiver_error_recent': args.receiver_error_recent, 'offset_drift': args.offset_drift,
    }

    status = collect(options)
    previous = read_json(options['out'], {}) or {}
    kinds = sorted(item['kind'] for item in status['alerts'])
    previous_kinds = sorted(item['kind'] for item in (previous.get('alerts') or []))
    changed = kinds != previous_kinds

    # Пинг только на смену состояния, чтобы тревога не превратилась в спам.
    if changed and status['alerts']:
        status['ping'] = ping(options, status['alerts'])

    options['out'].parent.mkdir(parents=True, exist_ok=True)
    options['out'].write_text(json.dumps(status, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    if changed:
        with options['alerts'].open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(status, ensure_ascii=False) + '\n')
    if not args.quiet:
        print(json.dumps(status, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
