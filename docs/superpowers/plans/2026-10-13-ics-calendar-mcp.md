# ICS Calendar MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a public, read-only Cloudflare Worker MCP server that turns administrator-configured ICS feeds into privacy-preserving busy intervals and free-slot suggestions.

**Architecture:** A stateless MCP handler delegates to an availability service. The service resolves calendar IDs through a static registry, fetches only registered HTTPS feeds through a strict network policy, expands ICS occurrences, projects them immediately into detail-free intervals, and computes merged busy time or free slots. Transport, orchestration, ICS parsing, network security, and interval math stay independently testable.

**Tech Stack:** TypeScript 7, Cloudflare Workers, `agents` 0.28, `@modelcontextprotocol/server` 2.3, Zod 4, ICAL.js 2.2, Vitest 5, Cloudflare Vitest Pool Workers, Wrangler 4, ESLint 10, npm, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-13-ics-calendar-mcp-design.md`

## Global Constraints

- V1 is read-only: no CalDAV, create, update, delete, invitations, or write-capable provider interface.
- MCP exposes exactly `list_calendars`, `get_free_busy`, and `find_free_slots`.
- Never return or log event titles, descriptions, attendees, locations, organizers, raw ICS, feed URLs, secret binding names, or provider response bodies.
- Calendar URLs come only from administrator registry entries and Worker secret bindings, never caller input.
- Fetches require HTTPS, exact hostname matching, no embedded credentials, no redirects, a 10-second timeout, and a 5 MiB response limit.
- Query windows are half-open `[start, end)`, must be positive, and may span at most 93 days.
- Recurrence expansion is capped at 10,000 generated occurrences per calendar per request.
- Timestamps are RFC 3339 strings; timezones are IANA names validated with `Intl.DateTimeFormat`.
- Tests use synthetic fixtures and never contact real providers or require credentials.
- Successful live fetches report `fresh`; unavailable calendars make the aggregate response incomplete. V0.1 has no stale cache and never reports unavailable data as empty.
- Public documentation and GitHub metadata must describe only implemented behavior and contain no personal or employer identifiers.

## Review Focus

- A recurrence that begins years before the query must remain bounded and return only in-range occurrences; Task 4 tests both old series and the 10,000-occurrence cap.
- A modified recurrence moved into or out of the query window must replace, not duplicate, the original; Task 4 tests both directions.
- A multi-calendar request with one failed feed must return partial intervals with `complete: false`, never an apparently empty source; Task 5 pins this behavior.
- Hostname tricks (`userinfo@host`, suffix domains, redirects, and mixed case) must not bypass the fetch policy; Task 3 tests each input class.
- DST gaps, repeated hours, and overnight working windows can corrupt slot calculations; Tasks 2 and 4 test DST boundaries and Task 2 explicitly rejects overnight working windows in V0.1.

---

### Task 1: Project foundation, domain types, and registry validation

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `vitest.config.ts`
- Create: `wrangler.jsonc`
- Create: `.gitignore`
- Create: `.dev.vars.example`
- Create: `src/calendars/types.ts`
- Create: `src/calendars/registry.ts`
- Create: `src/errors.ts`
- Test: `tests/unit/registry.test.ts`

**Interfaces:**
- Produces: `CalendarDefinition`, `CalendarBindings`, `BusyInterval`, `Coverage`, `AvailabilityResult`, and `CalendarError` domain types.
- Produces: `getCalendar(id: string): CalendarDefinition | undefined`, `listEnabledCalendars(): CalendarDefinition[]`, and `resolveCalendarUrl(definition: CalendarDefinition, env: CalendarBindings): URL`.
- Calendar registry entry fields are `id`, `name`, `enabled`, `timezone`, `secretBinding`, and `allowedHostname`.

- [ ] **Step 1: Add the failing registry tests**

  Test that `listEnabledCalendars()` excludes disabled entries; `getCalendar()` resolves a known synthetic ID; `resolveCalendarUrl()` rejects missing bindings, non-HTTPS URLs, embedded credentials, and hostnames other than the entry's exact case-insensitive hostname; and returned public calendar data never includes `secretBinding` or `allowedHostname`.

- [ ] **Step 2: Run the registry test and confirm failure**

  Run: `npm test -- tests/unit/registry.test.ts`

  Expected: FAIL because project configuration and registry modules do not exist.

- [ ] **Step 3: Scaffold the TypeScript Worker project and install pinned major dependencies**

  Create scripts `check`, `lint`, `test`, `test:watch`, and `dev`. Use ESM, strict TypeScript, `moduleResolution: "Bundler"`, Worker types, and the current lockfile-resolved versions within the major versions named in the plan header. Configure Wrangler with `src/index.ts`, compatibility date `2026-10-13`, and no checked-in secret values.

- [ ] **Step 4: Implement domain types, typed errors, and registry functions**

  `resolveCalendarUrl()` reads `env[definition.secretBinding]`, parses it once, validates the URL, and throws `CalendarError` with a public code and redacted message. Keep the example calendar synthetic (`example-calendar`, `Example Calendar`, `CALENDAR_EXAMPLE_ICS_URL`, `calendar.example.com`).

- [ ] **Step 5: Run foundation checks**

  Run: `npm run check && npm run lint && npm test -- tests/unit/registry.test.ts`

  Expected: all commands exit 0.

- [ ] **Step 6: Commit the foundation**

  ```bash
  git add package.json package-lock.json tsconfig.json eslint.config.js vitest.config.ts wrangler.jsonc .gitignore .dev.vars.example src tests/unit/registry.test.ts
  git commit -m "chore: scaffold ICS Calendar MCP"
  ```

### Task 2: Interval normalization and free-slot calculation

**Files:**
- Create: `src/calendars/availability.ts`
- Create: `src/calendars/slots.ts`
- Test: `tests/unit/availability.test.ts`
- Test: `tests/unit/slots.test.ts`

**Interfaces:**
- Consumes: `BusyInterval` from Task 1.
- Produces: `mergeBusyIntervals(intervals: BusyInterval[]): BusyInterval[]`.
- Produces: `clipInterval(interval: BusyInterval, rangeStart: Date, rangeEnd: Date): BusyInterval | undefined`.
- Produces: `findFreeSlots(input: FindSlotsInput, busy: BusyInterval[]): FreeSlot[]`, where `FindSlotsInput` has `start`, `end`, `timezone`, `durationMinutes`, `bufferMinutes`, and `{ start: "HH:mm", end: "HH:mm" }` working hours.

- [ ] **Step 1: Add failing interval tests**

  Test sorting, overlap merging, touching-interval merging, clipping, zero-length exclusion, source-calendar ID union, and non-mutation of inputs.

- [ ] **Step 2: Add failing slot tests**

  Test a 60-minute slot between two meetings, a 15-minute buffer on both sides, multi-day working windows, a DST spring-forward day, a repeated-hour fall-back day, invalid timezone, non-positive duration, range over 93 days, and explicit rejection of overnight working hours (`end <= start`).

- [ ] **Step 3: Run both suites and confirm failure**

  Run: `npm test -- tests/unit/availability.test.ts tests/unit/slots.test.ts`

  Expected: FAIL because the interval modules do not exist.

- [ ] **Step 4: Implement interval merging and clipping**

  Normalize comparisons using epoch milliseconds while preserving RFC 3339 output. Merge status with precedence `busy > tentative > free` and deduplicate sorted source calendar IDs.

- [ ] **Step 5: Implement timezone-aware free-slot calculation**

  Build local-day boundaries with `Intl`-based offset resolution, intersect them with `[start, end)`, apply buffers to busy intervals, and emit only slots at least `durationMinutes` long. V0.1 rejects overnight working windows instead of splitting them implicitly.

- [ ] **Step 6: Run interval tests and static checks**

  Run: `npm run check && npm test -- tests/unit/availability.test.ts tests/unit/slots.test.ts`

  Expected: all commands exit 0.

- [ ] **Step 7: Commit the scheduling engine**

  ```bash
  git add src/calendars/availability.ts src/calendars/slots.ts tests/unit/availability.test.ts tests/unit/slots.test.ts
  git commit -m "feat: add availability calculations"
  ```

### Task 3: Restricted calendar fetching and redaction

**Files:**
- Create: `src/security/fetch-policy.ts`
- Create: `src/security/redaction.ts`
- Test: `tests/unit/fetch-policy.test.ts`
- Test: `tests/unit/redaction.test.ts`

**Interfaces:**
- Consumes: a URL already resolved by Task 1.
- Produces: `fetchCalendar(url: URL, allowedHostname: string, fetchImpl?: typeof fetch): Promise<FetchedCalendar>` with `{ body: string; fetchedAt: string }`.
- Produces: `redactError(error: unknown): { code: CalendarErrorCode; message: string }`.

- [ ] **Step 1: Add failing fetch-policy tests**

  Use mocked `fetch` to test HTTPS success, HTTP rejection, userinfo rejection, exact hostname matching with mixed-case normalization, suffix-domain rejection, `redirect: "error"`, 10-second abort behavior, non-2xx responses, missing body, declared oversize via `Content-Length`, streamed body crossing 5 MiB, and response errors that contain a secret URL.

- [ ] **Step 2: Add failing redaction tests**

  Verify public errors remove URL query strings, `Authorization` header values, usernames/passwords, and synthetic ICS content while preserving stable error codes.

- [ ] **Step 3: Run security tests and confirm failure**

  Run: `npm test -- tests/unit/fetch-policy.test.ts tests/unit/redaction.test.ts`

  Expected: FAIL because the security modules do not exist.

- [ ] **Step 4: Implement bounded streaming fetches**

  Validate again at the network boundary, call `fetch` with `redirect: "error"` and an abort signal, stream bytes through a 5 MiB counter, decode UTF-8 only after the bound passes, and expose no response body in thrown errors.

- [ ] **Step 5: Implement error redaction**

  Map known `CalendarError` instances without leaking their causes. Map unknown failures to `internal_error` with a generic message; do not stringify arbitrary objects into public output.

- [ ] **Step 6: Run security tests and static checks**

  Run: `npm run check && npm test -- tests/unit/fetch-policy.test.ts tests/unit/redaction.test.ts`

  Expected: all commands exit 0.

- [ ] **Step 7: Commit fetch protections**

  ```bash
  git add src/security tests/unit/fetch-policy.test.ts tests/unit/redaction.test.ts
  git commit -m "feat: restrict ICS feed fetching"
  ```

### Task 4: ICS occurrence expansion and privacy projection

**Files:**
- Create: `src/calendars/adapters/ics.ts`
- Create: `tests/fixtures/comprehensive.ics`
- Create: `tests/fixtures/dst.ics`
- Create: `tests/fixtures/malformed.ics`
- Test: `tests/unit/ics.test.ts`

**Interfaces:**
- Consumes: raw ICS string, calendar ID, default timezone, and `[rangeStart, rangeEnd)`.
- Produces: `parseBusyIntervals(input: ParseIcsInput): BusyInterval[]`.
- `ParseIcsInput` fields are `ics`, `calendarId`, `defaultTimezone`, `rangeStart`, `rangeEnd`, and optional `occurrenceLimit` defaulting to 10,000.

- [ ] **Step 1: Create synthetic fixtures and failing ordinary-event tests**

  Cover timed events, all-day events, events spanning midnight, overlapping events, `TRANSP:TRANSPARENT`, `STATUS:CANCELLED`, tentative status, and range clipping. Give every fixture event a conspicuous synthetic title, description, location, organizer, and attendee so privacy assertions can search for them.

- [ ] **Step 2: Add failing recurrence tests**

  Cover daily and weekly rules, RDATE, EXDATE, a single modified recurrence, a cancelled recurrence exception, `RANGE=THISANDFUTURE`, a modified occurrence moved into the query, one moved out, a series beginning years before the query, and the 10,000-occurrence cap.

- [ ] **Step 3: Add failing timezone and privacy tests**

  Cover embedded `VTIMEZONE`, DST spring-forward and fall-back transitions, unknown timezone failure, malformed ICS failure, and assertions that serialized output contains none of the fixture content fields or raw ICS text.

- [ ] **Step 4: Run the ICS suite and confirm failure**

  Run: `npm test -- tests/unit/ics.test.ts`

  Expected: FAIL because the adapter does not exist.

- [ ] **Step 5: Implement VEVENT grouping and exception linkage**

  Parse with ICAL.js, group VEVENTs by UID, select recurrence masters, and relate recurrence exceptions using `ICAL.Event.relateException`. Reject exception-only malformed series safely.

- [ ] **Step 6: Implement bounded occurrence expansion**

  Use `event.iterator()` plus `event.getOccurrenceDetails()` so RRULE/RDATE/EXDATE and linked exceptions resolve through ICAL.js. Count every generated candidate toward the cap, stop once future starts cannot overlap the range, and separately process non-recurring events.

- [ ] **Step 7: Project directly to busy intervals**

  Inspect only status and transparency before projecting occurrence start/end to `BusyInterval`. Do not copy content fields into intermediate domain models or errors.

- [ ] **Step 8: Run parser tests and static checks**

  Run: `npm run check && npm test -- tests/unit/ics.test.ts`

  Expected: all commands exit 0.

- [ ] **Step 9: Commit the read-only ICS adapter**

  ```bash
  git add src/calendars/adapters/ics.ts tests/fixtures tests/unit/ics.test.ts
  git commit -m "feat: parse ICS feeds into busy intervals"
  ```

### Task 5: Availability service and partial-coverage behavior

**Files:**
- Create: `src/calendars/service.ts`
- Test: `tests/unit/service.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 functions through injectable `CalendarServiceDependencies` (`registry`, `fetchCalendar`, `parseBusyIntervals`, and `now`).
- Produces: `createCalendarService(env: CalendarBindings, deps?: Partial<CalendarServiceDependencies>): CalendarService`.
- `CalendarService` provides `listCalendars()`, `getFreeBusy(input: FreeBusyInput): Promise<AvailabilityResult>`, and `findFreeSlots(input: FindSlotsRequest): Promise<FreeSlotsResult>`.

