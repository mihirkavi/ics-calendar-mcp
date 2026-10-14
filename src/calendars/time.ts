import { CalendarError } from "../errors";

export const MAX_RANGE_DAYS = 93;
const DAY_MS = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, cached);
  }
  return cached;
}

/** True for IANA zone names (and UTC) that the runtime can resolve. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

export function assertTimeZone(value: string): void {
  if (!isValidTimeZone(value)) throw new CalendarError("invalid_input", `Unknown timezone: ${sanitize(value)}`);
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_/+-]/g, "").slice(0, 64);
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function wallClock(epochMs: number, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** Offset of `timeZone` from UTC at the given instant, in minutes. */
export function offsetMinutes(epochMs: number, timeZone: string): number {
  const wc = wallClock(epochMs, timeZone);
  const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

/**
 * Converts a wall-clock time in `timeZone` to an epoch instant. Times inside a
 * DST gap resolve forward (02:30 on a spring-forward day becomes 03:30);
 * repeated times resolve to the earlier occurrence.
 */
export function zonedTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const before = naive - offsetMinutes(naive - DAY_MS, timeZone) * 60_000;
  const after = naive - offsetMinutes(naive + DAY_MS, timeZone) * 60_000;
  const roundTrips = (candidate: number) => candidate + offsetMinutes(candidate, timeZone) * 60_000 === naive;
  const valid = [before, after].filter(roundTrips);
  if (valid.length > 0) return Math.min(...valid);
  // Inside a spring-forward gap: shift forward by the gap length.
  return before;
}

function pad(value: number, width = 2): string {
  return String(Math.abs(value)).padStart(width, "0");
}

/** RFC 3339 timestamp expressed in `timeZone` with its numeric offset. */
export function formatInTimeZone(epochMs: number, timeZone: string): string {
  const wc = wallClock(epochMs, timeZone);
  const offset = offsetMinutes(epochMs, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const offsetText = offset === 0 && timeZone === "UTC" ? "Z" : `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
  return `${pad(wc.year, 4)}-${pad(wc.month)}-${pad(wc.day)}T${pad(wc.hour)}:${pad(wc.minute)}:${pad(wc.second)}${offsetText}`;
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Parses an RFC 3339 timestamp. Local date-times (`2026-10-14T09:00`) and
 * dates (`2026-10-14`, meaning local midnight) are interpreted in `timeZone`.
 */
export function parseInstant(value: string, timeZone: string, field: string): number {
  const rfc = RFC3339.exec(value);
  if (rfc) {
    const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((index) => Number(rfc[index]));
    if (!validDate(year!, month!, day!) || hour! > 23 || minute! > 59) throw invalidTimestamp(field);
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) throw invalidTimestamp(field);
    return parsed;
  }
  const local = LOCAL_DATETIME.exec(value) ?? LOCAL_DATE.exec(value);
  if (local) {
    const year = Number(local[1]);
    const month = Number(local[2]);
    const day = Number(local[3]);
    const hour = Number(local[4] ?? 0);
    const minute = Number(local[5] ?? 0);
    const second = Number(local[6] ?? 0);
    if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) throw invalidTimestamp(field);
    return zonedTimeToEpoch(year, month, day, hour, minute, second, timeZone);
  }
  throw invalidTimestamp(field);
}

function invalidTimestamp(field: string): CalendarError {
  return new CalendarError("invalid_input", `${field} must be an RFC 3339 timestamp or YYYY-MM-DD date.`);
}

export interface QueryRange {
  startMs: number;
  endMs: number;
  timezone: string;
}

export function resolveRange(start: string, end: string, timezone: string): QueryRange {
  assertTimeZone(timezone);
  const startMs = parseInstant(start, timezone, "start");
  const endMs = parseInstant(end, timezone, "end");
  if (endMs <= startMs) throw new CalendarError("invalid_input", "end must be after start.");
  if (endMs - startMs > MAX_RANGE_DAYS * DAY_MS) {
    throw new CalendarError("invalid_input", `The range may span at most ${MAX_RANGE_DAYS} days.`);
  }
  return { startMs, endMs, timezone };
}
