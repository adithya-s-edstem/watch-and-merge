#!/usr/bin/env node
// Web UI for watching many PRs (across repos) and merging each once it is approved.
// Uses the authenticated `gh` CLI, like merge-when-approved.sh.
// Usage: npm start   (env: PORT=3000, INTERVAL=10 seconds)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PORT) || 3000;
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 3600;
// Poll period in seconds. INTERVAL sets it at startup; PUT /api/settings changes it until the next restart.
let interval = Number(process.env.INTERVAL) || 10;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'watches.json');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const METHODS = ['merge', 'squash', 'rebase'];
const DONE = ['merged', 'closed'];
const LOG_LIMIT = 50;

let watches = [];
try {
  watches = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const w of watches) w.checking = false;
} catch (err) {
  if (err.code !== 'ENOENT') console.error(`Could not read ${DATA_FILE}: ${err.message}`);
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(watches, null, 2));
}

function log(w, msg) {
  w.lastMessage = msg;
  w.log.push({ time: new Date().toISOString(), msg });
  if (w.log.length > LOG_LIMIT) w.log.splice(0, w.log.length - LOG_LIMIT);
  console.log(`[${new Date().toTimeString().slice(0, 8)}] ${w.repo}#${w.number}: ${msg}`);
}

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

// Accepts https://github.com/OWNER/REPO/pull/N[/...] or OWNER/REPO#N
function parsePr(input) {
  const s = input.trim();
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i);
  if (!m) m = s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

// Concurrent checks of the same PR share one in-flight run, so it is never merged twice
const inFlight = new Map();
function check(w) {
  if (!inFlight.has(w.id)) {
    inFlight.set(w.id, runCheck(w).finally(() => inFlight.delete(w.id)));
  }
  return inFlight.get(w.id);
}

async function runCheck(w) {
  w.checking = true;
  try {
    let info;
    try {
      const out = await gh(['pr', 'view', String(w.number), '--repo', w.repo,
        '--json', 'state,reviewDecision,isDraft,title,mergeStateStatus']);
      info = JSON.parse(out);
    } catch (err) {
      w.status = 'error';
      log(w, `gh error: ${err.message}`);
      return;
    }

    w.title = info.title;
    w.reviewDecision = info.reviewDecision || '';
    w.isDraft = info.isDraft;
    w.mergeStateStatus = info.mergeStateStatus;

    if (info.state === 'MERGED') {
      w.status = 'merged';
      log(w, 'PR is merged.');
      return;
    }
    if (info.state === 'CLOSED') {
      w.status = 'closed';
      log(w, 'PR is closed without merging. Stopped watching.');
      return;
    }

    if (info.reviewDecision === 'APPROVED' && !info.isDraft) {
      const args = ['pr', 'merge', String(w.number), '--repo', w.repo, `--${w.mergeMethod}`];
      if (w.deleteBranch) args.push('--delete-branch');
      try {
        await gh(args);
        w.status = 'merged';
        w.mergedAt = new Date().toISOString();
        log(w, `Approved. Merged (${w.mergeMethod}${w.deleteBranch ? ', branch deleted' : ''}).`);
      } catch (err) {
        // e.g. required checks still running or a merge conflict; keep polling
        w.status = 'approved-waiting';
        log(w, `Approved, but merge not possible yet: ${err.message}`);
      }
      return;
    }

    w.status = 'waiting';
    const msg = `Not ready (review=${info.reviewDecision || 'none'}, draft=${info.isDraft})`;
    // Avoid flooding the log with identical "not ready" entries
    if (w.lastMessage !== msg) log(w, msg);
  } finally {
    w.checking = false;
    w.lastChecked = new Date().toISOString();
    save();
  }
}

let timer = null;
function startPolling() {
  clearInterval(timer);
  timer = setInterval(tick, interval * 1000);
}

