import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The Workers pool cannot read caches under paths containing spaces, so keep
  // the Vite cache in the OS temporary directory.
  cacheDir: join(tmpdir(), "ics-calendar-mcp-vite-cache"),
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          GITHUB_CLIENT_ID: "test-client-id",
          GITHUB_CLIENT_SECRET: "test-client-secret",
          ALLOWED_GITHUB_USER_ID: "12345678",
          CALENDAR_EXAMPLE_ICS_URL: "https://calendar.example.com/feeds/example.ics",
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    fsModuleCache: false,
  },
});
