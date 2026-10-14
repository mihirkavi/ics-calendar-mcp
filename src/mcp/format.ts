import type { AvailabilityResult, Coverage, FreeSlotsResult, PublicCalendar } from "../calendars/types";

function friendly(timestamp: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function coverageNote(coverage: Coverage[], complete: boolean): string {
  if (complete) return "";
  const missing = coverage.filter((entry) => entry.status !== "fresh").map((entry) => entry.calendarId);
  return `\nWARNING: incomplete result. These calendars could not be read, so their busy time is unknown: ${missing.join(", ")}.`;
}

export function describeCalendars(calendars: PublicCalendar[], now: string): string {
  const lines = calendars.map((calendar) => `- ${calendar.name} (id: ${calendar.id}, ${calendar.timezone})`);
  return `Current time: ${now}\n${calendars.length} read-only calendar(s):\n${lines.join("\n")}`;
}

export function describeAvailability(result: AvailabilityResult): string {
  const header = `Busy time from ${friendly(result.start, result.timezone)} to ${friendly(result.end, result.timezone)} (${result.timezone}):`;
  const lines = result.busy.length
    ? result.busy.map((interval) => `- ${friendly(interval.start, result.timezone)} – ${friendly(interval.end, result.timezone)}${interval.status === "tentative" ? " (tentative)" : ""}`)
    : ["- No busy time found."];
  return `${header}\n${lines.join("\n")}${coverageNote(result.coverage, result.complete)}`;
}

export function describeSlots(result: FreeSlotsResult): string {
  const header = `Free slots of at least ${result.durationMinutes} minutes (${result.timezone}):`;
  const lines = result.slots.length
    ? result.slots.map((slot) => `- ${friendly(slot.start, result.timezone)} – ${friendly(slot.end, result.timezone)} (${slot.durationMinutes} min)`)
    : ["- No matching free slots."];
  return `${header}\n${lines.join("\n")}${coverageNote(result.coverage, result.complete)}`;
}
