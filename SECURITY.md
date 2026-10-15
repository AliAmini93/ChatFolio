# Security Policy

## Supported releases

The published, supported stable release is currently **ChatFolio v1.8.11**.
The main branch contains ongoing architectural improvements that are **not**
published as a new stable version until release acceptance is complete.

## Report a vulnerability privately

ChatFolio processes potentially private AI conversations and provider media.
Please **do not** include user chats, PDFs, screenshots, authenticated links,
cookies, access tokens, or detailed working exploit payloads in public issues.

Use GitHub's **Report a vulnerability** / private vulnerability reporting
option for this repository if it is enabled under the Security tab. If that
option is unavailable, contact the maintainer through an appropriate
non-public channel first and ask how to share a minimal synthetic reproduction.
Do not assume that filing a public GitHub issue is private.

Useful initial report details are the affected ChatFolio version/commit, the
provider/platform, a concise impact description, and reproducibility with
synthetic non-sensitive input. Avoid sharing session details or credentials.

No fixed security response or patch timeline is promised.

## Security boundaries

- Exports run inside the local browser; the extension has no backend for
  storing conversations. Provider first-party resources may be requested
  during extraction, as explained in [PRIVACY.md](PRIVACY.md).
- Sanitization blocks active content before the print renderer, and ZIP
  packaging uses a strict allowlist. These safeguards do **not** replace
  ongoing audits, browser CSP, or live-provider testing.
- Never upload a real user's chat or authenticated browser profile to CI.
  Only synthetic fixtures belong in automated tests.
- Local live-provider QA reports are ignored in `.chatfolio-qa/` and must
  not be forced into Git history.
