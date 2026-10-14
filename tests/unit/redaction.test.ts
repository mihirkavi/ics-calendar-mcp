import { describe, expect, it } from "vitest";
import { CalendarError } from "../../src/errors";
import { redactError, scrubText } from "../../src/security/redaction";

describe("redaction", () => {
  it("removes URLs, query strings, and webcal links", () => {
    const text = scrubText("failed https://calendar.example.com/feed.ics?token=abc and webcal://calendar.example.com/x");
    expect(text).not.toContain("calendar.example.com");
    expect(text).not.toContain("token=abc");
  });

  it("removes authorization header values and long tokens", () => {
    // Built at runtime so the synthetic token never looks like a committed credential.
    const fakeToken = `gho_${"x".repeat(32)}`;
    const text = scrubText(`Authorization: Bearer abc.def.ghi token ${fakeToken}`);
    expect(text).not.toContain("abc.def.ghi");
    expect(text).not.toContain("gho_");
  });

  it("removes embedded usernames and passwords", () => {
    expect(scrubText("https://user:hunter2@calendar.example.com/")).not.toContain("hunter2");
  });

  it("removes ICS content", () => {
    expect(scrubText("bad: BEGIN:VEVENT\nSUMMARY:SECRET-TITLE\nEND:VEVENT")).not.toContain("SECRET-TITLE");
  });

  it("preserves stable codes for known errors", () => {
    expect(redactError(new CalendarError("feed_timeout"))).toEqual({ code: "feed_timeout", message: "A calendar feed did not respond in time." });
    expect(redactError(new CalendarError("invalid_input", "see https://calendar.example.com/x?token=1")).message).not.toContain("token");
  });

  it("maps unknown failures to a generic internal error", () => {
    const cause = new Error("boom https://calendar.example.com/feed.ics?token=SECRET");
    expect(redactError(cause)).toEqual({ code: "internal_error", message: "An internal error occurred." });
    expect(redactError({ toString: () => "SECRET" })).toEqual({ code: "internal_error", message: "An internal error occurred." });
  });
});
