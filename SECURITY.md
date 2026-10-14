# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository (Security tab → "Report a vulnerability"). Include steps to reproduce and the impact you observed. Do not include real calendar URLs or personal data in the report.

You can expect an acknowledgement within a week. Fixes are released as soon as practical and credited unless you prefer otherwise.

## Scope

In scope: anything that could expose event content, feed URLs, OAuth tokens, or calendar availability to an unauthorized party; bypasses of the fetch policy (SSRF); authentication or authorization bypasses; and denial of service through unbounded parsing.

Out of scope: vulnerabilities in a specific operator's deployment configuration (for example, a leaked secret) and issues in upstream dependencies that are already publicly tracked.

## Supported versions

Only the latest release receives security fixes.
