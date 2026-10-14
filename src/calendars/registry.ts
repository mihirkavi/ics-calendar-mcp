import { z } from "zod";
import { CalendarError } from "../errors";
import type { CalendarBindings, CalendarDefinition, PublicCalendar } from "./types";
import { isValidTimeZone } from "./time";

/** Synthetic default registry. Operators override it with CALENDAR_REGISTRY. */
export const EXAMPLE_REGISTRY: readonly CalendarDefinition[] = [
  {
    id: "example-calendar",
    name: "Example Calendar",
    enabled: true,
    timezone: "America/New_York",
    secretBinding: "CALENDAR_EXAMPLE_ICS_URL",
    allowedHostname: "calendar.example.com",
  },
];

const definitionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    name: z.string().min(1).max(120),
    enabled: z.boolean().default(true),
    timezone: z.string().refine(isValidTimeZone, "invalid timezone"),
    secretBinding: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    allowedHostname: z
      .string()
      .min(1)
      .regex(/^[a-z0-9.-]+$/i)
      .transform((value) => value.toLowerCase()),
  })
  .strict();

const registrySchema = z
  .array(definitionSchema)
  .min(1)
  .max(50)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.id)) ctx.addIssue({ code: "custom", message: "duplicate calendar id" });
      seen.add(entry.id);
    }
  });

export class CalendarRegistry {
  private readonly byId: Map<string, CalendarDefinition>;

  constructor(readonly definitions: readonly CalendarDefinition[]) {
    this.byId = new Map(definitions.map((definition) => [definition.id, definition]));
  }

  getCalendar(id: string): CalendarDefinition | undefined {
    return this.byId.get(id);
  }

  listEnabledCalendars(): CalendarDefinition[] {
    return this.definitions.filter((definition) => definition.enabled);
  }
}

/**
 * Loads the registry from the CALENDAR_REGISTRY binding when present, otherwise
 * the synthetic example registry. Invalid configuration fails closed.
 */
export function loadRegistry(env: CalendarBindings): CalendarRegistry {
  const raw = env.CALENDAR_REGISTRY;
  if (raw === undefined || raw === null || raw === "") return new CalendarRegistry(EXAMPLE_REGISTRY);
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new CalendarError("calendar_not_configured", "The calendar registry is not valid JSON.");
  }
  const result = registrySchema.safeParse(parsed);
  if (!result.success) {
    throw new CalendarError("calendar_not_configured", "The calendar registry is invalid.");
  }
  return new CalendarRegistry(result.data);
}

export function toPublicCalendar(definition: CalendarDefinition): PublicCalendar {
  return {
    id: definition.id,
    name: definition.name,
    timezone: definition.timezone,
    capabilities: ["read_free_busy"],
  };
}

/** Validates a feed URL against the network policy shared with the fetcher. */
export function assertAllowedFeedUrl(url: URL, allowedHostname: string): void {
  if (url.protocol !== "https:") throw new CalendarError("calendar_not_configured");
  if (url.username !== "" || url.password !== "") throw new CalendarError("calendar_not_configured");
  if (url.port !== "") throw new CalendarError("calendar_not_configured");
  if (url.hostname.toLowerCase() !== allowedHostname.toLowerCase()) {
    throw new CalendarError("calendar_not_configured");
  }
}

export function resolveCalendarUrl(definition: CalendarDefinition, env: CalendarBindings): URL {
  const value = env[definition.secretBinding];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CalendarError("calendar_not_configured");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CalendarError("calendar_not_configured");
  }
  assertAllowedFeedUrl(url, definition.allowedHostname);
  return url;
}
