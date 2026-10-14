import { describe, expect, it } from "vitest";
import { CalendarRegistry, EXAMPLE_REGISTRY, loadRegistry, resolveCalendarUrl, toPublicCalendar } from "../../src/calendars/registry";
import type { CalendarDefinition } from "../../src/calendars/types";
import { CalendarError } from "../../src/errors";

const enabled: CalendarDefinition = {
  id: "team",
  name: "Team",
  enabled: true,
  timezone: "America/New_York",
  secretBinding: "CALENDAR_TEAM_ICS_URL",
  allowedHostname: "calendar.example.com",
};
const disabled: CalendarDefinition = { ...enabled, id: "old", name: "Old", enabled: false, secretBinding: "CALENDAR_OLD_ICS_URL" };

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CalendarError);
    expect((error as CalendarError).code).toBe(code);
    return;
  }
  throw new Error("expected throw");
}

describe("registry", () => {
  const registry = new CalendarRegistry([enabled, disabled]);

  it("lists only enabled calendars", () => {
    expect(registry.listEnabledCalendars().map((c) => c.id)).toEqual(["team"]);
  });

  it("resolves a known synthetic ID", () => {
    expect(registry.getCalendar("team")?.name).toBe("Team");
    expect(registry.getCalendar("missing")).toBeUndefined();
  });

  it("defaults to the synthetic example registry", () => {
    expect(loadRegistry({}).definitions).toEqual(EXAMPLE_REGISTRY);
    expect(EXAMPLE_REGISTRY[0]).toMatchObject({ id: "example-calendar", allowedHostname: "calendar.example.com" });
  });

  it("loads and validates CALENDAR_REGISTRY JSON", () => {
    const loaded = loadRegistry({ CALENDAR_REGISTRY: JSON.stringify([{ ...enabled, allowedHostname: "Calendar.Example.com" }]) });
    expect(loaded.getCalendar("team")?.allowedHostname).toBe("calendar.example.com");
    expectCode(() => loadRegistry({ CALENDAR_REGISTRY: "{not json" }), "calendar_not_configured");
    expectCode(() => loadRegistry({ CALENDAR_REGISTRY: JSON.stringify([{ ...enabled, timezone: "Mars/Base" }]) }), "calendar_not_configured");
    expectCode(() => loadRegistry({ CALENDAR_REGISTRY: JSON.stringify([enabled, enabled]) }), "calendar_not_configured");
    expectCode(() => loadRegistry({ CALENDAR_REGISTRY: JSON.stringify([{ ...enabled, extra: 1 }]) }), "calendar_not_configured");
  });

  it("resolves a valid HTTPS URL from the secret binding", () => {
    const url = resolveCalendarUrl(enabled, { CALENDAR_TEAM_ICS_URL: "https://CALENDAR.example.com/feed.ics?token=abc" });
    expect(url.hostname).toBe("calendar.example.com");
  });

  it.each([
    ["missing binding", undefined],
    ["empty binding", ""],
    ["not a URL", "nope"],
    ["http scheme", "http://calendar.example.com/feed.ics"],
    ["webcal scheme", "webcal://calendar.example.com/feed.ics"],
    ["embedded credentials", "https://user:pass@calendar.example.com/feed.ics"],
    ["userinfo host trick", "https://calendar.example.com@evil.test/feed.ics"],
    ["suffix domain", "https://calendar.example.com.evil.test/feed.ics"],
    ["subdomain", "https://x.calendar.example.com/feed.ics"],
    ["custom port", "https://calendar.example.com:8443/feed.ics"],
  ])("rejects %s", (_label, value) => {
    expectCode(() => resolveCalendarUrl(enabled, { CALENDAR_TEAM_ICS_URL: value }), "calendar_not_configured");
  });

  it("never exposes binding names or hostnames publicly", () => {
    const serialized = JSON.stringify(toPublicCalendar(enabled));
    expect(serialized).not.toContain("CALENDAR_TEAM_ICS_URL");
    expect(serialized).not.toContain("calendar.example.com");
    expect(toPublicCalendar(enabled)).toEqual({ id: "team", name: "Team", timezone: "America/New_York", capabilities: ["read_free_busy"] });
  });
});