- [ ] **Step 1: Add failing service tests**

  Test calendar listing, unknown IDs, duplicate IDs, defaulting to all enabled calendars, URL resolution, merged cross-calendar intervals, deterministic freshness timestamps, and propagation of range/timezone validation.

- [ ] **Step 2: Add failing partial-coverage tests**

  With one successful calendar and one rejected fetch, assert returned successful intervals remain, failed coverage is `unavailable`, `complete` is `false`, and free-slot output is also marked incomplete. With every calendar failed, assert an incomplete structured result rather than an empty complete schedule.

- [ ] **Step 3: Run service tests and confirm failure**

  Run: `npm test -- tests/unit/service.test.ts`

  Expected: FAIL because the service does not exist.

- [ ] **Step 4: Implement orchestration and coverage**

  Resolve and process calendars independently with `Promise.allSettled`, merge only successful intervals, and create one coverage record per requested calendar. Successful live results use `fresh`; failed sources use `unavailable`. Preserve input calendar order in coverage output.

- [ ] **Step 5: Implement slot orchestration**

  Reuse `getFreeBusy()` and Task 2's pure slot function. Return slots, identical coverage, and identical `complete` status; never upgrade an incomplete availability result to complete.

- [ ] **Step 6: Run service tests and full checks**

  Run: `npm run check && npm test -- tests/unit/service.test.ts`

  Expected: all commands exit 0.

