# README images

Images used by the root `README.md`.

| File | What it is | How it was made |
| --- | --- | --- |
| `banner-light.png`, `banner-dark.png` | Title banner for light and dark mode | Rendered with headless Chromium from `source/banner.html` (one file with a dark-mode media query) |
| `terminal.png` | Terminal card: the synthetic test calendar (`tests/fixtures/comprehensive.ics`) and the real `get_free_busy` output for it | Output captured from an MCP client calling the Worker inside the Vitest Workers runtime, then rendered as a card; the JSON is abridged |

## Visual identity

Clean, system-calendar look taken from the server's own OAuth consent page (`src/auth/consent.ts`), which uses Apple-style system colours. Calendar apps (Fantastical, Cal.com) and Model Context Protocol docs use the same quiet neutral palette with one blue accent.

- **Fonts:** Inter Tight (headline), Inter (text), JetBrains Mono (ICS and tool names). All from Google Fonts.
- **Colours:** `#f5f5f7` / `#000000` background, `#1d1d1f` / `#f5f5f7` ink, `#6e6e73` / `#a1a1a6` secondary, accent `#0a66c2` (light) / `#4ea1ff` (dark).
- **Motif:** a work-week grid with anonymous `busy` and hatched `tentative` blocks, and struck-through `SUMMARY`, `LOCATION`, `ATTENDEE` fields. The blocks are illustrative, not a real calendar.
- **README:** badges use `0a66c2`, `1d1d1f` and `6e6e73`; no emoji in headings.

To re-render after editing `source/banner.html` (needs Node.js with Playwright and a Chromium build):

```bash
node render-html.mjs .github/assets/source/banner.html .github/assets/banner-light.png --scheme light
node render-html.mjs .github/assets/source/banner.html .github/assets/banner-dark.png --scheme dark
```

`render-html.mjs` is a small Playwright script, not part of this repository: it opens the file at 1600x600, sets `prefers-color-scheme`, waits for fonts and saves a 2x screenshot. Any headless browser screenshot at that size works the same way.

Notes for agents: screenshots and terminal cards must show only synthetic fixtures or public data. Never use a real calendar, feed URL, account ID or token. Keep file names stable because the README links to them.
