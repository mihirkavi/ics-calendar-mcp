# Contributing

Thanks for your interest in improving ICS Calendar MCP.

## Ground rules

- **Read-only stays read-only.** Proposals that add calendar writes, arbitrary URL fetching, or event content in tool output will not be accepted in this project.
- **No real calendar data.** Tests and fixtures must use synthetic events. Never commit feed URLs, tokens, `.dev.vars`, or exports of real calendars.
- **Describe only what exists.** Documentation must match implemented behavior.

## Development

```bash
nvm use            # Node 24 (see .nvmrc); Node 22+ is required
npm install
npm run check
npm run lint
npm test
```

Tests run inside the Workers runtime with `@cloudflare/vitest-plugin` and never contact real calendar providers, GitHub, or any other network service.

## Pull requests

1. Open an issue first for behavior changes so we can agree on scope.
2. Add or update tests alongside the change; privacy-relevant changes need a test proving no event content leaks.
3. Keep `npm run check`, `npm run lint`, and `npm test` passing.
4. Update `CHANGELOG.md` under "Unreleased".

By contributing you agree that your contributions are licensed under the MIT License and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
