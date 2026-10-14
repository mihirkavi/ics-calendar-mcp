import { describe, expect, it } from "vitest";
import type { EpochInterval } from "../../src/calendars/availability";
import { findFreeSlots, type FindSlotsInput } from "../../src/calendars/slots";
import { formatInTimeZone, parseInstant, resolveRange, zonedTimeToEpoch } from "../../src/calendars/time";
import { CalendarError } from "../../src/errors";

const TZ = "America/New_York";
const local = (value: string) => parseInstant(value, TZ, "t");
const busy = (start: string, end: string): EpochInterval => ({ startMs: local(start), endMs: local(end), status: "busy", calendarIds: ["a"] });

function input(overrides: Partial<FindSlotsInput> = {}): FindSlotsInput {
  return {
    startMs: local("2026-10-14"),
    endMs: local("2026-10-15"),
    timezone: TZ,
    durationMinutes: 60,
    bufferMinutes: 0,
    workingHours: { start: "09:00", end: "17:00" },
    includeWeekends: false,
    ...overrides,
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof CalendarError ? error.code : "other";
  }
  return undefined;
}

describe("findFreeSlots", () => {
  it("finds a 60-minute slot between two meetings", () => {
    const slots = findFreeSlots(input(), [busy("2026-10-14T09:00", "2026-10-14T12:00"), busy("2026-10-14T13:00", "2026-10-14T17:00")]);
    expect(slots).toEqual([{ start: "2026-10-14T12:00:00-04:00", end: "2026-10-14T13:00:00-04:00", durationMinutes: 60 }]);
  });

  it("applies the buffer on both sides of busy time", () => {
    const meetings = [busy("2026-10-14T09:00", "2026-10-14T12:00"), busy("2026-10-14T13:00", "2026-10-14T17:00")];
    expect(findFreeSlots(input({ bufferMinutes: 15 }), meetings)).toEqual([]);
    expect(findFreeSlots(input({ bufferMinutes: 15, durationMinutes: 30 }), meetings)).toEqual([
      { start: "2026-10-14T12:15:00-04:00", end: "2026-10-14T12:45:00-04:00", durationMinutes: 30 },
    ]);
  });

  it("spans multiple days and skips weekends by default", () => {
    // 2026-10-16 is a Friday; 17-18 are the weekend.
    const range = input({ startMs: local("2026-10-16"), endMs: local("2026-10-20") });
    expect(findFreeSlots(range, []).map((slot) => slot.start)).toEqual(["2026-10-16T09:00:00-04:00", "2026-10-19T09:00:00-04:00"]);
    expect(findFreeSlots({ ...range, includeWeekends: true }, [])).toHaveLength(4);
  });

  it("respects the query range inside a working day", () => {
    const slots = findFreeSlots(input({ startMs: local("2026-10-14T15:30") }), []);
    expect(slots).toEqual([{ start: "2026-10-14T15:30:00-04:00", end: "2026-10-14T17:00:00-04:00", durationMinutes: 90 }]);
  });

  it("handles a spring-forward day", () => {
    // 2026-03-08 02:00 local jumps to 03:00; working 01:00-05:00 is three real hours.
    const slots = findFreeSlots(
      input({ startMs: local("2026-03-08"), endMs: local("2026-03-09"), includeWeekends: true, workingHours: { start: "01:00", end: "05:00" } }),
      [],
    );
    expect(slots).toEqual([{ start: "2026-03-08T01:00:00-05:00", end: "2026-03-08T05:00:00-04:00", durationMinutes: 180 }]);
  });

  it("handles a fall-back day with a repeated hour", () => {
    // 2026-11-01 01:00-02:00 occurs twice; working 00:00-03:00 is four real hours.
    const slots = findFreeSlots(
      input({ startMs: local("2026-11-01"), endMs: local("2026-11-02"), includeWeekends: true, workingHours: { start: "00:00", end: "03:00" } }),
      [],
    );
    expect(slots).toEqual([{ start: "2026-11-01T00:00:00-04:00", end: "2026-11-01T03:00:00-05:00", durationMinutes: 240 }]);
  });

  it("rejects invalid inputs", () => {
    expect(code(() => findFreeSlots(input({ timezone: "Mars/Base" }), []))).toBe("invalid_input");
    expect(code(() => findFreeSlots(input({ durationMinutes: 0 }), []))).toBe("invalid_input");
    expect(code(() => findFreeSlots(input({ durationMinutes: -5 }), []))).toBe("invalid_input");
    expect(code(() => findFreeSlots(input({ workingHours: { start: "22:00", end: "06:00" } }), []))).toBe("invalid_input");
    expect(code(() => findFreeSlots(input({ workingHours: { start: "09:00", end: "09:00" } }), []))).toBe("invalid_input");
    expect(code(() => findFreeSlots(input({ workingHours: { start: "9am", end: "17:00" } }), []))).toBe("invalid_input");
  });
});

describe("time helpers", () => {
  it("rejects ranges over 93 days, reversed ranges, and bad timestamps", () => {
    expect(code(() => resolveRange("2026-01-01", "2026-04-05", TZ))).toBe("invalid_input");
    expect(code(() => resolveRange("2026-01-01", "2026-04-04", TZ))).toBeUndefined();
    expect(code(() => resolveRange("2026-01-02", "2026-01-01", TZ))).toBe("invalid_input");
    expect(code(() => resolveRange("2026-01-01", "2026-01-01", TZ))).toBe("invalid_input");
    expect(code(() => resolveRange("yesterday", "2026-01-01", TZ))).toBe("invalid_input");
    expect(code(() => resolveRange("2026-02-30", "2026-03-01", TZ))).toBe("invalid_input");
    expect(code(() => resolveRange("2026-01-01", "2026-01-02", "+05:00"))).toBe("invalid_input");
  });

  it("parses offsets, local date-times, and dates", () => {
    expect(parseInstant("2026-10-14T09:00:00-07:00", TZ, "t")).toBe(Date.parse("2026-10-14T16:00:00Z"));
    expect(parseInstant("2026-10-14T09:00", TZ, "t")).toBe(Date.parse("2026-10-14T13:00:00Z"));
    expect(parseInstant("2026-10-14", "UTC", "t")).toBe(Date.parse("2026-10-14T00:00:00Z"));
  });

  it("resolves DST gaps forward and repeated hours to the earlier instant", () => {
    expect(formatInTimeZone(zonedTimeToEpoch(2026, 3, 8, 2, 30, 0, TZ), TZ)).toBe("2026-03-08T03:30:00-04:00");
    expect(formatInTimeZone(zonedTimeToEpoch(2026, 11, 1, 1, 30, 0, TZ), TZ)).toBe("2026-11-01T01:30:00-04:00");
  });

  it("formats UTC with Z", () => {
    expect(formatInTimeZone(Date.parse("2026-10-14T09:00:00Z"), "UTC")).toBe("2026-10-14T09:00:00Z");
  });
});
