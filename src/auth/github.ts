import { CalendarError } from "../errors";

export interface GitHubIdentity {
  /** Immutable numeric account ID. */
  id: number;
  /** Mutable username, for display only. */
  login: string;
}

const MAX_PROFILE_BYTES = 64 * 1024;
const GITHUB_TIMEOUT_MS = 10_000;

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PROFILE_BYTES) throw new CalendarError("unauthorized");
  const text = await response.text();
  if (text.length > MAX_PROFILE_BYTES) throw new CalendarError("unauthorized");
  try {
    return JSON.parse(text);
  } catch {
    throw new CalendarError("unauthorized");
  }
}

function withTimeout(): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** Exchanges a GitHub authorization code (with PKCE verifier) for an access token. */
export async function exchangeGitHubCode(
  options: { code: string; verifier: string; clientId: string; clientSecret: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const timeout = withTimeout();
  try {
    const response = await fetchImpl(GITHUB_TOKEN_URL, {
      method: "POST",
      redirect: "error",
      signal: timeout.signal,
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code: options.code,
        redirect_uri: options.redirectUri,
        code_verifier: options.verifier,
      }),
    });
    if (!response.ok) throw new CalendarError("unauthorized");
    const body = (await boundedJson(response)) as { access_token?: unknown };
    if (typeof body.access_token !== "string" || body.access_token === "") throw new CalendarError("unauthorized");
    return body.access_token;
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    throw new CalendarError("unauthorized");
  } finally {
    timeout.done();
  }
}

/** Reads only the immutable ID and login from the GitHub profile. */
export async function fetchGitHubIdentity(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<GitHubIdentity> {
  const timeout = withTimeout();
  try {
    const response = await fetchImpl(GITHUB_USER_URL, {
      redirect: "error",
      signal: timeout.signal,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "ics-calendar-mcp",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new CalendarError("unauthorized");
    const profile = (await boundedJson(response)) as { id?: unknown; login?: unknown };
    if (typeof profile.id !== "number" || !Number.isSafeInteger(profile.id) || profile.id <= 0) {
      throw new CalendarError("unauthorized");
    }
    return { id: profile.id, login: typeof profile.login === "string" ? profile.login.slice(0, 64) : "" };
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    throw new CalendarError("unauthorized");
  } finally {
    timeout.done();
  }
}