- [ ] **Step 7: Commit the availability service**

  ```bash
  git add src/calendars/service.ts tests/unit/service.test.ts
  git commit -m "feat: aggregate calendar availability"
  ```

### Task 6: MCP schemas, tools, and Cloudflare Worker endpoint

**Files:**
- Create: `src/mcp/schemas.ts`
- Create: `src/mcp/tools.ts`
- Create: `src/mcp/server.ts`
- Create: `src/index.ts`
- Test: `tests/integration/mcp.test.ts`

**Interfaces:**
- Consumes: `CalendarService` from Task 5.
- Produces: Zod schemas `freeBusyInputSchema` and `findFreeSlotsInputSchema`.
- Produces: `createServer(service: CalendarService): McpServer` registering exactly three tools.
- Produces: default Worker export with `fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>` mounting stateless Streamable HTTP at `/mcp`.

- [ ] **Step 1: Add failing MCP integration tests**

  Drive the handler in-process with the official MCP client. Assert initialization, exact tool discovery, public schemas, `list_calendars`, `get_free_busy`, `find_free_slots`, unknown calendar handling, invalid timestamps, invalid timezone, 93-day limit, and a 404 outside `/mcp`.

- [ ] **Step 2: Add MCP privacy tests**

  Invoke every tool against the comprehensive fixture and assert serialized results and errors contain no fixture title, description, attendee, organizer, location, feed URL, secret binding, or allowed hostname.

