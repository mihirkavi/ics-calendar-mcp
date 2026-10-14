import { createExecutionContext, env as testEnv, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import type { CalendarServiceDependencies } from "../../src/calendars/service";
import { createWorker, type Env } from "../../src/index";

export const ORIGIN = "https://mcp.example.test";
export const CLIENT_REDIRECT = "https://client.example.test/callback";
export const ALLOWED_ID = 12345678;

export type Worker = ReturnType<typeof createWorker>;

export function baseEnv(overrides: Record<string, unknown> = {}): Env {
  return { ...(testEnv as unknown as Env), ...overrides } as Env;
}

export function githubMock(userId: number = ALLOWED_ID) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_upstream_token" });
    if (url === "https://api.github.com/user") return Response.json({ id: userId, login: "someone" });
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

export function makeWorker(options: { userId?: number; calendar?: Partial<CalendarServiceDependencies> } = {}) {
  const githubFetch = githubMock(options.userId);
  const worker = createWorker({ githubFetch, ...(options.calendar ? { calendar: options.calendar } : {}) });
  return { worker, githubFetch };
}

export async function call(worker: Worker, request: Request, env: Env = baseEnv()): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch!(request as never, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export class CookieJar {
  private readonly cookies = new Map<string, string>();
  store(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const index = pair!.indexOf("=");
      const name = pair!.slice(0, index).trim();
      const value = pair!.slice(index + 1).trim();
      if (/max-age=0/i.test(header) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

export async function registerClient(worker: Worker, env?: Env): Promise<string> {
  const response = await call(
    worker,
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Test Client", redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none" }),
    }),
    env,
  );
  if (response.status !== 201) throw new Error(`registration failed: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { client_id: string }).client_id;
}

export function authorizeUrl(clientId: string, challenge: string, scope = "calendar:read") {
  const url = new URL(`${ORIGIN}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", CLIENT_REDIRECT);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", "client-state");
  url.searchParams.set("resource", `${ORIGIN}/mcp`);
  if (scope) url.searchParams.set("scope", scope);
  return url;
}

export function extractHandle(html: string): string {
  const match = /name="handle" value="([^"]+)"/.exec(html);
  if (!match) throw new Error("no consent handle");
  return match[1]!.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));
}

/** Runs the full browser flow through consent and GitHub and returns the client redirect. */
export async function authorizeThroughGitHub(worker: Worker, clientId: string, challenge: string, env?: Env) {
  const jar = new CookieJar();
  const consent = await call(worker, new Request(authorizeUrl(clientId, challenge)), env);
  if (consent.status !== 200) throw new Error(`consent failed: ${consent.status} ${await consent.text()}`);
  jar.store(consent);
  const handle = extractHandle(await consent.text());
  const approve = await call(
    worker,
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: { Cookie: jar.header(), "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
      body: new URLSearchParams({ handle, decision: "approve" }),
    }),
    env,
  );
  if (approve.status !== 302) throw new Error(`approve failed: ${approve.status} ${await approve.text()}`);
  jar.store(approve);
  const github = new URL(approve.headers.get("Location")!);
  const state = github.searchParams.get("state")!;
  const callback = await call(worker, new Request(`${ORIGIN}/callback?code=upstream-code&state=${encodeURIComponent(state)}`, { headers: { Cookie: jar.header() } }), env);
  return { github, callback, jar };
}

export async function obtainToken(worker: Worker, env?: Env): Promise<string> {
  const clientId = await registerClient(worker, env);
  const { verifier, challenge } = await pkce();
  const { callback } = await authorizeThroughGitHub(worker, clientId, challenge, env);
  const redirect = new URL(callback.headers.get("Location")!);
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error(`no code: ${redirect}`);
  const tokenResponse = await call(
    worker,
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: CLIENT_REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${ORIGIN}/mcp`,
      }),
    }),
    env,
  );
  if (tokenResponse.status !== 200) throw new Error(`token failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  return ((await tokenResponse.json()) as { access_token: string }).access_token;
}
