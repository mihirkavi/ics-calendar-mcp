import { describe, expect, it, vi } from "vitest";
import { parseBusyIntervals } from "../../src/calendars/adapters/ics";
import { CalendarRegistry } from "../../src/calendars/registry";
import { createCalendarService } from "../../src/calendars/service";
import type { CalendarDefinition } from "../../src/calendars/types";
import { CalendarError } from "../../src/errors";

const def = (id: string, extra: Partial<CalendarDefinition> = {}): CalendarDefinition => ({
  id,
  name: id.toUpperCase(),
  enabled: true,
  timezone: "America/New_York",
  secretBinding: `CAL_${id.toUpperCase()}_URL`,
  allowedHostname: "calendar.example.com",
  ...extra,
});

const registry = new CalendarRegistry([def("a"), def("b"), def("off", { enabled: false })]);
const env = {
  CAL_A_URL: "https://calendar.example.com/a.ics",
  CAL_B_URL: "https://calendar.example.com/b.ics",
  CAL_OFF_URL: "https://calendar.example.com/off.ics",
};

const event = (uid: string, start: string, end: string) =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${start}\r\nDTEND:${end}\r\nSUMMARY:SECRET-${uid}\r\nEND:VEVENT\r\n`;
const feeds: Record<string, string> = {
  "/a.ics": `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${event("a1", "20261014T140000Z", "20261014T150000Z")}END:VCALENDAR\r\n`,
  "/b.ics": `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${event("b1", "20261014T143000Z", "20261014T160000Z")}${event("b2", "20261014T180000Z", "20261014T183000Z")}END:VCALENDAR\r\n`,
};

function service(failing: string[] = []) {
  const fetchCalendar = vi.fn(async (url: URL) => {
    if (failing.some((path) => url.pathname === path)) throw new CalendarError("feed_unavailable");
    return { body: feeds[url.pathname] ?? "", fetchedAt: "2026-10-14T00:00:00.000Z" };
  });
  return { fetchCalendar, service: createCalendarService(env, { registry, fetchCalendar, parseBusyIntervals }) };
}

const window = { start: "2026-10-14T00:00:00Z", end: "2026-10-15T00:00:00Z", timezone: "UTC" };

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return (error as CalendarError).code;
  }
  return undefined;
}

describe("calendar service", () => {
  it("lists only enabled public calendars", () => {
    expect(service().service.listCalendars().map((calendar) => calendar.id)).toEqual(["a", "b"]);
    expect(JSON.stringify(service().service.listCalendars())).not.toContain("CAL_");
  });

  it("merges busy time across all enabled calendars by default", async () => {
    const { service: svc, fetchCalendar } = service();
    const result = await svc.getFreeBusy(window);
    expect(fetchCalendar).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      start: "2026-10-14T00:00:00Z",
      end: "2026-10-15T00:00:00Z",
      timezone: "UTC",
      busy: [
        { start: "2026-10-14T14:00:00Z", end: "2026-10-14T16:00:00Z", status: "busy", calendarIds: ["a", "b"] },
        { start: "2026-10-14T18:00:00Z", end: "2026-10-14T18:30:00Z", status: "busy", calendarIds: ["b"] },
      ],
      coverage: [
        { calendarId: "a", status: "fresh", fetchedAt: "2026-10-14T00:00:00.000Z" },
        { calendarId: "b", status: "fresh", fetchedAt: "2026-10-14T00:00:00.000Z" },
      ],
      complete: true,
    });
  });

  it("formats output in the requested timezone and defaults to the calendar timezone", async () => {
    const result = await service().service.getFreeBusy({ calendarIds: ["a"], start: "2026-10-14", end: "2026-10-15" });
    expect(result.timezone).toBe("America/New_York");
    expect(result.busy[0]?.start).toBe("2026-10-14T10:00:00-04:00");
  });

  it("deduplicates IDs and preserves input order in coverage", async () => {
    const result = await service().service.getFreeBusy({ ...window, calendarIds: ["b", "a", "b"] });
    expect(result.coverage.map((entry) => entry.calendarId)).toEqual(["b", "a"]);
  });

  it("rejects unknown and disabled calendar IDs before fetching", async () => {
    const { service: svc, fetchCalendar } = service();
    expect(await codeOf(svc.getFreeBusy({ ...window, calendarIds: ["nope"] }))).toBe("unknown_calendar");
    expect(await codeOf(svc.getFreeBusy({ ...window, calendarIds: ["off"] }))).toBe("unknown_calendar");
    expect(fetchCalendar).not.toHaveBeenCalled();
  });

  it("propagates range and timezone validation", async () => {
    const svc = service().service;
    expect(await codeOf(svc.getFreeBusy({ ...window, timezone: "Nowhere/Zone" }))).toBe("invalid_input");
    expect(await codeOf(svc.getFreeBusy({ ...window, end: "2027-03-01T00:00:00Z" }))).toBe("invalid_input");
  });

  it("returns partial intervals and complete:false when one calendar fails", async () => {
    const result = await service(["/b.ics"]).service.getFreeBusy(window);
    expect(result.complete).toBe(false);
    expect(result.busy).toEqual([{ start: "2026-10-14T14:00:00Z", end: "2026-10-14T15:00:00Z", status: "busy", calendarIds: ["a"] }]);
    expect(result.coverage[1]).toEqual({ calendarId: "b", status: "unavailable", error: { code: "feed_unavailable", message: "A calendar feed could not be retrieved." } });
  });

  it("reports an incomplete result when every calendar fails", async () => {
    const result = await service(["/a.ics", "/b.ics"]).service.getFreeBusy(window);
    expect(result.complete).toBe(false);
    expect(result.busy).toEqual([]);
    expect(result.coverage.every((entry) => entry.status === "unavailable")).toBe(true);
  });

  it("marks a missing secret as unavailable coverage", async () => {
    const svc = createCalendarService({ CAL_A_URL: env.CAL_A_URL }, { registry, fetchCalendar: async () => ({ body: feeds["/a.ics"]!, fetchedAt: "x" }) });
    const result = await svc.getFreeBusy(window);
    expect(result.coverage[1]).toMatchObject({ calendarId: "b", status: "unavailable", error: { code: "calendar_not_configured" } });
  });

  it("finds free slots and carries coverage through", async () => {
    const result = await service().service.findFreeSlots({ ...window, durationMinutes: 60, workingHours: { start: "13:00", end: "19:00" } });
    expect(result.slots).toEqual([
      { start: "2026-10-14T13:00:00Z", end: "2026-10-14T14:00:00Z", durationMinutes: 60 },
      { start: "2026-10-14T16:00:00Z", end: "2026-10-14T18:00:00Z", durationMinutes: 120 },
    ]);
    expect(result.complete).toBe(true);
    const partial = await service(["/b.ics"]).service.findFreeSlots({ ...window, durationMinutes: 60, workingHours: { start: "13:00", end: "19:00" } });
    expect(partial.complete).toBe(false);
    expect(partial.coverage[1]?.status).toBe("unavailable");
  });

  it("never includes event content", async () => {
    const result = await service().service.getFreeBusy(window);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
