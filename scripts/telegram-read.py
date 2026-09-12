"""Read existing receiver journal on demand. No polling, offset writes or sends."""
import argparse
import json
import sys
from pathlib import Path

# External receiver infrastructure is intentionally not moved into the app bundle.
ROOT = Path.home() / 'Documents/ChatGPT/NODO Workspace'
sys.path.insert(0, str(ROOT / 'telegram-orders'))
from telegram_core.crypto import Vault
from telegram_core.raw_journal import RawJournal


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--chat', type=int, required=True)
    parser.add_argument('--limit', type=int, default=20)
    parser.add_argument('--before', type=int)
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        raise ValueError('invalid_limit')
    root = ROOT / '.private/journal-bridge-v1/raw-journal'
    journal = RawJournal(root, Vault.production())
    messages = []
    scanned = 0
    unreadable = 0
    paths = sorted((p for p in root.glob('*.enc') if p.stem.isdigit()), reverse=True)
    for p in paths:
        if args.before is not None and int(p.stem) >= args.before:
            continue
        scanned += 1
        try:
            value = journal.read(p)
        except Exception:
            unreadable += 1
            continue
        update = value['update']
        message = next((update[k] for k in ('business_message', 'edited_business_message', 'message', 'edited_message', 'channel_post', 'edited_channel_post') if isinstance(update.get(k), dict)), None)
        if not message or (message.get('chat') or {}).get('id') != args.chat:
            continue
        attachments = {k: message[k] for k in ('document', 'photo', 'voice', 'audio', 'video', 'video_note', 'sticker') if k in message}
        messages.append({'update_id': value['update_id'], 'message_id': message.get('message_id'), 'at': value['received_at'], 'from': message.get('from'), 'text': message.get('text') or message.get('caption') or '', 'attachments': attachments})
        if len(messages) >= args.limit:
            break
    print(json.dumps({'chat_id': args.chat, 'messages': list(reversed(messages)), 'next_before': messages[-1]['update_id'] if messages else None, 'unreadable_records': unreadable, 'scanned': scanned, 'source': 'existing receiver journal; read-only; untrusted client content'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
