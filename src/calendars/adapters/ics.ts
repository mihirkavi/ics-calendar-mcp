import ICAL from "ical.js";
import { CalendarError } from "../../errors";
import type { EpochInterval } from "../availability";
import { clipEpochInterval } from "../availability";
import { isValidTimeZone, zonedTimeToEpoch } from "../time";
import type { BusyStatus } from "../types";

/** Maximum busy occurrences emitted per calendar per request. */
export const DEFAULT_OCCURRENCE_LIMIT = 10_000;
/** Maximum recurrence candidates generated per calendar per request (CPU bound). */
export const DEFAULT_ITERATION_LIMIT = 100_000;

export interface ParseIcsInput {
  ics: string;
  calendarId: string;
  defaultTimezone: string;
  rangeStartMs: number;
  rangeEndMs: number;
  occurrenceLimit?: number;
  iterationLimit?: number;
}

type IcalComponent = InstanceType<typeof ICAL.Component>;
type IcalEvent = InstanceType<typeof ICAL.Event>;
type IcalTime = InstanceType<typeof ICAL.Time>;
type IcalTimezone = InstanceType<typeof ICAL.Timezone>;

interface ParseContext {
  calendarId: string;
  defaultTimezone: string;
  rangeStartMs: number;
  rangeEndMs: number;
  embeddedZones: Map<string, IcalTimezone>;
  occurrences: Budget;
  iterations: Budget;
}

interface Budget {
  remaining: number;
  limit: number;
}

/**
 * Parses an ICS document and returns detail-free busy intervals overlapping
 * `[rangeStartMs, rangeEndMs)`. Only DTSTART/DTEND/DURATION, recurrence data,
 * STATUS, and TRANSP are inspected; no event content leaves this function.
 */
export function parseBusyIntervals(input: ParseIcsInput): EpochInterval[] {
  const root = parseRoot(input.ics);
  const context: ParseContext = {
    calendarId: input.calendarId,
    defaultTimezone: input.defaultTimezone,
    rangeStartMs: input.rangeStartMs,
    rangeEndMs: input.rangeEndMs,
    embeddedZones: embeddedTimezones(root),
    occurrences: budget(input.occurrenceLimit ?? DEFAULT_OCCURRENCE_LIMIT),
    iterations: budget(input.iterationLimit ?? DEFAULT_ITERATION_LIMIT),
  };

  // Group by UID. Events without a UID cannot be related to anything, so each
  // gets its own group.
  const groups = new Map<string, { masters: IcalComponent[]; exceptions: IcalComponent[] }>();
  let anonymous = 0;
  for (const component of root.getAllSubcomponents("vevent")) {
    const uid = component.getFirstPropertyValue("uid");
    const key = uid ? `uid:${String(uid)}` : `anon:${anonymous++}`;
    const group = groups.get(key) ?? { masters: [], exceptions: [] };
    if (component.hasProperty("recurrence-id")) group.exceptions.push(component);
    else group.masters.push(component);
    groups.set(key, group);
  }

  const intervals: EpochInterval[] = [];
  for (const group of groups.values()) {
    const [master, ...extraMasters] = group.masters;
    if (master) processSeries(master, group.exceptions, context, intervals);
    else for (const exception of group.exceptions) addSingle(exception, context, intervals);
    // Duplicate masters for one UID are malformed; keep their busy time rather
    // than dropping it, but do not attach exceptions to them.
    for (const extra of extraMasters) processSeries(extra, [], context, intervals);
  }
  return intervals;
}

function budget(limit: number): Budget {
  return { remaining: limit, limit };
}

function processSeries(master: IcalComponent, exceptions: IcalComponent[], context: ParseContext, intervals: EpochInterval[]): void {
  const event = safeEvent(master);
  if (event.isRecurring()) {
    expandRecurring(event, exceptions, context, intervals);
    return;
  }
  // A non-recurring master can still carry an override for its only instance.
  const masterStartMs = toEpoch(event.startDate, tzidOf(event.startDate), context);
  const overridden = exceptions.some((exception) => recurrenceIdMs(exception, tzidOf(event.startDate), context) === masterStartMs);
  if (!overridden) addSingle(master, context, intervals);
  for (const exception of exceptions) addSingle(exception, context, intervals);
}

