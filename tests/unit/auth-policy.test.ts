import { describe, expect, it, vi } from "vitest";
import { exchangeGitHubCode, fetchGitHubIdentity } from "../../src/auth/github";
import { assertAllowedIdentity, isAllowedUserId } from "../../src/auth/policy";
import { CalendarError } from "../../src/errors";
import { redactError } from "../../src/security/redaction";

function code(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return (error as CalendarError).code;
  }
  return undefined;
}

async function asyncCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CalendarError);
    expect(JSON.stringify(redactError(error))).not.toContain("gho_");
    return (error as CalendarError).code;
  }
  return undefined;
}

describe("assertAllowedIdentity", () => {
  it("accepts only the exact numeric ID", () => {
    expect(code(() => assertAllowedIdentity({ id: 12345678 }, "12345678"))).toBeUndefined();
    expect(code(() => assertAllowedIdentity({ id: 12345679 }, "12345678"))).toBe("forbidden");
    expect(code(() => assertAllowedIdentity({ id: 1234567 }, "12345678"))).toBe("forbidden");
  });

  it("fails closed when the allowlist is missing or malformed", () => {
    expect(code(() => assertAllowedIdentity({ id: 1 }, undefined))).toBe("forbidden");
    expect(code(() => assertAllowedIdentity({ id: 1 }, ""))).toBe("forbidden");
    expect(code(() => assertAllowedIdentity({ id: 1 }, "octocat"))).toBe("forbidden");
  });

  it("isAllowedUserId tolerates a changed login but not a different ID", () => {
    expect(isAllowedUserId("12345678", "12345678")).toBe(true);
    expect(isAllowedUserId(12345678, "12345678")).toBe(true);
    expect(isAllowedUserId("012345678", "12345678")).toBe(false);
    expect(isAllowedUserId("octocat", "12345678")).toBe(false);
    expect(isAllowedUserId(undefined, "12345678")).toBe(false);
  });
});

describe("fetchGitHubIdentity", () => {
  const respond = (body: unknown, init: ResponseInit = {}) =>
    vi.fn(async (url: RequestInfo | URL, requestInit?: RequestInit) => {
      new Request(url, requestInit); // runtime validation of fetch options
      return new Response(typeof body === "string" ? body : JSON.stringify(body), init);
    });

  it("returns only the immutable ID and login", async () => {
    const fetchImpl = respond({ id: 12345678, login: "renamed-user", email: "private@example.com", name: "Private Name" });
    await expect(fetchGitHubIdentity("gho_token", fetchImpl)).resolves.toEqual({ id: 12345678, login: "renamed-user" });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer gho_token");
  });

  it("rejects non-2xx, malformed, oversized, and ID-less profiles", async () => {
    expect(await asyncCode(fetchGitHubIdentity("gho_token", respond({ message: "Bad credentials" }, { status: 401 })))).toBe("unauthorized");
    expect(await asyncCode(fetchGitHubIdentity("gho_token", respond("not json")))).toBe("unauthorized");
    expect(await asyncCode(fetchGitHubIdentity("gho_token", respond({ login: "no-id" })))).toBe("unauthorized");
    expect(await asyncCode(fetchGitHubIdentity("gho_token", respond({ id: "12345678" })))).toBe("unauthorized");
    expect(await asyncCode(fetchGitHubIdentity("gho_token", respond({ id: 1, pad: "x".repeat(70_000) })))).toBe("unauthorized");
    expect(
      await asyncCode(
        fetchGitHubIdentity(
          "gho_token",
          vi.fn(async () => {
            throw new Error("network gho_token");
          }),
        ),
      ),
    ).toBe("unauthorized");
  });
});

describe("exchangeGitHubCode", () => {
  const options = { code: "c", verifier: "v", clientId: "id", clientSecret: "secret", redirectUri: "https://mcp.example.com/callback" };

  it("sends the PKCE verifier and returns the token", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      new Request(url, init); // runtime validation of fetch options
      return Response.json({ access_token: "gho_abc" });
    });
    await expect(exchangeGitHubCode(options, fetchImpl)).resolves.toBe("gho_abc");
    const body = String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(body).toContain("code_verifier=v");
  });

  it("rejects redirects and error responses", async () => {
    expect(await asyncCode(exchangeGitHubCode(options, vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } }))))).toBe("unauthorized");
    expect(await asyncCode(exchangeGitHubCode(options, vi.fn(async () => Response.json({ error: "bad_verification_code" }))))).toBe("unauthorized");
  });
});
