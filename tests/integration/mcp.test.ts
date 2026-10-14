import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseBusyIntervals } from "../../src/calendars/adapters/ics";
import { CalendarRegistry } from "../../src/calendars/registry";
import { CalendarError } from "../../src/errors";
import { comprehensive, SECRET_MARKERS } from "../fixtures";
import { ORIGIN, call, makeWorker, obtainToken, type Worker } from "./helpers";

const registry = new CalendarRegistry([
  { id: "primary", name: "Primary", enabled: true, timezone: "America/New_York", secretBinding: "CALENDAR_EXAMPLE_ICS_URL", allowedHostname: "calendar.example.com" },
  { id: "broken", name: "Broken", enabled: true, timezone: "America/New_York", secretBinding: "CALENDAR_EXAMPLE_ICS_URL", allowedHostname: "calendar.example.com" },
]);

const FORBIDDEN = [...SECRET_MARKERS, "CALENDAR_EXAMPLE_ICS_URL", "calendar.example.com", "/feeds/example.ics"];

let worker: Worker;
let client: Client;
let calls = 0;

async function connect(): Promise<Client> {
  const token = await obtainToken(worker);
  const mcpClient = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (input, init) => call(worker, new Request(input, init)),
  });
  await mcpClient.connect(transport);
  return mcpClient;
}

beforeAll(async () => {
  const fetchCalendar = vi.fn(async () => {
    calls += 1;
    // Every second fetch fails so the "broken" calendar is unavailable when both are queried.
    if (calls % 2 === 0) throw new CalendarError("feed_unavailable");
    return { body: comprehensive, fetchedAt: "2026-10-14T00:00:00.000Z" };
  });
  ({ worker } = makeWorker({ calendar: { registry, fetchCalendar, parseBusyIntervals } }));
  client = await connect();
});

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return JSON.stringify(result);
}

describe("MCP endpoint", () => {
  it("exposes exactly three read-only tools with public schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["find_free_slots", "get_free_busy", "list_calendars"]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.inputSchema.type).toBe("object");
    }
    const freeBusy = tools.find((tool) => tool.name === "get_free_busy")!;
    expect(Object.keys(freeBusy.inputSchema.properties ?? {}).sort()).toEqual(["calendarIds", "end", "start", "timezone"]);
  });

  it("lists calendars without secrets", async () => {
    const result = await client.callTool({ name: "list_calendars", arguments: {} });
    const structured = result.structuredContent as { calendars: { id: string }[]; currentTime: string };
    expect(structured.calendars.map((calendar) => calendar.id)).toEqual(["primary", "broken"]);
    expect(structured.currentTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const marker of FORBIDDEN) expect(text(result)).not.toContain(marker);
  });

  it("returns merged busy intervals for one calendar", async () => {
    calls = 0;
    const result = await client.callTool({
      name: "get_free_busy",
      arguments: { calendarIds: ["primary"], start: "2026-10-14", end: "2026-10-15", timezone: "UTC" },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { busy: { start: string; end: string; status: string }[]; complete: boolean };
    expect(structured.complete).toBe(true);
    expect(structured.busy).toEqual([
      { start: "2026-10-14T07:00:00Z", end: "2026-10-14T07:15:00Z", status: "busy", calendarIds: ["primary"] },
      { start: "2026-10-14T16:00:00Z", end: "2026-10-14T17:30:00Z", status: "busy", calendarIds: ["primary"] },
      { start: "2026-10-14T20:00:00Z", end: "2026-10-14T20:30:00Z", status: "tentative", calendarIds: ["primary"] },
    ]);
    for (const marker of FORBIDDEN) expect(text(result)).not.toContain(marker);
  });

  it("reports incomplete coverage when a calendar fails", async () => {
    calls = 0;
    const result = await client.callTool({ name: "get_free_busy", arguments: { start: "2026-10-14", end: "2026-10-15", timezone: "UTC" } });
    const structured = result.structuredContent as { complete: boolean; coverage: { status: string }[]; busy: unknown[] };
    expect(structured.complete).toBe(false);
    expect(structured.coverage.map((entry) => entry.status)).toEqual(["fresh", "unavailable"]);
    expect(structured.busy.length).toBeGreaterThan(0);
    expect(text(result)).toContain("incomplete");
  });

  it("finds free slots", async () => {
    calls = 0;
    const result = await client.callTool({
      name: "find_free_slots",
      arguments: { calendarIds: ["primary"], start: "2026-10-14", end: "2026-10-15", timezone: "America/New_York", durationMinutes: 60 },
    });
    const structured = result.structuredContent as { slots: { start: string; end: string }[]; complete: boolean };
    expect(structured.complete).toBe(true);
    expect(structured.slots).toEqual([
      { start: "2026-10-14T09:00:00-04:00", end: "2026-10-14T12:00:00-04:00", durationMinutes: 180 },
      { start: "2026-10-14T13:30:00-04:00", end: "2026-10-14T16:00:00-04:00", durationMinutes: 150 },
      { start: "2026-10-14T16:30:00-04:00", end: "2026-10-14T17:00:00-04:00", durationMinutes: 30 },
    ].filter((slot) => slot.durationMinutes >= 60));
    for (const marker of FORBIDDEN) expect(text(result)).not.toContain(marker);
  });

  it.each([
    ["unknown calendar", { calendarIds: ["nope"], start: "2026-10-14", end: "2026-10-15" }, "unknown_calendar"],
    ["invalid timestamp", { start: "next tuesday 9am", end: "2026-10-15" }, "invalid_input"],
    ["invalid timezone", { start: "2026-10-14", end: "2026-10-15", timezone: "Mars/Olympus" }, "invalid_input"],
    ["range over 93 days", { start: "2026-01-01", end: "2026-06-01" }, "invalid_input"],
  ])("returns a redacted tool error for %s", async (_label, args, code) => {
    const result = await client.callTool({ name: "get_free_busy", arguments: args });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(code);
    for (const marker of FORBIDDEN) expect(text(result)).not.toContain(marker);
  });

  it("rejects unknown argument keys", async () => {
    const outcome = await client
      .callTool({ name: "get_free_busy", arguments: { start: "2026-10-14", end: "2026-10-15", url: "https://evil.test/x.ics" } })
      .then((result) => result.isError === true)
      .catch(() => true);
    expect(outcome).toBe(true);
  });

  it("returns 404 outside /mcp", async () => {
    const response = await call(worker, new Request(`${ORIGIN}/nope`));
    expect(response.status).toBe(404);
  });
});
