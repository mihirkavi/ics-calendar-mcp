import { McpServer } from "@modelcontextprotocol/server";
import type { CalendarService } from "../calendars/service";
import { formatInTimeZone } from "../calendars/time";
import { redactError } from "../security/redaction";
import { describeAvailability, describeCalendars, describeSlots } from "./format";
import { findFreeSlotsInputSchema, freeBusyInputSchema, listCalendarsInputSchema } from "./schemas";

export const SERVER_NAME = "ics-calendar-mcp";
export const SERVER_VERSION = "0.1.0";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function errorResult(error: unknown) {
  const publicError = redactError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${publicError.code}: ${publicError.message}` }],
    structuredContent: { error: publicError },
  };
}

/** Creates a fresh MCP server exposing exactly three read-only tools. */
export function createServer(service: CalendarService, now: () => Date = () => new Date()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only calendar availability. Call list_calendars first to learn calendar IDs and the current time. Results never include event titles or details. If a result is marked incomplete, tell the user which calendars could not be read instead of treating them as free.",
    },
  );

  server.registerTool(
    "list_calendars",
    {
      title: "List calendars",
      description: "List the configured read-only calendars (ID, name, timezone) and the current time.",
      inputSchema: listCalendarsInputSchema,
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const calendars = service.listCalendars();
        const timezone = service.defaultTimezone();
        const currentTime = formatInTimeZone(now().getTime(), timezone);
        return {
          content: [{ type: "text" as const, text: describeCalendars(calendars, currentTime) }],
          structuredContent: { calendars, currentTime, timezone },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_free_busy",
    {
      title: "Get busy times",
      description:
        "Get merged busy intervals (start, end, busy/tentative only — no event details) across calendars for a time range, with per-calendar coverage. `complete: false` means some calendars could not be read.",
      inputSchema: freeBusyInputSchema,
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        const result = await service.getFreeBusy(input);
        return {
          content: [{ type: "text" as const, text: describeAvailability(result) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "find_free_slots",
    {
      title: "Find free time",
      description:
        "Find free windows of at least `durationMinutes` within daily working hours (default 09:00-17:00, weekdays) across calendars. Each slot is a whole free window, not a single meeting-sized block.",
      inputSchema: findFreeSlotsInputSchema,
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        const result = await service.findFreeSlots(input);
        return {
          content: [{ type: "text" as const, text: describeSlots(result) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
