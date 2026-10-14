# ICS Calendar MCP

**Let an AI assistant check when you're free, without showing it what's on your calendar.**

ICS Calendar MCP is a small, read-only [Model Context Protocol](https://modelcontextprotocol.io) server. It reads one or more private ICS subscription feeds (for example, published iCloud or Google calendars) and answers two questions: *when am I busy?* and *when am I free?* Event titles, notes, attendees, locations, and the feed URLs themselves never leave the server. The assistant only ever sees time ranges.

It runs as a single Cloudflare Worker, protected by OAuth 2.1 with GitHub sign-in and a one-account allowlist, so you can connect it to ChatGPT, Claude, or any MCP client that supports remote servers with OAuth.

> **Status: v0.1, an early read-only foundation.** It works end to end, but it hasn't been battle-tested across many calendar providers. See [Limitations](#limitations).

## What it does

Three MCP tools, all read-only:

| Tool | What it returns |
| --- | --- |
| `list_calendars` | Configured calendar IDs, display names, and timezones, plus the current time. Never feed URLs or secrets. |
| `get_free_busy` | Merged busy intervals (`start`, `end`, `busy`/`tentative`) across the selected calendars for a range of up to 93 days, with per-calendar coverage. |
| `find_free_slots` | Free windows of at least N minutes inside daily working hours (default 09:00–17:00 on weekdays), with an optional buffer around meetings. |

Example `get_free_busy` result (abridged):

```json
{
  "timezone": "America/Los_Angeles",
  "busy": [
    { "start": "2026-10-14T09:00:00-07:00", "end": "2026-10-14T10:30:00-07:00", "status": "busy", "calendarIds": ["work", "family"] }
  ],
  "coverage": [
    { "calendarId": "work", "status": "fresh", "fetchedAt": "2026-10-14T05:00:00.000Z" },
    { "calendarId": "family", "status": "fresh", "fetchedAt": "2026-10-14T05:00:00.000Z" }
  ],
  "complete": true
}
```

If any calendar can't be read, its coverage is `unavailable` and `complete` is `false`. The server never treats an unreadable calendar as an empty one.

### Calendar handling

- Timed, all-day, multi-day, and overnight events
- Recurrence (`RRULE`, `RDATE`, `EXDATE`), modified and cancelled occurrences, and `RANGE=THISANDFUTURE`
- `STATUS:CANCELLED` and `TRANSP:TRANSPARENT` events are skipped. `STATUS:TENTATIVE` events are reported as `tentative`.
- IANA timezones, embedded `VTIMEZONE` definitions, floating times (interpreted in the calendar's default timezone), and DST transitions
- Overlapping events from any number of calendars are merged

## Security and privacy model

- **No event content.** The ICS adapter reads only start, end, duration, recurrence, status, and transparency. It projects each occurrence into a bare time interval before anything else sees it. Tests confirm that titles, descriptions, locations, organizers, attendees, UIDs, and raw ICS never appear in tool output or errors.
- **Callers can't choose URLs.** Feeds come only from an operator-defined registry and Worker secrets. Each fetch requires HTTPS and an exact hostname match. It rejects embedded credentials, custom ports, and redirects, times out after 10 seconds, and stops reading past 5 MiB.
- **Bounded work.** Query ranges are capped at 93 days and recurrence expansion at 10,000 occurrences per calendar per request.
- **Authenticated access.** Every MCP request needs an OAuth access token with the `calendar:read` scope. Tokens are issued only after GitHub sign-in, and only to the GitHub account whose immutable numeric ID matches `ALLOWED_GITHUB_USER_ID`. A username is never enough. The MCP handler re-checks that ID and the scope on every request.
- **Safe OAuth flow.** It uses PKCE (S256), exact redirect-URI validation, and a consent page that can't be framed and is bound to the browser with cookies (CSRF protection). The GitHub `state` is single-use and browser-bound, and the GitHub access token is discarded after the identity check. OAuth state lives in Cloudflare KV, with tokens stored only as hashes.
- **Redacted errors.** Public errors carry a stable code and a generic message. URLs, query strings, credentials, and calendar text are scrubbed.

Calendar subscription URLs are bearer secrets: anyone with the link can read the full calendar. Keep them in Worker secrets, and regenerate them in your calendar app if they're ever exposed.

## Architecture

```
MCP client ──OAuth 2.1──▶ Cloudflare Worker
                           ├─ OAuth provider (/authorize, /token, /register, discovery)
                           │    └─ GitHub sign-in + numeric-ID allowlist
                           └─ /mcp (stateless Streamable HTTP)
                                └─ CalendarService
                                     ├─ registry (IDs → secret bindings)
                                     ├─ fetch policy (HTTPS, exact host, limits)
                                     ├─ ICS adapter (ICAL.js → detail-free intervals)
                                     └─ interval merge + free-slot search
```

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Worker entry: OAuth provider wiring and the protected `/mcp` handler |
| `src/auth/` | Consent page, GitHub sign-in, numeric-ID allowlist |
| `src/mcp/` | Tool schemas, registration, and text summaries |
| `src/calendars/` | Registry, service, ICS adapter, interval math, timezone helpers |
| `src/security/` | Feed fetch policy and error redaction |

The server keeps no event data. Each request fetches the feeds live.

## Requirements

- Node.js 22 or newer (24 recommended; see `.nvmrc`)
- A Cloudflare account (the Workers free plan is enough to try it)
- A GitHub account and a GitHub OAuth App for sign-in

## Local development

```bash
npm install
npm run check   # TypeScript
npm run lint    # ESLint
npm test        # Vitest inside the Workers runtime (Miniflare); no network access
```

To run the Worker locally, copy `.dev.vars.example` to `.dev.vars`, fill in your values, and run `npm run dev`. The OAuth consent cookies use the `__Host-` prefix, which needs HTTPS. Use `wrangler dev --local-protocol https` or test the full sign-in flow against a deployed Worker.

## Configuring calendars

Without configuration, the server uses one synthetic example calendar (`example-calendar`, read from the `CALENDAR_EXAMPLE_ICS_URL` secret, host `calendar.example.com`). To use your own calendars, set the `CALENDAR_REGISTRY` secret to a JSON array:

```json
[
  {
    "id": "work",
    "name": "Work",
    "enabled": true,
    "timezone": "America/New_York",
    "secretBinding": "CALENDAR_1_ICS_URL",
    "allowedHostname": "calendar.example.com"
  }
]
```

- `id`: lowercase letters, digits, and hyphens. This is what MCP clients pass as `calendarIds`.
- `timezone`: an IANA zone, used for all-day and floating events and as the default output zone.
- `secretBinding`: the name of a separate Worker secret that holds the feed URL.
- `allowedHostname`: the exact host the feed URL must use.

Feed URLs must be `https://`. If your calendar app gives you a `webcal://` link, replace `webcal` with `https` when you store it.

## Deploying to Cloudflare

1. Create a KV namespace for OAuth state:

   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```

   Put its ID in `wrangler.jsonc`. If you don't want the ID in Git, copy the file to `wrangler.local.jsonc` (ignored by Git), edit the copy, and pass `-c wrangler.local.jsonc` to the Wrangler commands below. `npm run deploy:local` does this for you.

2. Create a [GitHub OAuth App](https://github.com/settings/developers). Set the homepage URL to your Worker origin and the authorization callback URL to `https://<your-worker-host>/callback`.
3. Set the secrets (each command prompts for the value):

   ```bash
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put ALLOWED_GITHUB_USER_ID   # numeric: gh api user --jq .id
   npx wrangler secret put CALENDAR_REGISTRY        # JSON array, see above
   npx wrangler secret put CALENDAR_1_ICS_URL       # one per registry entry
   ```

4. Deploy:

   ```bash
   npm run deploy
   ```

   Each `secret put` asks for its value interactively, so secrets never land in your shell history or in files.

The MCP endpoint is `https://<your-worker-host>/mcp`. OAuth discovery is published at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`, and clients can register dynamically at `/register`.

## Connecting a client

- **ChatGPT:** add a custom MCP server (connector) with the `/mcp` URL and OAuth authentication, then sign in with GitHub when prompted. Availability of custom connectors, and of connectors in mobile and Voice modes, depends on your ChatGPT plan, workspace settings, and OpenAI's current rollout.
- **MCP Inspector:** run `npx @modelcontextprotocol/inspector`, choose Streamable HTTP, enter the `/mcp` URL, and complete the OAuth flow.
- **Other clients:** any client that supports remote Streamable HTTP servers with OAuth 2.1 discovery and dynamic client registration should work.

Example prompts: "What does my calendar look like tomorrow?", "Find me a free hour on Thursday afternoon", "Am I free Friday between 2 and 4?"

## Limitations

- Read-only. There's no way to create, edit, or delete events, and no CalDAV.
- One allowed GitHub account per deployment. Multi-user access isn't supported.
- Feeds are fetched live on every request. A slow or offline provider makes that calendar `unavailable` (reported, never silently empty). There's no cache.
- ICS feeds published by calendar apps can lag behind the app by several minutes, depending on the provider.
- Working-hour windows can't cross midnight, and `find_free_slots` returns at most 100 windows.
- A series that generates more than 10,000 occurrences between its start and the end of the query (such as a minute-level rule) makes that calendar `unavailable` for the request.
- Timezone names without a matching `VTIMEZONE` must be IANA names. Windows-style names such as `Pacific Standard Time` are only understood when the feed includes their definition.

## Roadmap

These are ideas, not commitments, and none of them are implemented:

- Optional short-lived caching with explicit `stale` coverage
- Per-calendar working hours
- CalDAV as an alternative source

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[MIT](LICENSE) © 2026 Mihir Kavishwar
