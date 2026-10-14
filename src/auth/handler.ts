import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { CalendarError } from "../errors";
import { renderConsentPage, renderErrorPage } from "./consent";
import { GITHUB_AUTHORIZE_URL, exchangeGitHubCode, fetchGitHubIdentity } from "./github";
import { assertAllowedIdentity } from "./policy";

export const CALENDAR_SCOPE = "calendar:read";

export interface AuthEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ALLOWED_GITHUB_USER_ID?: string;
}

/** Encrypted into each grant; available to the MCP handler as `ctx.props`. */
export interface AuthProps extends Record<string, unknown> {
  githubUserId: string;
  login: string;
}

interface UpstreamData {
  verifier: string;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function redirect(location: string, headers = new Headers()): Response {
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers });
}

function githubConfig(env: AuthEnv): { clientId: string; clientSecret: string } {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new CalendarError("internal_error", "GitHub sign-in is not configured.");
  }
  return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
}

/**
 * Handles the unprotected routes: the consent page at /authorize, the GitHub
 * callback, and a minimal landing page. Token, registration, and discovery
 * endpoints are served by the OAuth provider itself.
 */
export function createAuthHandler(options: { fetchImpl?: typeof fetch } = {}) {
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function authorize(request: Request, env: AuthEnv): Promise<Response> {
    const oauth = env.OAUTH_PROVIDER;
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      consent.headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; frame-ancestors 'none'");
      return new Response(renderConsentPage(details, consent.handle), { headers: consent.headers });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const { clientId } = githubConfig(env);
    const approved = await oauth.approveConsent(request, handle, { scope: [CALENDAR_SCOPE] });
    const verifier = randomVerifier();
    const upstream = await oauth.beginUpstream(approved.request, { data: { verifier } satisfies UpstreamData, headers: approved.headers });
    const target = new URL(GITHUB_AUTHORIZE_URL);
    target.searchParams.set("client_id", clientId);
    target.searchParams.set("redirect_uri", new URL("/callback", request.url).toString());
    target.searchParams.set("state", upstream.state);
    target.searchParams.set("code_challenge", await s256(verifier));
    target.searchParams.set("code_challenge_method", "S256");
    target.searchParams.set("allow_signup", "false");
    return redirect(target.toString(), upstream.headers);
  }

  async function callback(request: Request, env: AuthEnv): Promise<Response> {
    const oauth = env.OAUTH_PROVIDER;
    const resumed = await oauth.finishUpstream<UpstreamData>(request);
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error") || !code) {
      return redirect(authorizationErrorRedirect(resumed.request, "access_denied"), resumed.headers);
    }
    const github = githubConfig(env);
    let identity;
    try {
      const token = await exchangeGitHubCode(
        {
          code,
          verifier: resumed.data.verifier,
          clientId: github.clientId,
          clientSecret: github.clientSecret,
          redirectUri: new URL("/callback", request.url).toString(),
        },
        fetchImpl,
      );
      identity = await fetchGitHubIdentity(token, fetchImpl);
      assertAllowedIdentity(identity, env.ALLOWED_GITHUB_USER_ID);
    } catch (error) {
      const description = error instanceof CalendarError && error.code === "forbidden" ? "This account is not allowed." : "Sign-in failed.";
      return redirect(authorizationErrorRedirect(resumed.request, "access_denied", description), resumed.headers);
    }
    const props: AuthProps = { githubUserId: String(identity.id), login: identity.login };
    const { redirectTo } = await oauth.completeAuthorization({
      request: resumed.request,
      userId: props.githubUserId,
      metadata: {},
      scope: resumed.request.scope.filter((scope) => scope === CALENDAR_SCOPE),
      props,
    });
    return redirect(redirectTo, resumed.headers);
  }

  return {
    async fetch(request: Request, env: AuthEnv): Promise<Response> {
      const { pathname } = new URL(request.url);
      try {
        if (pathname === "/authorize") return await authorize(request, env);
        if (pathname === "/callback" && request.method === "GET") return await callback(request, env);
        if (pathname === "/" && request.method === "GET") {
          return new Response("ICS Calendar MCP: read-only calendar availability over MCP. Connect an MCP client to /mcp.\n", {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return new Response("Not found", { status: 404 });
      } catch (error) {
        if (error instanceof AuthorizationError && error.redirectTo) return redirect(error.redirectTo);
        if (error instanceof AuthorizationError) return renderErrorPage(error.description || "The authorization request is invalid or expired.");
        if (error instanceof CimdFetchError) return renderErrorPage("This app could not be verified.");
        if (error instanceof CalendarError) return renderErrorPage(error.publicMessage, 500);
        return renderErrorPage("An internal error occurred.", 500);
      }
    },
  };
}