function recurrenceIdMs(exception: IcalComponent, masterTzid: string | undefined, context: ParseContext): number | undefined {
  const recurrenceId = exception.getFirstPropertyValue("recurrence-id") as IcalTime | null;
  if (!recurrenceId || typeof recurrenceId !== "object") return undefined;
  return toEpoch(recurrenceId, tzidOf(recurrenceId) ?? masterTzid, context);
}

function isThisAndFuture(exception: IcalComponent): boolean {
  const range = exception.getFirstProperty("recurrence-id")?.getParameter("range");
  return String(range ?? "").toUpperCase() === "THISANDFUTURE";
}

function parseRoot(ics: string): IcalComponent {
  let root: IcalComponent;
  try {
    root = new ICAL.Component(ICAL.parse(ics));
  } catch {
    throw new CalendarError("feed_invalid");
  }
  if (root.name !== "vcalendar") throw new CalendarError("feed_invalid");
  return root;
}

function embeddedTimezones(root: IcalComponent): Map<string, IcalTimezone> {
  const zones = new Map<string, IcalTimezone>();
  for (const component of root.getAllSubcomponents("vtimezone")) {
    try {
      const zone = new ICAL.Timezone(component);
      if (zone.tzid) zones.set(zone.tzid, zone);
    } catch {
      // An unusable VTIMEZONE only matters if an event references it, which
      // then fails conversion explicitly.
    }
  }
  return zones;
}

function safeEvent(component: IcalComponent): IcalEvent {
  try {
    return new ICAL.Event(component);
  } catch {
    throw new CalendarError("feed_invalid");
  }
}

function spend(budget: Budget): void {
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    throw new CalendarError("too_many_occurrences", `A calendar produced more than ${budget.limit} occurrences for the requested range.`);
  }
}

function classify(component: IcalComponent): BusyStatus | undefined {
  const status = String(component.getFirstPropertyValue("status") ?? "").toUpperCase();
  if (status === "CANCELLED") return undefined;
  const transparency = String(component.getFirstPropertyValue("transp") ?? "").toUpperCase();
  if (transparency === "TRANSPARENT") return undefined;
  return status === "TENTATIVE" ? "tentative" : "busy";
}

function tzidOf(time: IcalTime | null | undefined): string | undefined {
  if (!time) return undefined;
  const tzid = (time as { timezone?: string }).timezone;
  if (tzid) return tzid;
  const zoneId = time.zone?.tzid;
  return zoneId && zoneId !== "floating" ? zoneId : undefined;
}

function toEpoch(time: IcalTime, tzid: string | undefined, context: ParseContext): number {
  if (time.isDate) {
    return zonedTimeToEpoch(time.year, time.month, time.day, 0, 0, 0, context.defaultTimezone);
  }
  if (tzid === "UTC" || tzid === "Z" || time.zone?.tzid === "UTC") {
    return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  }
  if (tzid === undefined) {
    return zonedTimeToEpoch(time.year, time.month, time.day, time.hour, time.minute, time.second, context.defaultTimezone);
  }
  if (isValidTimeZone(tzid)) {
    return zonedTimeToEpoch(time.year, time.month, time.day, time.hour, time.minute, time.second, tzid);
  }
  const embedded = context.embeddedZones.get(tzid);
  if (embedded) {
    const local = time.clone();
    local.zone = embedded;
    return local.toUnixTime() * 1000;
  }
  throw new CalendarError("feed_invalid", "A calendar event uses an unknown timezone.");
}

function push(
  startMs: number,
  endMs: number,
  status: BusyStatus,
  context: ParseContext,
  intervals: EpochInterval[],
): void {
  const clipped = clipEpochInterval(
    { startMs, endMs, status, calendarIds: [context.calendarId] },
    context.rangeStartMs,
    context.rangeEndMs,
  );
  if (!clipped) return;
  spend(context.occurrences);
  intervals.push(clipped);
}

