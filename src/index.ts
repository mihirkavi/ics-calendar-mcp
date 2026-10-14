import { OAuthProvider, insufficientScope, type OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { CALENDAR_SCOPE, createAuthHandler, type AuthEnv } from "./auth/handler";
import { isAllowedUserId } from "./auth/policy";
import { createCalendarService, type CalendarServiceDependencies } from "./calendars/service";
import type { CalendarBindings } from "./calendars/types";
import { createServer } from "./mcp/server";

export interface Env extends AuthEnv, CalendarBindings {
  OAUTH_KV: KVNamespace;
  /** Optional canonical origin (https://host). Defaults to the request origin. */
  PUBLIC_BASE_URL?: string;
}

export interface WorkerDependencies {
  /** Overrides used by tests; production uses the real network. */
  calendar?: Partial<CalendarServiceDependencies>;
  githubFetch?: typeof fetch;
}

type ApiContext = ExecutionContext & { props?: Record<string, unknown>; auth?: OAuthResourceAuth };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export function createWorker(deps: WorkerDependencies = {}): ExportedHandler<Env> {
  const mcpApiHandler = {
    async fetch(request: Request, env: Env, ctx: ApiContext): Promise<Response> {
      const auth = ctx.auth;
      // Defense in depth: the grant was issued only to the allowed account, but
      // re-check the immutable ID and scope before any calendar code runs.
      if (!auth || !isAllowedUserId(ctx.props?.githubUserId, env.ALLOWED_GITHUB_USER_ID)) {
        return json(403, { error: "forbidden" });
      }
      if (!auth.scope.includes(CALENDAR_SCOPE)) return insufficientScope(auth, [CALENDAR_SCOPE]);
      const handler = createMcpHandler(() => createServer(createCalendarService(env, deps.calendar)), {
        route: "/mcp",
        corsOptions: false,
        authContext: { props: { githubUserId: ctx.props?.githubUserId } },
      });
      return handler(request, env, ctx);
    },
  };

  const authHandler = createAuthHandler(deps.githubFetch ? { fetchImpl: deps.githubFetch } : {});
  const providers = new Map<string, OAuthProvider<Env>>();

  function providerFor(origin: string): OAuthProvider<Env> {
    let provider = providers.get(origin);
    if (!provider) {
      provider = new OAuthProvider<Env>({
        apiRoute: "/mcp",
        apiHandler: mcpApiHandler as never,
        defaultHandler: authHandler as never,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register",
        clientIdMetadataDocumentEnabled: true,
        scopesSupported: [CALENDAR_SCOPE],
        requiredScopes: [CALENDAR_SCOPE],
        resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
        accessTokenTTL: 3600,
        onError: () => undefined,
      });
      providers.set(origin, provider);
    }
    return provider;
  }

  return {
    async fetch(request, env, ctx) {
      const origin = (env.PUBLIC_BASE_URL ?? new URL(request.url).origin).replace(/\/+$/, "").toLowerCase();
      return providerFor(origin).fetch(request, env, ctx);
    },
  };
}

export default createWorker();
