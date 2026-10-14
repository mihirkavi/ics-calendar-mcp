# ICS Calendar MCP — Design Specification

**Status:** Revised for authenticated personal deployment  
**Date:** 2026-10-13

## Purpose

ICS Calendar MCP is a public, open-source, read-only Model Context Protocol server for querying availability from private ICS subscription feeds. It gives MCP clients a small, provider-independent interface for listing configured calendars, retrieving privacy-preserving busy intervals, and finding free time without exposing event content.

The first release is a secure, read-only foundation with an authenticated personal deployment. It does not claim general production readiness and does not include CalDAV or calendar writes.

## Goals

- Support one or more administrator-configured ICS calendars.
- Expose `list_calendars`, `get_free_busy`, and `find_free_slots` over MCP.
- Convert events to detail-free busy intervals before they reach the MCP layer.
- Handle ordinary events, all-day events, recurrence, exclusions, modified occurrences, cancellations, transparent events, timezones, daylight-saving transitions, overlaps, and events spanning midnight.
- Report incomplete or stale coverage explicitly instead of treating an unavailable calendar as empty.
- Prevent callers from turning the service into an arbitrary URL fetcher.
- Protect private calendar data with OAuth 2.1 and an explicit identity allowlist.
- Deploy one stable production Worker with seven secret-backed calendar feeds.
- Install the deployed endpoint as a personal ChatGPT plugin and verify every supported ChatGPT surface, including the available iPhone and Voice path.
- Provide a maintainable TypeScript codebase, synthetic test fixtures, automated checks, and honest public documentation.

## Non-goals

- Returning titles, descriptions, attendees, locations, organizers, or raw ICS data.
- Creating, updating, or deleting calendar events.
- CalDAV or iCloud account integration.
- General multi-user account provisioning.
- Persisted event data, audit logs, D1, Durable Objects, queues, or other application state. OAuth protocol state may use Cloudflare KV.
- Publishing private calendar credentials or a preconfigured personal deployment.
- Guaranteeing plugin invocation on a ChatGPT surface that the user's account, workspace, or current product rollout does not support.

## Runtime and transport

The server will be a TypeScript Cloudflare Worker using the official MCP SDK and Streamable HTTP. Local development and tests will use Worker-compatible tooling. The MCP contract and calendar domain logic will remain separated so another runtime could be added later without changing tool behavior.

The deployed service will use one stable production Worker. Cloudflare's Workers OAuth Provider will run in that Worker alongside the MCP resource server and use GitHub as the upstream identity provider. This preserves the one-Worker deployment convention while supporting the OAuth 2.1 discovery, authorization-code, PKCE, token, and protected-resource behavior expected by ChatGPT.

## Public MCP tools

### `list_calendars`

Returns enabled calendar IDs, display names, timezones, and read-only capabilities. It never returns feed URLs, secret names, hostnames, cache keys, or provider response metadata.

### `get_free_busy`

Accepts registered calendar IDs, a bounded ISO 8601 start and end, and an IANA output timezone. It retrieves each selected feed, resolves event occurrence semantics, removes all event details, merges overlapping intervals, and returns:

- Busy intervals containing only start, end, and availability status.
- Per-calendar coverage and freshness timestamps.
- A top-level `complete` flag.

If any required calendar cannot be verified, the response reports incomplete coverage and never represents that source as an empty schedule.

### `find_free_slots`

Accepts the same calendar selection and date range plus a duration, working-hour window, and optional buffer. It calls the same availability pipeline, subtracts merged busy intervals from eligible working periods in the requested timezone, and returns matching free intervals. An incomplete source produces an explicitly incomplete result rather than a confident recommendation.

## Calendar registry

Calendars are defined by administrator-owned configuration, not MCP arguments. Each entry contains:

- Stable ID.
- Public display name.
- Enabled state.
- Default IANA timezone.
- Environment binding name containing the private feed URL.
- Exact allowed hostname.

The checked-in example registry uses synthetic identifiers and placeholder bindings. It contains no subscription URL, credential, personal name, employer name, or private hostname.

The first release may use a typed source configuration rather than a database. Adding a calendar therefore remains an administrator deployment action.