function addSingle(component: IcalComponent, context: ParseContext, intervals: EpochInterval[]): void {
  const status = classify(component);
  if (!status) return;
  const event = safeEvent(component);
  const start = event.startDate;
  if (!start) throw new CalendarError("feed_invalid");
  const startTzid = tzidOf(start);
  const startMs = toEpoch(start, startTzid, context);
  let endMs: number;
  const end = component.hasProperty("dtend") ? event.endDate : undefined;
  if (end) {
    endMs = toEpoch(end, tzidOf(end) ?? startTzid, context);
  } else if (component.hasProperty("duration")) {
    const computed = event.endDate;
    endMs = toEpoch(computed, startTzid, context);
  } else if (start.isDate) {
    const next = start.clone();
    next.adjust(1, 0, 0, 0);
    endMs = toEpoch(next, startTzid, context);
  } else {
    return;
  }
  push(startMs, endMs, status, context, intervals);
}

function expandRecurring(event: IcalEvent, exceptions: IcalComponent[], context: ParseContext, intervals: EpochInterval[]): void {
  const masterTzid = tzidOf(event.startDate);
  // Single-instance overrides are matched by instant, not by ICAL.js's string
  // comparison, so a UTC RECURRENCE-ID still matches a zoned series. Only
  // THISANDFUTURE overrides are delegated to ICAL.js, which shifts later
  // occurrences.
  const overrides = new Map<number, IcalComponent>();
  for (const exception of exceptions) {
    if (isThisAndFuture(exception)) {
      event.relateException(exception);
      continue;
    }
    const ms = recurrenceIdMs(exception, masterTzid, context);
    if (ms !== undefined && !overrides.has(ms)) overrides.set(ms, exception);
  }
  const used = new Set<IcalComponent>();

  let iterator: ReturnType<IcalEvent["iterator"]>;
  try {
    iterator = event.iterator();
  } catch {
    throw new CalendarError("feed_invalid");
  }
  for (;;) {
    let next: IcalTime | null;
    try {
      next = iterator.next();
    } catch {
      throw new CalendarError("feed_invalid");
    }
    if (!next) break;
    spend(context.iterations);
    const originalStartMs = toEpoch(next, masterTzid, context);
    if (originalStartMs >= context.rangeEndMs) break;
    const override = overrides.get(originalStartMs);
    if (override) {
      used.add(override);
      addSingle(override, context, intervals);
    } else {
      emitOccurrence(event, next, masterTzid, context, intervals);
    }
  }

  // Overrides not consumed above were moved from a slot after the range, or
  // no longer match a generated occurrence (for example after the series was
  // edited). Their own start and end still describe real busy time.
  for (const exception of overrides.values()) {
    if (!used.has(exception)) addSingle(exception, context, intervals);
  }
  // Exceptions without a usable RECURRENCE-ID are kept as standalone events.
  for (const exception of exceptions) {
    if (!isThisAndFuture(exception) && recurrenceIdMs(exception, masterTzid, context) === undefined) addSingle(exception, context, intervals);
  }
}

function emitOccurrence(
  event: IcalEvent,
  occurrence: IcalTime,
  masterTzid: string | undefined,
  context: ParseContext,
  intervals: EpochInterval[],
): void {
  let details: ReturnType<IcalEvent["getOccurrenceDetails"]>;
  try {
    details = event.getOccurrenceDetails(occurrence);
  } catch {
    throw new CalendarError("feed_invalid");
  }
  const item = details.item;
  const status = classify(item.component);
  if (!status) return;
  const isMaster = item === event;
  const startTzid = isMaster ? masterTzid : (tzidOf(item.startDate) ?? masterTzid);
  // ICAL.js derives occurrence ends from the start's wall clock plus the
  // event duration, so both ends are interpreted in the start's zone.
  const startMs = toEpoch(details.startDate, startTzid, context);
  const endMs = toEpoch(details.endDate, startTzid, context);
  push(startMs, endMs, status, context, intervals);
}
