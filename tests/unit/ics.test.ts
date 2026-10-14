import { describe, expect, it } from "vitest";
import { parseBusyIntervals } from "../../src/calendars/adapters/ics";
import type { EpochInterval } from "../../src/calendars/availability";
import { CalendarError } from "../../src/errors";
import { comprehensive, dst, malformed, SECRET_MARKERS } from "../fixtures";

const iso = (ms: number) => new Date(ms).toISOString();
const spans = (intervals: EpochInterval[]) =>
  intervals.map((interval) => `${iso(interval.startMs)}/${iso(interval.endMs)}/${interval.status}`).sort();

function parse(ics: string, start: string, end: string, extra: { occurrenceLimit?: number; iterationLimit?: number; defaultTimezone?: string } = {}) {
  return parseBusyIntervals({
    ics,
    calendarId: "fixture",
    defaultTimezone: extra.defaultTimezone ?? "America/New_York",
    rangeStartMs: Date.parse(start),
    rangeEndMs: Date.parse(end),
    ...(extra.occurrenceLimit ? { occurrenceLimit: extra.occurrenceLimit } : {}),
    ...(extra.iterationLimit ? { iterationLimit: extra.iterationLimit } : {}),
  });
}

const cal = (body: string) => `BEGIN:VCALENDAR\nVERSION:2.0\n${body}\nEND:VCALENDAR`;

/** Excludes the old daily series so single-event assertions stay readable. */
const withoutDaily = (intervals: EpochInterval[]) => intervals.filter((interval) => new Date(interval.startMs).getUTCHours() !== 7);

