import { z } from "zod";

const calendarIds = z
  .array(z.string().min(1).max(64))
  .max(50)
  .optional()
  .describe("Calendar IDs from list_calendars. Omit to use every enabled calendar.");

const timestamp = (what: string) =>
  z
    .string()
    .min(10)
    .max(40)
    .describe(
      `${what}: RFC 3339 timestamp (2026-10-14T09:00:00-07:00), local date-time (2026-10-14T09:00), or date (2026-10-14 = local midnight). Local values use \`timezone\`.`,
    );

const timezone = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe("IANA timezone such as America/Los_Angeles. Defaults to the first calendar's timezone.");

export const freeBusyInputSchema = z
  .object({
    calendarIds,
    start: timestamp("Inclusive range start"),
    end: timestamp("Exclusive range end (at most 93 days after start)"),
    timezone,
  })
  .strict();

export const findFreeSlotsInputSchema = z
  .object({
    calendarIds,
    start: timestamp("Inclusive search start"),
    end: timestamp("Exclusive search end (at most 93 days after start)"),
    timezone,
    durationMinutes: z.number().int().min(1).max(1440).describe("Minimum free-slot length in minutes."),
    bufferMinutes: z.number().int().min(0).max(240).optional().describe("Padding kept free before and after each busy interval. Default 0."),
    workingHours: z
      .object({
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe("Local start time, HH:mm."),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe("Local end time, HH:mm; must be after start."),
      })
      .strict()
      .optional()
      .describe("Daily window to search. Default 09:00-17:00."),
    includeWeekends: z.boolean().optional().describe("Search Saturdays and Sundays too. Default false."),
  })
  .strict();

export const listCalendarsInputSchema = z.object({}).strict();

export type FreeBusyToolInput = z.infer<typeof freeBusyInputSchema>;
export type FindFreeSlotsToolInput = z.infer<typeof findFreeSlotsInputSchema>;
