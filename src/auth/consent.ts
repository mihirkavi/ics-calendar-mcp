import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `
  :root { color-scheme: light dark; --fg: #1d1d1f; --bg: #f5f5f7; --card: #fff; --muted: #6e6e73; --accent: #0a66c2; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --bg: #000; --card: #1c1c1e; --muted: #a1a1a6; --accent: #4ea1ff; } }
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 440px; margin: 10vh auto; padding: 28px; background: var(--card); border-radius: 16px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { margin: 8px 0; } .muted { color: var(--muted); font-size: 14px; }
  .warn { padding: 10px 12px; border-radius: 10px; background: rgba(255,159,10,.15); }
  button { font: inherit; padding: 10px 18px; border-radius: 10px; border: 0; cursor: pointer; margin-right: 8px; }
  .primary { background: var(--accent); color: #fff; } .secondary { background: transparent; color: var(--fg); border: 1px solid var(--muted); }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function renderConsentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? `<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>`
    : "";
  return page(
    `Authorize ${details.clientName}`,
    `<h1>Allow ${name} to read your calendar availability?</h1>
<p>${origin}</p>
<p>Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}
<p class="muted">Grants read-only busy/free times (scope <code>calendar:read</code>). Event titles, notes, attendees, and locations are never shared. You will sign in with GitHub next.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><button class="primary" name="decision" value="approve">Continue with GitHub</button><button class="secondary" name="decision" value="deny">Deny</button></p>
</form>`,
  );
}

export function renderErrorPage(message: string, status = 400): Response {
  return new Response(page("Authorization error", `<h1>Authorization failed</h1><p>${escape(message)}</p>`), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}
