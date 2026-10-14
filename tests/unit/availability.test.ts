import { describe, expect, it } from "vitest";
import { clipInterval, mergeBusyIntervals } from "../../src/calendars/availability";
import type { BusyInterval } from "../../src/calendars/types";

const at = (hhmm: string) => `2026-10-14T${hhmm}:00.000Z`;
const busy = (start: string, end: string, calendarIds = ["a"], status: BusyInterval["status"] = "busy"): BusyInterval => ({
  start: at(start),
  end: at(end),
  status,
  calendarIds,
});

describe("mergeBusyIntervals", () => {
  it("sorts and merges overlapping intervals", () => {
    expect(mergeBusyIntervals([busy("11:00", "12:00"), busy("09:00", "10:30"), busy("10:00", "10:45")])).toEqual([
      busy("09:00", "10:45"),
      busy("11:00", "12:00"),
    ]);
  });

  it("merges touching intervals", () => {
    expect(mergeBusyIntervals([busy("09:00", "10:00"), busy("10:00", "11:00")])).toEqual([busy("09:00", "11:00")]);
  });

  it("drops zero-length intervals", () => {
    expect(mergeBusyIntervals([busy("09:00", "09:00")])).toEqual([]);
  });

  it("unions and sorts source calendar IDs and prefers busy over tentative", () => {
    expect(mergeBusyIntervals([busy("09:00", "10:00", ["b"], "tentative"), busy("09:30", "11:00", ["a", "b"])])).toEqual([
      busy("09:00", "11:00", ["a", "b"], "busy"),
    ]);
    expect(mergeBusyIntervals([busy("09:00", "10:00", ["a"], "tentative")])[0]?.status).toBe("tentative");
  });

  it("does not mutate inputs", () => {
    const input = [busy("10:00", "11:00", ["b"]), busy("09:00", "10:30", ["a"])];
    const snapshot = structuredClone(input);
    mergeBusyIntervals(input);
    expect(input).toEqual(snapshot);
  });
});

describe("clipInterval", () => {
  const start = new Date(at("10:00"));
  const end = new Date(at("12:00"));

  it("clips to the range", () => {
    expect(clipInterval(busy("09:00", "11:00"), start, end)).toEqual(busy("10:00", "11:00"));
    expect(clipInterval(busy("11:00", "13:00"), start, end)).toEqual(busy("11:00", "12:00"));
  });

  it("returns undefined outside the half-open range", () => {
    expect(clipInterval(busy("08:00", "10:00"), start, end)).toBeUndefined();
    expect(clipInterval(busy("12:00", "13:00"), start, end)).toBeUndefined();
  });
});
