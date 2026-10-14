import { describe, expect, it, vi } from "vitest";
import { CalendarError } from "../../src/errors";
import { fetchCalendar, MAX_FEED_BYTES } from "../../src/security/fetch-policy";

const HOST = "calendar.example.com";
const SECRET_URL = "https://calendar.example.com/private/feed.ics?token=SECRET-TOKEN-123";
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

function ok(body: BodyInit | null = ICS, init: ResponseInit = {}) {
  return vi.fn(async () => new Response(body, { status: 200, ...init }));
}

async function failure(promise: Promise<unknown>): Promise<CalendarError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CalendarError);
    expect(JSON.stringify({ message: (error as Error).message, stack: String((error as Error).stack) })).not.toContain("SECRET-TOKEN");
    return error as CalendarError;
  }
  throw new Error("expected rejection");
}

describe("fetchCalendar", () => {
  it("fetches HTTPS feeds with redirects disabled", async () => {
    const fetchImpl = ok();
    const result = await fetchCalendar(new URL(SECRET_URL), HOST, { fetchImpl, now: () => new Date("2026-10-14T00:00:00Z") });
    expect(result).toEqual({ body: ICS, fetchedAt: "2026-10-14T00:00:00.000Z" });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("normalizes mixed-case hostnames", async () => {
    await expect(fetchCalendar(new URL("https://Calendar.Example.COM/feed.ics"), "CALENDAR.example.com", { fetchImpl: ok() })).resolves.toBeDefined();
  });

  it.each([
    ["http", "http://calendar.example.com/feed.ics"],
    ["userinfo", "https://user:pw@calendar.example.com/feed.ics"],
    ["userinfo host trick", "https://calendar.example.com@evil.test/feed.ics"],
    ["suffix domain", "https://calendar.example.com.evil.test/feed.ics"],
    ["other host", "https://evil.test/feed.ics"],
  ])("rejects %s before any network call", async (_label, value) => {
    const fetchImpl = ok();
    const error = await failure(fetchCalendar(new URL(value), HOST, { fetchImpl }));
    expect(error.code).toBe("calendar_not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a redirect response as unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://evil.test/" } }));
    expect((await failure(fetchCalendar(new URL(SECRET_URL), HOST, { fetchImpl }))).code).toBe("feed_unavailable");
  });

  it("maps network errors that contain the URL to a generic error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${SECRET_URL}`);
    });
    const error = await failure(fetchCalendar(new URL(SECRET_URL), HOST, { fetchImpl }));
    expect(error.code).toBe("feed_unavailable");
  });

  it("aborts after the timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const error = await failure(fetchCalendar(new URL(SECRET_URL), HOST, { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 20 }));
    expect(error.code).toBe("feed_timeout");
  });

  it("rejects non-2xx responses without exposing the body", async () => {
    const fetchImpl = ok("SECRET-BODY", { status: 500 });
    const error = await failure(fetchCalendar(new URL(SECRET_URL), HOST, { fetchImpl }));
    expect(error.code).toBe("feed_unavailable");
    expect(error.message).not.toContain("SECRET-BODY");
  });

  it("rejects a missing body", async () => {
    expect((await failure(fetchCalendar(new URL(SECRET_URL), HOST, { fetchImpl: ok(null) }))).code).toBe("feed_invalid");
  });

  it("rejects non-calendar content", async () => {
    expect((await failure(fetchCalendar(new URL(SECRET_URL), HOST, { fetchImpl: ok("<html>login</html>") }))).code).toBe("feed_invalid");
  });

  it("rejects a declared oversize response", async () => {
    const fetchImpl = ok(ICS, { headers: { "Content-Length": String(MAX_FEED_BYTES + 1) } });
    expect((await failure(fetchCalendar(new URL(SECRET_URL), HOST, { fetchImpl }))).code).toBe("feed_too_large");
  });

  it("rejects a streamed body that crosses the limit", async () => {
    const chunk = new Uint8Array(1024).fill(65);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 10) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const error = await failure(fetchCalendar(new URL(SECRET_URL), HOST, { fetchImpl: ok(stream), maxBytes: 4096 }));
    expect(error.code).toBe("feed_too_large");
  });
});
