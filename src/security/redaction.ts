import { CalendarError, defaultMessage, type CalendarErrorCode } from "../errors";

export interface PublicError {
  code: CalendarErrorCode;
  message: string;
}

const URL_PATTERN = /\b(?:https?|webcal):\/\/[^\s"'<>]+/gi;
const BEARER_PATTERN = /\b(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]+/gi;
const ICS_PATTERN = /BEGIN:V(?:CALENDAR|EVENT|TODO|TIMEZONE)[\s\S]*/gi;
const SECRET_PATTERN = /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|[A-Za-z0-9_-]{48,})\b/g;

/** Removes URLs, credentials, and calendar content from a message. */
export function scrubText(text: string): string {
  return text
    .replace(ICS_PATTERN, "[calendar data]")
    .replace(URL_PATTERN, "[url]")
    .replace(BEARER_PATTERN, "[credential]")
    .replace(SECRET_PATTERN, "[redacted]")
    .slice(0, 300);
}

/**
 * Converts any thrown value into a public error. Known CalendarErrors keep
 * their code and scrubbed public message; their causes are never surfaced.
 * Unknown failures become a generic internal error.
 */
export function redactError(error: unknown): PublicError {
  if (error instanceof CalendarError) {
    return { code: error.code, message: scrubText(error.publicMessage) };
  }
  return { code: "internal_error", message: defaultMessage("internal_error") };
}
