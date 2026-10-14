export type CalendarErrorCode =
  | "invalid_input"
  | "unknown_calendar"
  | "calendar_not_configured"
  | "feed_unavailable"
  | "feed_too_large"
  | "feed_timeout"
  | "feed_invalid"
  | "too_many_occurrences"
  | "unauthorized"
  | "forbidden"
  | "internal_error";

const PUBLIC_MESSAGES: Record<CalendarErrorCode, string> = {
  invalid_input: "The request is invalid.",
  unknown_calendar: "A requested calendar is not configured.",
  calendar_not_configured: "A calendar feed is not configured correctly.",
  feed_unavailable: "A calendar feed could not be retrieved.",
  feed_too_large: "A calendar feed exceeded the size limit.",
  feed_timeout: "A calendar feed did not respond in time.",
  feed_invalid: "A calendar feed could not be parsed.",
  too_many_occurrences: "A calendar produced too many occurrences for the requested range.",
  unauthorized: "Authentication is required.",
  forbidden: "This account is not allowed to use this server.",
  internal_error: "An internal error occurred.",
};

/**
 * Error with a stable public code. `publicMessage` is safe to show to callers;
 * it must never contain URLs, secrets, or calendar content.
 */
export class CalendarError extends Error {
  readonly code: CalendarErrorCode;
  readonly publicMessage: string;

  constructor(code: CalendarErrorCode, publicMessage?: string) {
    const message = publicMessage ?? PUBLIC_MESSAGES[code];
    super(message);
    this.name = "CalendarError";
    this.code = code;
    this.publicMessage = message;
  }
}

export function defaultMessage(code: CalendarErrorCode): string {
  return PUBLIC_MESSAGES[code];
}
