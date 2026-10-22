# Security policy

Origin stores copies of AI agent session logs, which often contain source code, command output, personal information, and sometimes secrets. We take any issue that could expose, leak, or corrupt that data seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub's [private vulnerability reporting](https://github.com/openlinkos/origin/security/advisories/new) (the **Security** tab → **Report a vulnerability**).

Please include:

- a description of the issue and its impact;
- steps to reproduce, or a proof of concept that uses synthetic data only;
- the affected version or commit, OS, and Node.js version.

We will acknowledge your report, keep you updated on the fix, and credit you in the advisory unless you prefer otherwise.

## In scope

For example:

- Origin connecting anywhere other than the hub you configured, or sending data to any third party.
- A hub accepting a request without a valid token, or a push writing files outside the hub's mirror directory.
- The admin UI acting on a request without a valid admin session, accepting a cross-site request or a request without its CSRF token, accepting a hub token as an admin sign-in, or a hub endpoint accepting the admin password or an admin session.
- Script or markup from session logs, entries, or any other stored text running in the admin UI (cross-site scripting), or the admin UI loading anything from a third party.
- The admin UI showing the text of forgotten entries or events, or allowing events, raw mirrors, entries, or tombstones to be edited or deleted, a forget to be undone, a token to be shown again, or the admin password to be changed.
- The audit log being changed or deleted, or recording the text of entries or events.
- Reading or writing files outside the agent session directories and `ORIGIN_HOME` (for example, path traversal through crafted log file names).
- Forgotten data reappearing in query results, on the hub or on any device.
- Crafted session logs or replication requests that cause code execution or corrupt the store.

## Supported versions

Origin is pre-1.0. Only the latest commit on `master` receives fixes.
