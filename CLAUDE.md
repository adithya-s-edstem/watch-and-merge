# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Watches GitHub PRs across repos and merges each once it is approved. It has two independent entry points, and both use the authenticated `gh` CLI for all GitHub access (no API tokens, no Octokit):

- `server.js` + `public/index.html`: a web UI for many PRs at once.
- `merge-when-approved.sh`: a standalone shell loop for a single PR. Its defaults (`PR=932`, `REPO=edstem-tech/stumped`, `INTERVAL=5`) are hard-coded.

## Commands

```sh
npm start                        # web UI on http://127.0.0.1:3000
PORT=4000 INTERVAL=15 npm start  # INTERVAL = poll period in seconds (default 10)
./merge-when-approved.sh PR_NUMBER OWNER/REPO [INTERVAL_SECONDS]
npm test                         # node --test over test/*.test.js
```

The project needs Node 18+ and has no npm dependencies, no build step and no linter. Keep it dependency-free: use only `node:` built-ins on the server and vanilla JS inline in `index.html`.

## Tests and CI

Tests use `node:test` and never touch GitHub: they put a fake `gh` script on `PATH`. `test/api.test.js` drives the server over HTTP (imported via `require('../server.js')`, which only listens when run directly; it exports `server`, `parsePr`, `tick`). `DATA_FILE` overrides the `watches.json` path, so tests must set it before requiring the server. `test/merge-script.test.js` runs the shell script. `.github/workflows/ci.yml` runs `npm test` on Node 18/20/22 plus `node --check`, `bash -n` and ShellCheck.

## Architecture (server.js)

- **State**: an in-memory `watches` array, written to `watches.json` (gitignored) by `save()` after every mutation and every check, and reloaded at startup. On load, `checking` is reset to false. `publicView()` strips internal fields before they go out in API responses.
- **Polling**: `tick()` runs every `INTERVAL` seconds. It checks the watches **one at a time**, skipping any that are paused, `merged`/`closed`, or removed mid-tick. The `ticking` flag prevents overlapping ticks.
- **No double merges**: `check(w)` puts concurrent checks of the same watch behind a single in-flight promise in the `inFlight` map. This covers the tick, the manual `/check` endpoint, resume, and newly added watches. Always call `check()`, never `runCheck()` directly.
- **Status lifecycle** (`w.status`): `pending` → `waiting` / `approved-waiting` (approved, but the merge was blocked by checks or conflicts, so it retries each tick) / `error` (the `gh` call failed, so it retries) → the terminal states `merged` / `closed`. A PR merges when `reviewDecision === 'APPROVED'` and it is not a draft.
- **Per-watch log**: `log(w, msg)` sets `lastMessage`, appends to `w.log` (capped at `LOG_LIMIT` = 50), and echoes to stdout. The repeated "Not ready" message is only logged when it changes.
- **HTTP API** (raw `node:http`, JSON; `HttpError` sets the status code):
  - `GET /api/watches` returns `{ interval, watches }`.
  - `POST /api/watches` takes `{ url, mergeMethod: merge|squash|rebase, deleteBranch }`. `url` can hold several PRs separated by whitespace, commas or newlines, each given as a `github.com/.../pull/N` URL or as `owner/repo#N`. Duplicates (repo compared case-insensitively) are skipped.
  - `DELETE /api/watches/:id`, and `POST /api/watches/:id/{pause|resume|check}`.
- **Security**: the server binds to `127.0.0.1` only, because anyone who can reach it can merge PRs with the user's `gh` credentials. Don't change this.

## Frontend

`public/index.html` is one self-contained page (inline CSS and JS). The server serves it for `/`; there is no other static serving. The page polls `GET /api/watches` every 3s and re-renders.