The personal deployment contains seven registry entries with neutral stable IDs and seven distinct secret bindings. Feed display names may be discovered from safe calendar metadata after authentication; when a feed does not provide a usable name, the deployment uses a neutral fallback such as `Calendar 1`. Discovered names must never be committed to the public repository automatically.

`webcal://` subscription links are normalized to `https://` only while placing them into deployment secrets. Runtime fetching continues to require HTTPS and never accepts `webcal://` from MCP callers.

## Authentication and authorization

Every MCP tool requires the `calendar:read` OAuth scope. The Worker publishes protected-resource and authorization-server metadata, supports ChatGPT's OAuth client registration path, and issues short-lived access tokens through the Cloudflare Workers OAuth Provider.

GitHub is the upstream sign-in provider. After GitHub authentication, the authorization handler retrieves the immutable GitHub numeric user ID and compares it to a deployment secret or non-secret deployment variable containing the sole allowed ID. Login-name comparison may be used as a secondary defense and user-facing check, but authorization does not depend on a mutable GitHub username alone.

The authorization flow includes a consent screen, CSRF protection, PKCE, exact redirect validation, and secure cookies. Authentication failures return standards-compliant challenges without revealing calendar configuration. Token verification occurs before MCP tool execution. Tokens, authorization codes, cookies, GitHub profile payloads, and OAuth provider secrets are never logged or returned by tools.

The public repository includes reusable OAuth configuration and synthetic setup instructions. It does not contain the allowed personal GitHub ID, GitHub OAuth client secret, cookie key, KV namespace ID, Worker account details, or calendar URLs.

## Security boundaries

The fetch adapter will:

- Accept only registry-selected feeds.
- Require HTTPS.
- Match the configured hostname exactly.
- Reject embedded URL credentials.
- Reject cross-host redirects; redirects may be disabled entirely if Worker behavior makes strict validation ambiguous.
- Enforce a request timeout.
- Limit response size before parsing.
- Accept only calendar media/content that can be parsed safely.
- Never include URLs or response bodies in thrown errors or logs.

MCP callers cannot provide, override, or discover a feed URL. Logging and error conversion will redact URL query strings, credentials, authorization headers, and calendar content.

Authentication protects the MCP route, but network fetch restrictions remain mandatory. A valid user cannot select an arbitrary URL or access a calendar absent from the deployed registry.

## Calendar processing

The ICS adapter will parse feeds using a Worker-compatible iCalendar library. Recurrence expansion is bounded to the requested query window and a documented maximum range.

The processing order is:

1. Fetch the registered feed under the network policy.
2. Parse the calendar.
3. Expand recurring masters into occurrences within the bounded range.
4. Apply recurrence exclusions and modified or cancelled occurrences.
5. Exclude transparent and cancelled events.
6. Clip accepted occurrences to the query window.
7. Immediately project occurrences into detail-free busy intervals.
8. Merge touching or overlapping intervals.
9. Return intervals plus coverage metadata.

Event content does not enter MCP response models. Internal parsing objects containing content are scoped to the adapter and discarded after projection.

## Time and availability rules

- Inputs must include unambiguous timestamps or a documented timezone.
- Calendar and output timezones use validated IANA names.
- All-day events occupy their calendar-local day boundaries.
- Daylight-saving behavior follows timezone rules rather than fixed UTC offsets.
- Query ranges are capped to prevent unbounded recurrence expansion and resource exhaustion.
- `find_free_slots` validates positive duration and buffer values and only returns intervals contained by the requested working window.

## Caching and freshness

The first implementation may use the Worker Cache API or an injectable in-memory cache for tests. Cached entries have a short, configurable lifetime and record retrieval time. Tool results expose freshness state and timestamps, but no cache key or source identifier.

Expired cache data may be reported as stale if the source is temporarily unavailable. It must not be reported as fresh. The README will document the exact stale-data policy implemented by the code.

## Errors

The server uses stable machine-readable codes:

- `invalid_request`
- `calendar_not_found`
- `permission_denied`
- `calendar_unavailable`
- `calendar_stale`
- `provider_error`
- `internal_error`

Provider failures are converted at the adapter boundary. Public errors contain actionable but non-sensitive messages. Individual source failures appear in coverage metadata when a multi-calendar availability request can otherwise return partial data.

## Source organization

