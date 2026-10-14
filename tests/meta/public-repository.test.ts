import { describe, expect, it } from "vitest";

// Loaded at build time by Vite so the test runs inside the Workers runtime.
const files = {
  ...import.meta.glob(["/*.md", "/LICENSE", "/.dev.vars.example", "/wrangler.jsonc", "/package.json", "/.github/**/*.yml"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob(["/src/**/*.ts", "/tests/**/*.ts", "/tests/fixtures/*.ics"], { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

const REQUIRED = ["/README.md", "/LICENSE", "/CONTRIBUTING.md", "/SECURITY.md", "/CHANGELOG.md", "/CODE_OF_CONDUCT.md", "/.github/workflows/ci.yml", "/.github/dependabot.yml", "/.dev.vars.example"];

const CREDENTIAL_PATTERNS: [string, RegExp][] = [
  ["GitHub token", /\bgh[opsu]_[A-Za-z0-9]{30,}\b/],
  ["GitHub OAuth client secret", /\b[0-9a-f]{40}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Cloudflare API token", /\b[A-Za-z0-9_-]{40}\b(?=.*cloudflare)/i],
  ["published iCloud calendar", /caldav\.icloud\.com\/published/i],
  ["webcal link", /webcal:\/\/(?!calendar\.example\.com)[^\s"'`)]+/i],
  ["secret-looking query token", /https:\/\/(?!calendar\.example\.com|mcp\.example\.test|client\.example\.test)[^\s"'`)]*\?[^\s"'`)]*(token|key|secret|sig)=/i],
];

describe("public repository hygiene", () => {
  it("contains the required files", () => {
    for (const path of REQUIRED) expect(Object.keys(files), path).toContain(path);
  });

  it("documents exactly the three implemented tools", () => {
    const readme = files["/README.md"]!;
    for (const tool of ["list_calendars", "get_free_busy", "find_free_slots"]) expect(readme).toContain(`\`${tool}\``);
    const registered = [...files["/src/mcp/server.ts"]!.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((match) => match[1]);
    expect(registered.sort()).toEqual(["find_free_slots", "get_free_busy", "list_calendars"]);
  });

  it("keeps example configuration synthetic", () => {
    const example = files["/.dev.vars.example"]!;
    for (const url of example.match(/https:\/\/[^\s"]+/g) ?? []) expect(new URL(url).hostname).toBe("calendar.example.com");
    expect(files["/wrangler.jsonc"]).toContain('"id": "00000000000000000000000000000000"');
  });

  it("contains no credentials or real subscription URLs", () => {
    for (const [path, content] of Object.entries(files)) {
      if (path === "/tests/meta/public-repository.test.ts") continue;
      for (const [label, pattern] of CREDENTIAL_PATTERNS) expect(pattern.test(content), `${label} in ${path}`).toBe(false);
    }
  });
});