- [ ] **Step 3: Run integration tests and confirm failure**

  Run: `npm test -- tests/integration/mcp.test.ts`

  Expected: FAIL because MCP modules and Worker entry point do not exist.

- [ ] **Step 4: Implement strict Zod request schemas**

  Reject unknown object keys. Transform no dates inside schemas; validate strings and let the service own temporal semantics so HTTP and direct tests share behavior.

- [ ] **Step 5: Register the three MCP tools**

  Use `McpServer` from `@modelcontextprotocol/server`. Return a human-readable text content block plus `structuredContent` for successful results. Convert failures through `redactError()` and mark tool results as errors without embedding causes.

- [ ] **Step 6: Mount the stateless Worker handler**

  Use `createMcpHandler` from `agents/mcp/server`, creating a fresh server for each request with the request's Worker environment captured by the object-style Worker `fetch()` method. Configure exact route `/mcp`, no wildcard browser origins, and generic out-of-band error logging.

- [ ] **Step 7: Run integration and full test suites**

  Run: `npm run check && npm run lint && npm test`

  Expected: all commands exit 0.

- [ ] **Step 8: Commit the MCP endpoint**

  ```bash
  git add src/mcp src/index.ts tests/integration/mcp.test.ts
  git commit -m "feat: expose read-only calendar MCP tools"
  ```

