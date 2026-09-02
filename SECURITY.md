# Security policy

## Supported versions

Security fixes target `main` and the latest shipped Sub Rosa release. Older
releases may receive fixes when the impact warrants it.

## Reporting a vulnerability

Please do not file public issues for suspected vulnerabilities.

Use GitHub private vulnerability reporting on `Irdanwen/sub-rosa`. If it is not
available, contact a repository maintainer privately.

Sub Rosa is a fork; it is not maintained by, and reports to it do not reach,
the upstream project. A vulnerability in upstream June itself belongs on
upstream's tracker.

Include the affected component, reproduction steps, impact, and any relevant
logs or proof of concept. We will acknowledge the report, keep the discussion
private while we investigate, and coordinate disclosure timing with you.

## Scope

What the app protects, from whom, and what it deliberately does not, is written
out in [`docs/threat-model.md`](docs/threat-model.md). Read that first: it will
tell you whether a finding is in scope faster than this list does.

In scope:

- The desktop and iOS app: key storage, the local backend and its token, path
  handling, the updater, webview permissions, and the signed release flow.
- The local backend: authentication, model proxying, request validation, and
  logging.
- GitHub Actions, release automation, and signing material handling.

Out of scope:

- Social engineering.
- Denial of service without a clear security impact.
- Issues that require physical access to an already compromised device.
