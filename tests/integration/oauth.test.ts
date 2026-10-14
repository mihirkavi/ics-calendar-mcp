import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_ID,
  CLIENT_REDIRECT,
  CookieJar,
  ORIGIN,
  authorizeThroughGitHub,
  authorizeUrl,
  call,
  extractHandle,
  makeWorker,
  obtainToken,
  pkce,
  registerClient,
} from "./helpers";

const mcpPost = (token?: string) =>
  new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

describe("OAuth protection", () => {
  it("publishes RFC 9728 protected-resource metadata", async () => {
    const { worker } = makeWorker();
    const response = await call(worker, new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.resource).toBe(`${ORIGIN}/mcp`);
    expect(body.authorization_servers).toEqual([ORIGIN]);
    expect(body.scopes_supported).toEqual(["calendar:read"]);
  });

  it("publishes authorization server metadata with PKCE and registration", async () => {
    const { worker } = makeWorker();
    const response = await call(worker, new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ORIGIN);
    expect(body.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(body.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(body.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(body.code_challenge_methods_supported).toContain("S256");
  });

  it("challenges unauthenticated MCP calls without touching calendars", async () => {
    const fetchCalendar = vi.fn();
    const { worker } = makeWorker({ calendar: { fetchCalendar } });
    const response = await call(worker, mcpPost());
    expect(response.status).toBe(401);
    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(fetchCalendar).not.toHaveBeenCalled();
  });

  it("rejects invalid bearer tokens", async () => {
    const fetchCalendar = vi.fn();
    const { worker } = makeWorker({ calendar: { fetchCalendar } });
    const response = await call(worker, mcpPost("not-a-real-token"));
    expect(response.status).toBe(401);
    expect(fetchCalendar).not.toHaveBeenCalled();
  });

  it("requires PKCE", async () => {
    const { worker } = makeWorker();
    const clientId = await registerClient(worker);
    const url = authorizeUrl(clientId, "x");
    url.searchParams.delete("code_challenge");
    url.searchParams.delete("code_challenge_method");
    const response = await call(worker, new Request(url));
    expect([302, 400]).toContain(response.status);
    if (response.status === 302) expect(response.headers.get("Location")).toContain("error=");
  });

  it("rejects an unregistered redirect URI without redirecting to it", async () => {
    const { worker } = makeWorker();
    const clientId = await registerClient(worker);
    const url = authorizeUrl(clientId, (await pkce()).challenge);
    url.searchParams.set("redirect_uri", "https://attacker.example.test/cb");
    const response = await call(worker, new Request(url));
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("renders a framing-protected consent page that escapes client names", async () => {
    const { worker } = makeWorker();
    const response = await call(
      worker,
      new Request(`${ORIGIN}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "<script>alert(1)</script>", redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none" }),
      }),
    );
    const { client_id } = (await response.json()) as { client_id: string };
    const consent = await call(worker, new Request(authorizeUrl(client_id, (await pkce()).challenge)));
    const html = await consent.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("client.example.test");
    expect(consent.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("rejects a forged consent POST without the browser binding cookie (CSRF)", async () => {
    const { worker } = makeWorker();
    const clientId = await registerClient(worker);
    const consent = await call(worker, new Request(authorizeUrl(clientId, (await pkce()).challenge)));
    const handle = extractHandle(await consent.text());
    const forged = await call(
      worker,
      new Request(`${ORIGIN}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ handle, decision: "approve" }),
      }),
    );
    expect(forged.status).toBe(400);
    expect(forged.headers.get("Location")).toBeNull();
  });

  it("rejects a GitHub callback without the upstream binding cookie", async () => {
    const { worker } = makeWorker();
    const clientId = await registerClient(worker);
    const { github } = await authorizeThroughGitHub(worker, clientId, (await pkce()).challenge);
    expect(github.origin + github.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(github.searchParams.get("code_challenge_method")).toBe("S256");
    const replay = await call(worker, new Request(`${ORIGIN}/callback?code=x&state=${github.searchParams.get("state")}`));
    expect(replay.status).toBe(400);
  });

  it("denies a GitHub account with a different numeric ID", async () => {
    const { worker } = makeWorker({ userId: ALLOWED_ID + 1 });
    const clientId = await registerClient(worker);
    const { callback } = await authorizeThroughGitHub(worker, clientId, (await pkce()).challenge);
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(CLIENT_REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("lets the user deny consent", async () => {
    const { worker } = makeWorker();
    const clientId = await registerClient(worker);
    const jar = new CookieJar();
    const consent = await call(worker, new Request(authorizeUrl(clientId, (await pkce()).challenge)));
    jar.store(consent);
    const handle = extractHandle(await consent.text());
    const denied = await call(
      worker,
      new Request(`${ORIGIN}/authorize`, {
        method: "POST",
        headers: { Cookie: jar.header(), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ handle, decision: "deny" }),
      }),
    );
    expect(denied.status).toBe(302);
    expect(denied.headers.get("Location")).toContain("error=access_denied");
  });

  it("issues a token for the allowed account that reaches the MCP endpoint", async () => {
    const { worker } = makeWorker();
    const token = await obtainToken(worker);
    const response = await call(worker, mcpPost(token));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("get_free_busy");
  });

  it("rejects a valid token when the allowlist no longer matches", async () => {
    const fetchCalendar = vi.fn();
    const { worker } = makeWorker({ calendar: { fetchCalendar } });
    const token = await obtainToken(worker);
    const response = await call(worker, mcpPost(token), { ...(await import("./helpers")).baseEnv({ ALLOWED_GITHUB_USER_ID: "999" }) });
    expect(response.status).toBe(403);
    expect(fetchCalendar).not.toHaveBeenCalled();
  });
});
