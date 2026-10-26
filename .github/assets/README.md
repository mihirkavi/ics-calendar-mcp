# README images

Images used by the root `README.md`.

| File | What it is | How it was made |
| --- | --- | --- |
| `banner-light.png`, `banner-dark.png` | Title banner for light and dark mode | Rendered from an HTML template with headless Chromium |
| `terminal.png` | Terminal card: the synthetic test calendar (`tests/fixtures/comprehensive.ics`) and the real `get_free_busy` output for it | Output captured from an MCP client calling the Worker inside the Vitest Workers runtime, then rendered as a card; the JSON is abridged |

Notes for agents: screenshots and terminal cards must show only synthetic fixtures or public data. Never use a real calendar, feed URL, account ID or token. Keep file names stable because the README links to them.
