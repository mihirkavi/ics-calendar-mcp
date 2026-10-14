import type { BusyInterval, BusyStatus } from "./types";

/** Internal interval representation in epoch milliseconds. */
export interface EpochInterval {
  startMs: number;
  endMs: number;
  status: BusyStatus;
  calendarIds: string[];
}

const STATUS_RANK: Record<BusyStatus, number> = { tentative: 1, busy: 2 };

function strongerStatus(left: BusyStatus, right: BusyStatus): BusyStatus {
  return STATUS_RANK[left] >= STATUS_RANK[right] ? left : right;
}

/**
 * Sorts and merges overlapping or touching intervals. The merged status is the
 * strongest of its parts (busy > tentative) and source calendar IDs are
 * unioned. Inputs are not mutated; zero-length intervals are dropped.
 */
export function mergeEpochIntervals(intervals: readonly EpochInterval[]): EpochInterval[] {
  const sorted = intervals
    .filter((interval) => interval.endMs > interval.startMs)
    .map((interval) => ({ ...interval, calendarIds: [...interval.calendarIds] }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged: EpochInterval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
      last.status = strongerStatus(last.status, interval.status);
      last.calendarIds = [...new Set([...last.calendarIds, ...interval.calendarIds])];
    } else {
      merged.push(interval);
    }
  }
  for (const interval of merged) interval.calendarIds.sort();
  return merged;
}

export function clipEpochInterval(interval: EpochInterval, rangeStartMs: number, rangeEndMs: number): EpochInterval | undefined {
  const startMs = Math.max(interval.startMs, rangeStartMs);
  const endMs = Math.min(interval.endMs, rangeEndMs);
  if (endMs <= startMs) return undefined;
  return { ...interval, startMs, endMs, calendarIds: [...interval.calendarIds] };
}

export function toEpochInterval(interval: BusyInterval): EpochInterval {
  return {
    startMs: Date.parse(interval.start),
    endMs: Date.parse(interval.end),
    status: interval.status,
    calendarIds: [...interval.calendarIds],
  };
}

export function toBusyInterval(interval: EpochInterval, format: (epochMs: number) => string): BusyInterval {
  return {
    start: format(interval.startMs),
    end: format(interval.endMs),
    status: interval.status,
    calendarIds: [...interval.calendarIds],
  };
}

const isoFormat = (epochMs: number) => new Date(epochMs).toISOString();

/** RFC 3339 convenience wrapper around {@link mergeEpochIntervals}. */
export function mergeBusyIntervals(intervals: readonly BusyInterval[]): BusyInterval[] {
  return mergeEpochIntervals(intervals.map(toEpochInterval)).map((interval) => toBusyInterval(interval, isoFormat));
}

/** RFC 3339 convenience wrapper around {@link clipEpochInterval}. */
export function clipInterval(interval: BusyInterval, rangeStart: Date, rangeEnd: Date): BusyInterval | undefined {
  const clipped = clipEpochInterval(toEpochInterval(interval), rangeStart.getTime(), rangeEnd.getTime());
  return clipped ? toBusyInterval(clipped, isoFormat) : undefined;
}
