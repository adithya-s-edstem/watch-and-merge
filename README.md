# watch-and-merge

Watch GitHub pull requests across any number of repos and merge each one as soon as it's approved.

## Web UI

```sh
npm start            # http://localhost:3000
PORT=4000 INTERVAL=15 npm start
```

Paste one or more PR URLs (`https://github.com/owner/repo/pull/123` or `owner/repo#123`), pick a merge method, and click **Watch**. Every `INTERVAL` seconds (default 10) each PR is checked with `gh`:

- approved and not a draft → merged (retried each tick if checks or conflicts block it)
- merged or closed → watching stops
- otherwise → keeps waiting

Watches are saved to `watches.json`, so they survive restarts. The server only listens on `127.0.0.1`, because it merges with your `gh` credentials. Requires Node 18+ and an authenticated `gh` CLI; there are no npm dependencies.

## Tests

```sh
npm test
```

Uses Node's built-in test runner with a fake `gh`, so no GitHub access is needed. CI runs the same on Node 22.

## Single PR from the shell

```sh
./merge-when-approved.sh PR_NUMBER OWNER/REPO [INTERVAL_SECONDS]
```
