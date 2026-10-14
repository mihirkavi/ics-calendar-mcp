# Deployment and client verification

This record covers one operator's private deployment. It contains no calendar names that reveal private context, feed URLs, account IDs, tokens, or event details.

## 2026-10-14: authenticated MCP client (passed)

Verified against the production Worker with a standalone MCP client (`@modelcontextprotocol/client` 2.3.1) that went through the real OAuth flow: dynamic client registration, consent, GitHub sign-in, PKCE, and token exchange.

| Check | Result |
| --- | --- |
| Protected-resource and authorization-server metadata | Published; `scopes_supported: ["calendar:read"]` |
| Unauthenticated `POST /mcp` | `401` with `WWW-Authenticate: Bearer … resource_metadata=…, scope="calendar:read"` |
| Invalid bearer token | `401` |
| GitHub sign-in as the allowed account | Token issued with scope `calendar:read` |
| Tool discovery | Exactly `list_calendars`, `get_free_busy`, `find_free_slots` |
| `list_calendars` | 7 calendars, IDs and names only |
| `get_free_busy` across all 7 feeds (1-day and 24-day windows) | Every source `fresh`, `complete: true`, merged intervals only, 120–250 ms |
| `find_free_slots` (3 days, 60 min) | Correct working-hour windows, `complete: true` |
| Unknown calendar ID | Tool error `unknown_calendar`, nothing else revealed |
| Event content or feed URLs in any response | None observed |

Partial-coverage behavior (one feed failing yields `complete: false` and `unavailable`, never an empty schedule) is covered by automated tests rather than by breaking a live feed.

## ChatGPT (pending operator verification)

| Surface | Status |
| --- | --- |
| ChatGPT on the web: add custom MCP connector, OAuth, tool calls | Not yet verified |
| ChatGPT desktop app | Not yet verified |
| ChatGPT on iPhone (text) | Not yet verified |
| ChatGPT Voice on iPhone | Not yet verified |

Availability of custom connectors, and of connectors in mobile and Voice modes, depends on the ChatGPT plan, workspace settings, and OpenAI's current rollout. This table will record observed behavior only.

## Hardening follow-up

The calendar subscription links were shared in a chat transcript during setup. Until they are regenerated in the calendar app and the Worker secrets are replaced, anyone holding the original links could read those calendars directly.