describe("parseBusyIntervals: ordinary events", () => {
  it("returns timed, overlapping, and tentative events but skips transparent and cancelled ones", () => {
    const result = withoutDaily(parse(comprehensive, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"));
    expect(spans(result)).toEqual([
      "2026-10-14T16:00:00.000Z/2026-10-14T17:00:00.000Z/busy",
      "2026-10-14T16:30:00.000Z/2026-10-14T17:30:00.000Z/busy",
      "2026-10-14T20:00:00.000Z/2026-10-14T20:30:00.000Z/tentative",
    ]);
    expect(result.every((interval) => interval.calendarIds.join() === "fixture")).toBe(true);
  });

  it("treats all-day events as local midnight to midnight", () => {
    const result = withoutDaily(parse(comprehensive, "2026-10-16T00:00:00Z", "2026-10-17T12:00:00Z"));
    expect(spans(result)).toEqual(["2026-10-16T04:00:00.000Z/2026-10-17T04:00:00.000Z/busy"]);
  });

  it("keeps events spanning midnight and clips them to the range", () => {
    const full = withoutDaily(parse(comprehensive, "2026-10-17T12:00:00Z", "2026-10-18T12:00:00Z"));
    expect(spans(full)).toEqual(["2026-10-18T03:00:00.000Z/2026-10-18T05:00:00.000Z/busy"]);
    const clipped = withoutDaily(parse(comprehensive, "2026-10-18T04:00:00Z", "2026-10-18T12:00:00Z"));
    expect(spans(clipped)).toEqual(["2026-10-18T04:00:00.000Z/2026-10-18T05:00:00.000Z/busy"]);
  });

  it("treats an instance without its series as a standalone event", () => {
    const result = withoutDaily(parse(comprehensive, "2026-10-20T00:00:00Z", "2026-10-20T23:00:00Z"));
    expect(spans(result)).toEqual(["2026-10-20T12:00:00.000Z/2026-10-20T13:00:00.000Z/busy"]);
  });
});

describe("parseBusyIntervals: recurrence", () => {
  const weekly = (start: string, end: string) =>
    spans(withoutDaily(parse(comprehensive, start, end))).filter((span) => !span.startsWith("2026-10-20T12"));

  it("expands weekly rules with EXDATE and RDATE", () => {
    const standups = weekly("2026-10-05T00:00:00Z", "2026-10-24T00:00:00Z").filter((span) => /T(13|19):30:00\.000Z\/busy$/.test(span));
    expect(standups).toEqual([
      "2026-10-05T13:00:00.000Z/2026-10-05T13:30:00.000Z/busy",
      "2026-10-12T13:00:00.000Z/2026-10-12T13:30:00.000Z/busy",
      "2026-10-21T19:00:00.000Z/2026-10-21T19:30:00.000Z/busy",
    ]);
    // EXDATE removes 2026-10-19.
    expect(weekly("2026-10-19T00:00:00Z", "2026-10-20T00:00:00Z")).toEqual([]);
  });

  it("replaces a modified occurrence instead of duplicating it", () => {
    expect(weekly("2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z")).toEqual(["2026-10-26T18:00:00.000Z/2026-10-26T19:00:00.000Z/busy"]);
  });

  it("moves a modified occurrence out of a window that only covers its original slot", () => {
    expect(weekly("2026-10-26T12:00:00Z", "2026-10-26T14:00:00Z")).toEqual([]);
  });

  it("includes a modified occurrence moved into a window before its original slot", () => {
    const ics = comprehensive.replace("RECURRENCE-ID;TZID=America/New_York:20261026T090000\nDTSTART;TZID=America/New_York:20261026T140000\nDTEND;TZID=America/New_York:20261026T150000", "RECURRENCE-ID;TZID=America/New_York:20261026T090000\nDTSTART;TZID=America/New_York:20261023T140000\nDTEND;TZID=America/New_York:20261023T150000");
    expect(ics).not.toBe(comprehensive);
    const result = spans(withoutDaily(parse(ics, "2026-10-23T00:00:00Z", "2026-10-24T00:00:00Z")));
    expect(result).toEqual(["2026-10-23T18:00:00.000Z/2026-10-23T19:00:00.000Z/busy"]);
  });

  it("drops a cancelled recurrence exception", () => {
    expect(weekly("2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z")).toEqual([]);
  });

  it("applies RANGE=THISANDFUTURE exceptions", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:range@fixture.test
DTSTART:20261001T150000Z
DTEND:20261001T160000Z
RRULE:FREQ=DAILY;COUNT=10
END:VEVENT
BEGIN:VEVENT
UID:range@fixture.test
RECURRENCE-ID;RANGE=THISANDFUTURE:20261005T150000Z
DTSTART:20261005T170000Z
DTEND:20261005T180000Z
END:VEVENT
END:VCALENDAR`;
    expect(spans(parse(ics, "2026-10-04T00:00:00Z", "2026-10-07T00:00:00Z"))).toEqual([
      "2026-10-04T15:00:00.000Z/2026-10-04T16:00:00.000Z/busy",
      "2026-10-05T17:00:00.000Z/2026-10-05T18:00:00.000Z/busy",
      "2026-10-06T17:00:00.000Z/2026-10-06T18:00:00.000Z/busy",
    ]);
  });

  it("returns only in-range occurrences of a series that began years earlier", () => {
    const result = parse(comprehensive, "2026-10-14T00:00:00Z", "2026-10-16T00:00:00Z").filter((interval) => new Date(interval.startMs).getUTCHours() === 7);
    expect(spans(result)).toEqual([
      "2026-10-14T07:00:00.000Z/2026-10-14T07:15:00.000Z/busy",
      "2026-10-15T07:00:00.000Z/2026-10-15T07:15:00.000Z/busy",
    ]);
  });

  it("does not count occurrences before the range toward the occurrence cap", () => {
    const ics = cal(`BEGIN:VEVENT\nUID:ancient@fixture.test\nDTSTART;TZID=America/New_York:19980101T090000\nDTEND;TZID=America/New_York:19980101T093000\nRRULE:FREQ=DAILY\nEND:VEVENT`);
    expect(spans(parse(ics, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"))).toEqual(["2026-10-14T13:00:00.000Z/2026-10-14T13:30:00.000Z/busy"]);
  });

  it("enforces the emitted-occurrence cap", () => {
    expect(() => parse(comprehensive, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z", { occurrenceLimit: 20 })).toThrowError(/more than 20/);
  });

  it("enforces the iteration cap", () => {
    try {
      parse(comprehensive, "2026-10-14T00:00:00Z", "2026-10-16T00:00:00Z", { iterationLimit: 500 });
      throw new Error("expected cap");
    } catch (error) {
      expect(error).toBeInstanceOf(CalendarError);
      expect((error as CalendarError).code).toBe("too_many_occurrences");
    }
  });

  it("matches a UTC RECURRENCE-ID against a zoned series", () => {
    const ics = cal(`BEGIN:VEVENT
UID:zoned@fixture.test
DTSTART;TZID=America/New_York:20261005T100000
DTEND;TZID=America/New_York:20261005T110000
RRULE:FREQ=WEEKLY;COUNT=4
END:VEVENT
BEGIN:VEVENT
UID:zoned@fixture.test
RECURRENCE-ID:20261012T140000Z
DTSTART;TZID=America/New_York:20261013T160000
DTEND;TZID=America/New_York:20261013T170000
END:VEVENT`);
    expect(spans(parse(ics, "2026-10-12T00:00:00Z", "2026-10-14T00:00:00Z"))).toEqual(["2026-10-13T20:00:00.000Z/2026-10-13T21:00:00.000Z/busy"]);
  });

  it("keeps an override whose RECURRENCE-ID no longer matches the series", () => {
    const ics = cal(`BEGIN:VEVENT
UID:edited@fixture.test
DTSTART:20261005T150000Z
DTEND:20261005T160000Z
RRULE:FREQ=WEEKLY;COUNT=4
END:VEVENT
BEGIN:VEVENT
UID:edited@fixture.test
RECURRENCE-ID:20261012T140000Z
DTSTART:20261013T170000Z
DTEND:20261013T180000Z
END:VEVENT`);
    expect(spans(parse(ics, "2026-10-12T00:00:00Z", "2026-10-14T00:00:00Z"))).toEqual([
      "2026-10-12T15:00:00.000Z/2026-10-12T16:00:00.000Z/busy",
      "2026-10-13T17:00:00.000Z/2026-10-13T18:00:00.000Z/busy",
    ]);
  });

  it("applies overrides on a non-recurring master", () => {
    const ics = cal(`BEGIN:VEVENT
UID:single@fixture.test
DTSTART:20261012T150000Z
DTEND:20261012T160000Z
END:VEVENT
BEGIN:VEVENT
UID:single@fixture.test
RECURRENCE-ID:20261012T150000Z
DTSTART:20261012T180000Z
DTEND:20261012T190000Z
END:VEVENT`);
    expect(spans(parse(ics, "2026-10-12T00:00:00Z", "2026-10-13T00:00:00Z"))).toEqual(["2026-10-12T18:00:00.000Z/2026-10-12T19:00:00.000Z/busy"]);
  });

  it("expands every recurring series when UIDs are missing or duplicated", () => {
    const series = (uid: string, hour: string) =>
      `BEGIN:VEVENT\n${uid}DTSTART:20261012T${hour}0000Z\nDTEND:20261012T${hour}3000Z\nRRULE:FREQ=DAILY;COUNT=3\nEND:VEVENT`;
    const ics = cal([series("", "13"), series("", "15"), series("UID:dup@fixture.test\n", "17"), series("UID:dup@fixture.test\n", "19")].join("\n"));
    const result = spans(parse(ics, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"));
    expect(result).toEqual([
      "2026-10-14T13:00:00.000Z/2026-10-14T13:30:00.000Z/busy",
      "2026-10-14T15:00:00.000Z/2026-10-14T15:30:00.000Z/busy",
      "2026-10-14T17:00:00.000Z/2026-10-14T17:30:00.000Z/busy",
      "2026-10-14T19:00:00.000Z/2026-10-14T19:30:00.000Z/busy",
    ]);
  });
});

describe("parseBusyIntervals: timezones and failures", () => {
  it("keeps local wall-clock times across a fall-back transition", () => {
    // 09:00 New York is 13:00Z before 2026-11-01 and 14:00Z after.
    expect(spans(parse(dst, "2026-10-30T00:00:00Z", "2026-11-04T00:00:00Z").filter((i) => new Date(i.startMs).getUTCMonth() >= 9))).toEqual([
      "2026-10-30T13:00:00.000Z/2026-10-30T14:00:00.000Z/busy",
      "2026-10-31T13:00:00.000Z/2026-10-31T14:00:00.000Z/busy",
      "2026-11-01T14:00:00.000Z/2026-11-01T15:00:00.000Z/busy",
      "2026-11-02T14:00:00.000Z/2026-11-02T15:00:00.000Z/busy",
      "2026-11-03T14:00:00.000Z/2026-11-03T15:00:00.000Z/busy",
    ]);
  });

  it("uses embedded VTIMEZONE definitions across spring-forward", () => {
    expect(spans(parse(dst, "2026-03-01T00:00:00Z", "2026-03-11T00:00:00Z"))).toEqual([
      "2026-03-02T14:00:00.000Z/2026-03-02T15:00:00.000Z/busy",
      "2026-03-10T13:00:00.000Z/2026-03-10T14:00:00.000Z/busy",
    ]);
  });

  it("fails on an unknown timezone", () => {
    const ics = dst.replace(/BEGIN:VTIMEZONE[\s\S]*END:VTIMEZONE\n/, "");
    expect(() => parse(ics, "2026-03-01T00:00:00Z", "2026-03-11T00:00:00Z")).toThrowError(CalendarError);
  });

  it("fails on malformed ICS without echoing content", () => {
    try {
      parse(malformed, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CalendarError);
      expect((error as CalendarError).code).toBe("feed_invalid");
      expect((error as Error).message).not.toContain("SECRET");
    }
  });

  it("never copies event content into results", () => {
    const serialized = JSON.stringify(parse(comprehensive, "2026-10-01T00:00:00Z", "2026-11-30T00:00:00Z"));
    for (const marker of SECRET_MARKERS) expect(serialized).not.toContain(marker);
  });
});
