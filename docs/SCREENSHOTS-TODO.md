# Screenshots to capture

No interface screenshots are published yet. The repository only contains brand assets
(`assets/`), so the README intentionally shows no images rather than placeholders or mocked-up
screens.

Once real screenshots exist, add them to `docs/images/` and place a row of 2-4 of them in the README
directly under the intro sentence.

## Required shots

| # | File | What it must show | Notes |
| --- | --- | --- | --- |
| 1 | `docs/images/workspace.png` | Main window: agent conversation with a real task in progress, project tree/sidebar, header with model and status | The primary product shot; this is the one people judge the app by |
| 2 | `docs/images/smart-context.png` | Context panel: mode (`Economy` / `Balanced` / `Full`), tokens sent, cache hit, cost meter | Direct visual support for the measured-efficiency section |
| 3 | `docs/images/updates.png` | Settings -> Updates: current/latest version, channel, update state, "What's new" | Shows the signed update path; must not show a personal channel or host |
| 4 | `docs/images/browser.png` | Embedded browser with the agent driving a page, and the security boundary visible | Use a neutral public page |
| 5 | `docs/images/remote.png` (optional) | Phone view paired over encrypted Remote | No personal chats, names, tokens or QR codes |

## Rules for capturing

- Real UI only. No mockups, no re-created windows, no AI-generated images.
- Neutral content: use a demo project ("NODO Workspace"), not a real client, employer or personal
  project. No chat content that identifies anyone.
- Hide or clear: API keys, account names, e-mail addresses, absolute personal paths, chat ids,
  session titles, Telegram content, QR codes, relay host names.
- Capture at a consistent size (for example 1600x1000, PNG, 2x Retina) with the same theme for all
  shots; dark theme matches the brand mark. macOS window shadows are fine.
- Keep each file under roughly 500 KB; crop browser chrome and desktop background away.
- Alt text in the README must describe the feature, not the picture ("Smart Context panel with
  economy mode and the cost meter").
