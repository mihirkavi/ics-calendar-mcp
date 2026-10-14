# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-14

### Added

- Read-only MCP tools `list_calendars`, `get_free_busy`, and `find_free_slots` over stateless Streamable HTTP on Cloudflare Workers.
- ICS adapter with recurrence (RRULE, RDATE, EXDATE, modified/cancelled occurrences, RANGE=THISANDFUTURE), all-day and overnight events, transparency, tentative status, IANA and embedded timezones, and DST handling.
- Detail-free busy intervals merged across calendars, with per-calendar coverage and an explicit `complete` flag.
- Timezone-aware free-slot search with working hours, buffers, and weekend control.
- Strict feed fetch policy: HTTPS, exact hostname, no credentials or redirects, 10-second timeout, 5 MiB limit.
- OAuth 2.1 protection with GitHub sign-in, immutable numeric-ID allowlist, consent page, PKCE, dynamic client registration, and `calendar:read` scope.
- Operator-defined calendar registry via the `CALENDAR_REGISTRY` secret.