function updateSettings(body) {
  const n = body.interval;
  if (!Number.isInteger(n) || n < MIN_INTERVAL || n > MAX_INTERVAL) {
    throw new HttpError(400, `interval must be a whole number of seconds from ${MIN_INTERVAL} to ${MAX_INTERVAL}`);
  }
  interval = n;
  // Only reschedule a running server; a required-in test process never started the timer
  if (timer) startPolling();
  console.log(`Checking every ${interval}s.`);
  return { interval };
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const w of [...watches]) {
      // Re-check each time: a watch may be paused or removed while earlier ones run
      if (w.paused || DONE.includes(w.status) || !watches.includes(w)) continue;
      await check(w);
    }
  } finally {
    ticking = false;
  }
}

function addWatches({ url, mergeMethod = 'merge', deleteBranch = true }) {
  if (typeof url !== 'string' || !url.trim()) throw new HttpError(400, 'url is required');
  if (!METHODS.includes(mergeMethod)) throw new HttpError(400, `mergeMethod must be one of ${METHODS.join(', ')}`);

  const lines = url.split(/[\n,\s]+/).map(s => s.trim()).filter(Boolean);
  const parsed = lines.map(line => ({ line, pr: parsePr(line) }));
  const invalid = parsed.filter(p => !p.pr).map(p => p.line);
  if (invalid.length) throw new HttpError(400, `Not a PR URL: ${invalid.join(', ')}`);

  const added = [];
  let skipped = 0;
  for (const { pr } of parsed) {
    if (watches.some(w => w.repo.toLowerCase() === pr.repo.toLowerCase() && w.number === pr.number)) {
      skipped++;
      continue;
    }
    const w = {
      id: crypto.randomUUID(),
      url: `https://github.com/${pr.repo}/pull/${pr.number}`,
      repo: pr.repo,
      number: pr.number,
      mergeMethod,
      deleteBranch: Boolean(deleteBranch),
      status: 'pending',
      paused: false,
      title: '',
      reviewDecision: '',
      isDraft: false,
      addedAt: new Date().toISOString(),
      lastChecked: null,
      lastMessage: '',
      log: [],
    };
    log(w, `Watching (merge method: ${mergeMethod}${w.deleteBranch ? ', delete branch' : ''}).`);
    watches.push(w);
    added.push(w);
  }
  save();
  for (const w of added) check(w);
  return { added: added.length, skipped };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) reject(new HttpError(413, 'Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const publicView = ({ checking, ...w }) => ({ ...w, checking: Boolean(checking) });

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(INDEX_FILE).pipe(res);
    }

    if (pathname === '/api/watches') {
      if (req.method === 'GET') return send(res, 200, { interval, watches: watches.map(publicView) });
      if (req.method === 'POST') return send(res, 201, addWatches(await readJson(req)));
    }

    if (pathname === '/api/settings') {
      if (req.method === 'GET') return send(res, 200, { interval });
      if (req.method === 'PUT') return send(res, 200, updateSettings(await readJson(req)));
    }

    const m = pathname.match(/^\/api\/watches\/([\w-]+)(?:\/(pause|resume|check))?$/);
    if (m) {
      const w = watches.find(w => w.id === m[1]);
      if (!w) throw new HttpError(404, 'Watch not found');
      const action = m[2];

      if (req.method === 'DELETE' && !action) {
        watches = watches.filter(x => x !== w);
        save();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && action === 'pause') {
        w.paused = true;
        log(w, 'Paused.');
        save();
        return send(res, 200, publicView(w));
      }
      if (req.method === 'POST' && action === 'resume') {
        w.paused = false;
        log(w, 'Resumed.');
        save();
        check(w);
        return send(res, 200, publicView(w));
      }
      if (req.method === 'POST' && action === 'check') {
        await check(w);
        return send(res, 200, publicView(w));
      }
    }

    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    send(res, err.status || 500, { error: err.message });
  }
});

if (require.main === module) {
  // Localhost only: the API merges PRs with your gh credentials
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Watch & merge UI on http://localhost:${PORT} (checking every ${interval}s)`);
    tick();
    startPolling();
  });
}

module.exports = { server, parsePr, tick };
