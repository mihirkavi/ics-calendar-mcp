import { CalendarError } from "../errors";
import { assertAllowedFeedUrl } from "../calendars/registry";

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_FEED_BYTES = 5 * 1024 * 1024;

export interface FetchedCalendar {
  body: string;
  fetchedAt: string;
}

export interface FetchCalendarOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => Date;
}

/**
 * Fetches a registered ICS feed under a strict policy: HTTPS only, exact
 * hostname, no credentials, no redirects, bounded time and size. Errors never
 * include the URL or any response content.
 */
export async function fetchCalendar(url: URL, allowedHostname: string, options: FetchCalendarOptions = {}): Promise<FetchedCalendar> {
  assertAllowedFeedUrl(url, allowedHostname);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_FEED_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "text/calendar, text/plain;q=0.5" },
      });
    } catch {
      throw new CalendarError(controller.signal.aborted ? "feed_timeout" : "feed_unavailable");
    }
    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      throw new CalendarError("feed_unavailable", "A calendar feed attempted to redirect.");
    }
    if (!response.ok) {
      await discard(response);
      throw new CalendarError("feed_unavailable");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await discard(response);
      throw new CalendarError("feed_too_large");
    }
    if (!response.body) throw new CalendarError("feed_invalid", "A calendar feed returned an empty response.");
    const bytes = await readBounded(response.body, maxBytes, controller.signal);
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      throw new CalendarError("feed_invalid", "A calendar feed is not valid UTF-8.");
    }
    if (!/^\s*BEGIN:VCALENDAR/i.test(body)) throw new CalendarError("feed_invalid");
    return { body, fetchedAt: (options.now?.() ?? new Date()).toISOString() };
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new CalendarError(signal.aborted ? "feed_timeout" : "feed_unavailable");
      }
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) throw new CalendarError("feed_too_large");
      chunks.push(result.value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore: the body is never read or surfaced.
  }
}