```text
src/
  index.ts
  auth/
    github.ts
    handler.ts
    policy.ts
  mcp/
    server.ts
    schemas.ts
    tools.ts
  calendars/
    registry.ts
    types.ts
    adapters/ics.ts
    availability.ts
    slots.ts
  security/
    fetch-policy.ts
    redaction.ts
tests/
  fixtures/
  unit/
  integration/
```

Modules will expose narrow interfaces so ICS fetching, occurrence processing, availability merging, slot calculation, and MCP transport can be tested independently.

## Verification

Automated verification will include:

- Type checking and linting.
- Unit tests for interval merging and free-slot calculation.
- Synthetic ICS fixtures covering ordinary and all-day events, recurrence, exclusions, modified occurrences, cancellations, transparency, DST, overlaps, and events spanning midnight.
- Fetch-policy tests for HTTP URLs, unknown hosts, cross-host redirects, timeouts, and oversized responses.
- Privacy tests proving MCP results and public errors omit fixture titles, descriptions, attendees, locations, and source URLs.
- OAuth tests for protected-resource metadata, unauthenticated challenges, scope enforcement, immutable GitHub-ID allowlisting, CSRF rejection, token verification, and redaction.
- MCP integration tests for tool discovery, schema validation, valid queries, unknown calendar IDs, and incomplete coverage.
- GitHub Actions running the same checks on pushes and pull requests.

No automated test will contact a real calendar provider, GitHub, ChatGPT, or require a private credential. Live deployment verification is a separate, explicit release step.

## Public repository requirements

The repository will include:

- A plain-language README covering purpose, implemented behavior, setup, security model, limitations, and roadmap.
- MIT license.
- Contribution guide.
- Security policy that directs vulnerability reports away from public issues.
- Changelog.
- Example configuration and environment variable documentation containing synthetic values only.
- Relevant GitHub description and topics.

The README will label the release as an early read-only foundation and will not describe planned CalDAV or write capabilities as implemented. It will distinguish the reusable public source from one operator's private secret-backed deployment.

## Private deployment and ChatGPT installation

Deployment uses the stable Worker name `ics-calendar-mcp`; no version-specific or redundant sandbox Worker is retained after verification. OAuth KV, GitHub OAuth credentials, cookie encryption material, the allowed GitHub numeric ID, and all seven feed URLs are configured outside Git.

The live verification sequence is:

1. Confirm Cloudflare account and Worker inventory without modifying unrelated Workers.
2. Provision or reuse the one OAuth KV namespace required by the production Worker.
3. Create or configure a GitHub OAuth application with the exact deployed callback URL.
4. Set OAuth and calendar secrets without echoing them to command output.
5. Deploy the Worker and verify OAuth discovery, rejection of unauthenticated MCP calls, successful authorized tool discovery, and all three tools.
6. Create and install a personal ChatGPT plugin pointed at the authenticated `/mcp` endpoint.
7. Run realistic read-only prompts in ChatGPT Work on the web and desktop.
8. Check whether the installed plugin is available in the user's iPhone ChatGPT experience and whether Voice can invoke it under the user's current plan, workspace settings, connected-host state, and product rollout.

OpenAI's documented custom-MCP workflow establishes personal plugin installation and invocation in ChatGPT Work on the web. Mobile and Voice verification is therefore an acceptance test, not a promised platform capability. If direct Voice invocation is unavailable, the release notes must state the exact observed limitation and the best tested fallback, such as voice dictation into a Work chat or Voice through a supported connected desktop host.

Calendar subscription URLs are bearer credentials. Because the initial URLs were shared in a chat transcript, the operator should regenerate the published links after initial end-to-end validation, replace the seven Worker secrets, verify the new links, and invalidate the original published links before considering the personal deployment hardened.

## Release boundary

The initial public repository is complete when the code passes its automated checks, contains no secret or identifying data, can be run locally with a synthetic ICS fixture or user-supplied secrets, and its live GitHub visibility, license, description, and topics have been verified.

The personal rollout is complete when the single production Worker is authenticated and deployed, all seven feeds return safe availability results, the personal ChatGPT plugin is installed and verified on supported web/desktop surfaces, the iPhone/Voice capability has been tested and documented honestly, and the initially shared calendar links have been replaced or their residual exposure has been explicitly accepted by the operator.