### Task 7: Public documentation, contribution policy, and CI

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `CHANGELOG.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Test: `tests/meta/public-repository.test.ts`

**Interfaces:**
- Consumes: the implemented scripts, configuration, and limitations from Tasks 1–6.
- Produces: contributor-facing setup and security documentation that exactly matches v0.1 behavior.

- [ ] **Step 1: Add failing repository-hygiene tests**

  Assert required files exist; example configuration uses only synthetic values; README documents all three and only three tools; public runtime, example, fixture, and top-level documentation files contain no employer-specific identifiers; and tracked files contain no common credential patterns or real-looking subscription URLs with secret query tokens.

- [ ] **Step 2: Run hygiene tests and confirm failure**

  Run: `npm test -- tests/meta/public-repository.test.ts`

  Expected: FAIL because public repository files do not exist.

- [ ] **Step 3: Write the public README and policies**

  Document purpose, architecture, requirements, local setup, registry customization, Worker secret setup, MCP Inspector usage, tool examples, threat model, privacy guarantees, unsupported behavior, deployment authentication warning, limitations, roadmap, contribution workflow, and vulnerability reporting. State that the endpoint has no authentication in v0.1 and must not be exposed publicly without an access layer.

- [ ] **Step 4: Add MIT license and project governance files**

  Use year 2026 and copyright holder `Mihir Kavishwar`. Keep the changelog at `0.1.0 - Unreleased` until publication verification passes.

- [ ] **Step 5: Add CI and dependency updates**

  GitHub Actions checks out code, installs with `npm ci`, then runs `npm run check`, `npm run lint`, and `npm test` on Node 20 and 22. Dependabot checks npm and GitHub Actions weekly.

- [ ] **Step 6: Run all local quality gates**

  Run: `npm ci && npm run check && npm run lint && npm test && git diff --check`

  Expected: all commands exit 0 with no skipped tests.

- [ ] **Step 7: Commit public repository materials**

  ```bash
  git add README.md LICENSE CONTRIBUTING.md SECURITY.md CHANGELOG.md CODE_OF_CONDUCT.md .github tests/meta/public-repository.test.ts
  git commit -m "docs: prepare public open source repository"
  ```

### Task 8: Security review, public GitHub publication, and live metadata verification

**Files:**
- Modify: `CHANGELOG.md`
- Create: no additional product files expected

**Interfaces:**
- Consumes: complete local repository from Tasks 1–7.
- Produces: public GitHub repository `mihirkavi/ics-calendar-mcp` with verified visibility, license, description, topics, default branch, and passing CI.

- [ ] **Step 1: Run pre-publication secret and history review**

  Run tracked-file scans for private identifiers, credential formats, URLs with query strings, `.dev.vars`, `.env`, calendar bodies, and unexpected binary files. Inspect `git log --stat`, `git status --short`, and `git diff main` so every object about to be pushed is intentional.

- [ ] **Step 2: Run the clean-install verification**

  Run: `npm ci && npm run check && npm run lint && npm test && npx wrangler deploy --dry-run --outdir .wrangler/dry-run`

  Expected: all commands exit 0; dry-run output remains ignored inside the repository.

- [ ] **Step 3: Update the changelog for v0.1.0 and commit**

  Change `0.1.0 - Unreleased` to `0.1.0 - 2026-10-13`, then run the full quality gate once more and commit as `chore: prepare v0.1.0`.

- [ ] **Step 4: Create and push the public GitHub repository**

  Run `gh repo create mihirkavi/ics-calendar-mcp --public --source=. --remote=origin --push --description "Privacy-first, read-only MCP server for ICS calendar availability and free-slot discovery"`. Do not configure a homepage because no public project page exists.

- [ ] **Step 5: Set topics and verify live metadata**

  Set topics `mcp`, `model-context-protocol`, `icalendar`, `ics`, `calendar`, `cloudflare-workers`, `typescript`, and `privacy`. Query the live repository with `gh repo view --json nameWithOwner,visibility,description,homepageUrl,licenseInfo,repositoryTopics,defaultBranchRef,url` and confirm public visibility, MIT license, empty homepage, `main` default branch, description, and all topics.

- [ ] **Step 6: Verify remote CI and repository contents**

  Use `gh run list --limit 1` and `gh run watch` for the pushed workflow. Confirm the run succeeds and inspect the public tree to ensure `.dev.vars`, private fixtures, credentials, build output, and local-only files are absent.

- [ ] **Step 7: Tag the verified release**

  Create annotated tag `v0.1.0` at the verified commit and push it. Re-run `gh repo view` after the tag to ensure repository metadata remains correct.

