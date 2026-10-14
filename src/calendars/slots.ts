import { CalendarError } from "../errors";
import { mergeEpochIntervals, type EpochInterval } from "./availability";
import { assertTimeZone, formatInTimeZone, wallClock, zonedTimeToEpoch } from "./time";
import type { FreeSlot } from "./types";

export const MAX_SLOTS = 100;

export interface WorkingHours {
  start: string;
  end: string;
}

export interface FindSlotsInput {
  startMs: number;
  endMs: number;
  timezone: string;
  durationMinutes: number;
  bufferMinutes: number;
  workingHours: WorkingHours;
  includeWeekends: boolean;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseHhmm(value: string, field: string): { hour: number; minute: number } {
  const match = HHMM.exec(value);
  if (!match) throw new CalendarError("invalid_input", `${field} must use HH:mm (24-hour) format.`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Returns free windows inside working hours (local to `timezone`) that are at
 * least `durationMinutes` long. Busy intervals are padded by `bufferMinutes`
 * on both sides. Overnight working windows are rejected.
 */
export function findFreeSlots(input: FindSlotsInput, busy: readonly EpochInterval[]): FreeSlot[] {
  assertTimeZone(input.timezone);
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes <= 0 || input.durationMinutes > 24 * 60) {
    throw new CalendarError("invalid_input", "durationMinutes must be a whole number between 1 and 1440.");
  }
  if (!Number.isInteger(input.bufferMinutes) || input.bufferMinutes < 0 || input.bufferMinutes > 240) {
    throw new CalendarError("invalid_input", "bufferMinutes must be a whole number between 0 and 240.");
  }
  const workStart = parseHhmm(input.workingHours.start, "workingHours.start");
  const workEnd = parseHhmm(input.workingHours.end, "workingHours.end");
  if (workEnd.hour * 60 + workEnd.minute <= workStart.hour * 60 + workStart.minute) {
    throw new CalendarError("invalid_input", "workingHours.end must be later than workingHours.start; overnight windows are not supported.");
  }

  const bufferMs = input.bufferMinutes * 60_000;
  const blocked = mergeEpochIntervals(
    busy.map((interval) => ({ ...interval, startMs: interval.startMs - bufferMs, endMs: interval.endMs + bufferMs })),
  );
  const durationMs = input.durationMinutes * 60_000;
  const slots: FreeSlot[] = [];

  for (const window of workingWindows(input, workStart, workEnd)) {
    let cursor = window.startMs;
    for (const interval of blocked) {
      if (interval.endMs <= cursor) continue;
      if (interval.startMs >= window.endMs) break;
      if (interval.startMs - cursor >= durationMs) slots.push(slot(cursor, interval.startMs, input.timezone));
      cursor = Math.max(cursor, interval.endMs);
      if (cursor >= window.endMs) break;
    }
    if (window.endMs - cursor >= durationMs) slots.push(slot(cursor, window.endMs, input.timezone));
    if (slots.length >= MAX_SLOTS) return slots.slice(0, MAX_SLOTS);
  }
  return slots;
}

function slot(startMs: number, endMs: number, timezone: string): FreeSlot {
  return {
    start: formatInTimeZone(startMs, timezone),
    end: formatInTimeZone(endMs, timezone),
    durationMinutes: Math.floor((endMs - startMs) / 60_000),
  };
}

function* workingWindows(
  input: FindSlotsInput,
  workStart: { hour: number; minute: number },
  workEnd: { hour: number; minute: number },
): Generator<{ startMs: number; endMs: number }> {
  const first = wallClock(input.startMs, input.timezone);
  // Walk calendar days in UTC date arithmetic; each day is converted back to
  // the local zone so DST transitions only affect that day's boundaries.
  for (let dayIndex = 0; ; dayIndex += 1) {
    const date = new Date(Date.UTC(first.year, first.month - 1, first.day + dayIndex));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const dayStartMs = zonedTimeToEpoch(year, month, day, 0, 0, 0, input.timezone);
    if (dayStartMs >= input.endMs) return;
    const weekday = date.getUTCDay();
    if (!input.includeWeekends && (weekday === 0 || weekday === 6)) continue;
    const startMs = Math.max(
      input.startMs,
      zonedTimeToEpoch(year, month, day, workStart.hour, workStart.minute, 0, input.timezone),
    );
    const endMs = Math.min(input.endMs, zonedTimeToEpoch(year, month, day, workEnd.hour, workEnd.minute, 0, input.timezone));
    if (endMs > startMs) yield { startMs, endMs };
  }
}
