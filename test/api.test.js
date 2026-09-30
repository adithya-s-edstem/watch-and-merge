// Drives the real server over HTTP with a fake `gh` on PATH, so no GitHub access is needed.
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-and-merge-api-'));
const binDir = path.join(tmp, 'bin');
const ghDir = path.join(tmp, 'gh-state');
const dataFile = path.join(tmp, 'watches.json');
fs.mkdirSync(binDir);
fs.mkdirSync(ghDir);

// Fake gh: logs every call, answers `pr view` from view.json, and fails on demand.
// Flag files in FAKE_GH_DIR: view-error, merge-error, merge-delay (seconds to sleep).
fs.writeFileSync(path.join(binDir, 'gh'), `#!/bin/sh
echo "$@" >> "$FAKE_GH_DIR/calls.log"
case "$1 $2" in
  "pr view")
    if [ -f "$FAKE_GH_DIR/view-error" ]; then echo "HTTP 502" >&2; exit 1; fi
    cat "$FAKE_GH_DIR/view.json"
    ;;
  "pr merge")
    if [ -f "$FAKE_GH_DIR/merge-delay" ]; then sleep "$(cat "$FAKE_GH_DIR/merge-delay")"; fi
    if [ -f "$FAKE_GH_DIR/merge-error" ]; then echo "required checks pending" >&2; exit 1; fi
    ;;
esac
`, { mode: 0o755 });

process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
process.env.FAKE_GH_DIR = ghDir;
process.env.DATA_FILE = dataFile;

const { server, tick } = require('../server.js');

let base;

const flag = (name, on) => {
  const f = path.join(ghDir, name);
  if (on) fs.writeFileSync(f, typeof on === 'string' ? on : '');
  else fs.rmSync(f, { force: true });
};

const setView = (over = {}) => {
  fs.writeFileSync(path.join(ghDir, 'view.json'), JSON.stringify({
    state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', isDraft: false, title: 'A PR', mergeStateStatus: 'CLEAN', ...over,
  }));
};

const ghCalls = (verb) => {
  const f = path.join(ghDir, 'calls.log');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(l => l.startsWith(`pr ${verb} `));
};

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const list = async () => (await api('GET', '/api/watches')).body.watches;

async function find(number) {
  return (await list()).find(w => w.number === number);
}

// POST a watch and wait for the check that adding it kicks off to finish
async function watch(url, opts = {}) {
  const res = await api('POST', '/api/watches', { url, ...opts });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const number = Number(url.match(/(\d+)$/)[1]);
  for (let i = 0; i < 200; i++) {
    const w = await find(number);
    if (w && w.lastChecked && !w.checking) return w;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`watch for #${number} never settled`);
}

const recheck = async (id) => (await api('POST', `/api/watches/${id}/check`)).body;

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const w of await list()) await api('DELETE', `/api/watches/${w.id}`);
  for (const f of ['view-error', 'merge-error', 'merge-delay', 'calls.log']) flag(f, false);
  setView();
});

describe('static and listing', () => {
  it('serves the UI at / and /index.html', async () => {
    for (const p of ['/', '/index.html']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.match(await res.text(), /<html/i);
    }
  });

  it('lists no watches initially, with the poll interval', async () => {
    const { status, body } = await api('GET', '/api/watches');
    assert.equal(status, 200);
    assert.deepEqual(body.watches, []);
    assert.equal(typeof body.interval, 'number');
  });

  it('returns 404 JSON for unknown routes', async () => {
    const { status, body } = await api('GET', '/nope');
    assert.equal(status, 404);
    assert.ok(body.error);
  });
});

describe('POST /api/watches validation', () => {
  it('requires a url', async () => {
    for (const body of [{}, { url: '' }, { url: '   ' }, { url: 42 }]) {
      const res = await api('POST', '/api/watches', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error, /url is required/);
    }
  });

  it('rejects an unknown merge method', async () => {
    const res = await api('POST', '/api/watches', { url: 'o/r#1', mergeMethod: 'fast-forward' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /mergeMethod/);
  });

  it('rejects malformed JSON', async () => {
    const res = await api('POST', '/api/watches', '{not json');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Invalid JSON/);
  });

  it('rejects the whole request, adding nothing, if any entry is not a PR', async () => {
    const res = await api('POST', '/api/watches', { url: 'o/r#1 garbage' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /garbage/);
    assert.deepEqual(await list(), []);
  });
});

describe('adding watches', () => {
  it('adds several PRs separated by whitespace, commas and newlines', async () => {
    const res = await api('POST', '/api/watches', {
      url: 'o/r#1, https://github.com/o/r/pull/2\no/r#3   o/other#4',
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, { added: 4, skipped: 0 });
    const ws = await list();
    assert.deepEqual(ws.map(w => `${w.repo}#${w.number}`).sort(), ['o/other#4', 'o/r#1', 'o/r#2', 'o/r#3']);
  });

  it('skips duplicates, comparing the repo case-insensitively', async () => {
    await watch('Octo/Repo#5');
    const res = await api('POST', '/api/watches', { url: 'octo/repo#5 https://github.com/OCTO/REPO/pull/5 octo/repo#6' });
    assert.deepEqual(res.body, { added: 1, skipped: 2 });
    assert.equal((await list()).length, 2);
  });

  it('skips a duplicate within a single request', async () => {
    const res = await api('POST', '/api/watches', { url: 'o/r#8 o/r#8' });
    assert.deepEqual(res.body, { added: 1, skipped: 1 });
  });

  it('defaults to merge with branch deletion, and honours overrides', async () => {
    const a = await watch('o/r#1');
    assert.equal(a.mergeMethod, 'merge');
    assert.equal(a.deleteBranch, true);
    const b = await watch('o/r#2', { mergeMethod: 'rebase', deleteBranch: false });
    assert.equal(b.mergeMethod, 'rebase');
    assert.equal(b.deleteBranch, false);
  });

  it('never exposes the internal checking flag as anything but a boolean', async () => {
    const w = await watch('o/r#1');
    assert.equal(w.checking, false);
    assert.equal(w.url, 'https://github.com/o/r/pull/1');
  });

  it('persists watches to the data file', async () => {
    await watch('o/r#31');
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.deepEqual(saved.map(w => w.number), [31]);
  });
});

describe('checking a PR', () => {
  it('waits when the review is not approved, without merging', async () => {
    const w = await watch('o/r#1');
    assert.equal(w.status, 'waiting');
    assert.equal(w.title, 'A PR');
    assert.equal(ghCalls('merge').length, 0);
  });

  it('does not merge an approved draft', async () => {
    setView({ reviewDecision: 'APPROVED', isDraft: true });
    const w = await watch('o/r#1');
    assert.equal(w.status, 'waiting');
    assert.equal(ghCalls('merge').length, 0);
  });

  it('merges an approved PR using the chosen method and deleting the branch', async () => {
    setView({ reviewDecision: 'APPROVED' });
    const w = await watch('o/r#7', { mergeMethod: 'squash' });
    assert.equal(w.status, 'merged');
    assert.ok(w.mergedAt);
    assert.deepEqual(ghCalls('merge'), ['pr merge 7 --repo o/r --squash --delete-branch']);
  });

  it('omits --delete-branch when deleteBranch is false', async () => {
    setView({ reviewDecision: 'APPROVED' });
    await watch('o/r#7', { mergeMethod: 'rebase', deleteBranch: false });
    assert.deepEqual(ghCalls('merge'), ['pr merge 7 --repo o/r --rebase']);
  });

  it('keeps retrying an approved PR whose merge is blocked, then merges', async () => {
    setView({ reviewDecision: 'APPROVED' });
    flag('merge-error', true);
    const blocked = await watch('o/r#1');
    assert.equal(blocked.status, 'approved-waiting');
    assert.match(blocked.lastMessage, /required checks pending/);

    flag('merge-error', false);
    const merged = await recheck(blocked.id);
    assert.equal(merged.status, 'merged');
    assert.equal(ghCalls('merge').length, 2);
  });

  it('reports gh failures as an error and recovers on the next check', async () => {
    flag('view-error', true);
    const failed = await watch('o/r#1');
    assert.equal(failed.status, 'error');
    assert.match(failed.lastMessage, /HTTP 502/);

    flag('view-error', false);
    assert.equal((await recheck(failed.id)).status, 'waiting');
  });

  it('marks an already merged PR as merged without calling merge', async () => {
    setView({ state: 'MERGED', reviewDecision: 'APPROVED' });
    const w = await watch('o/r#1');
    assert.equal(w.status, 'merged');
    assert.equal(ghCalls('merge').length, 0);
  });

  it('marks a PR closed without merging as closed', async () => {
    setView({ state: 'CLOSED', reviewDecision: 'APPROVED' });
    const w = await watch('o/r#1');
    assert.equal(w.status, 'closed');
    assert.equal(ghCalls('merge').length, 0);
  });

  it('does not log identical "Not ready" messages repeatedly', async () => {
    const w = await watch('o/r#1');
    await recheck(w.id);
    const again = await recheck(w.id);
    assert.equal(again.log.filter(l => l.msg.startsWith('Not ready')).length, 1);
  });

  it('logs a new "Not ready" message when the state changes', async () => {
    const w = await watch('o/r#1');
    setView({ isDraft: true });
    const after = await recheck(w.id);
    assert.equal(after.log.filter(l => l.msg.startsWith('Not ready')).length, 2);
  });

  it('caps the per-watch log at 50 entries', async () => {
    const w = await watch('o/r#1');
    for (let i = 0; i < 60; i++) {
      await api('POST', `/api/watches/${w.id}/pause`);
    }
    const capped = await find(1);
    assert.equal(capped.log.length, 50);
    assert.equal(capped.lastMessage, 'Paused.');
  });

  it('merges only once when checks of the same PR overlap', async () => {
    setView({ reviewDecision: 'APPROVED' });
    flag('merge-delay', '0.3');
    const res = await api('POST', '/api/watches', { url: 'o/r#1' });
    assert.equal(res.status, 201);
    const [w] = await list();
    // The add already started a check; these must all join it
    await Promise.all([1, 2, 3].map(() => api('POST', `/api/watches/${w.id}/check`)));
    assert.equal(ghCalls('merge').length, 1);
    assert.equal((await find(1)).status, 'merged');
  });
});

describe('pause, resume, delete', () => {
  it('pauses and resumes a watch', async () => {
    const w = await watch('o/r#1');
    const paused = await api('POST', `/api/watches/${w.id}/pause`);
    assert.equal(paused.status, 200);
    assert.equal(paused.body.paused, true);

    setView({ reviewDecision: 'APPROVED' });
    const resumed = await api('POST', `/api/watches/${w.id}/resume`);
    assert.equal(resumed.body.paused, false);
    // resume triggers a check straight away
    for (let i = 0; i < 100 && (await find(1)).status !== 'merged'; i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    assert.equal((await find(1)).status, 'merged');
  });

  it('deletes a watch', async () => {
    const w = await watch('o/r#1');
    const res = await api('DELETE', `/api/watches/${w.id}`);
    assert.deepEqual(res.body, { ok: true });
    assert.deepEqual(await list(), []);
  });

  it('returns 404 for an unknown watch id', async () => {
    for (const [method, suffix] of [['DELETE', ''], ['POST', '/pause'], ['POST', '/resume'], ['POST', '/check']]) {
      const res = await api(method, `/api/watches/does-not-exist${suffix}`);
      assert.equal(res.status, 404, `${method} ${suffix}`);
    }
  });
});

describe('tick', () => {
  it('checks active watches but skips paused and finished ones', async () => {
    const active = await watch('o/r#1');
    const paused = await watch('o/r#2');
    await api('POST', `/api/watches/${paused.id}/pause`);
    setView({ state: 'MERGED' });
    const done = await watch('o/r#3');
    assert.equal(done.status, 'merged');

    flag('calls.log', false);
    setView();
    await tick();

    const viewed = fs.readFileSync(path.join(ghDir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(viewed.map(l => l.split(' ')[2]), ['1']);
    assert.equal((await find(1)).id, active.id);
  });

  it('merges a watch once it becomes approved', async () => {
    await watch('o/r#1');
    setView({ reviewDecision: 'APPROVED' });
    await tick();
    assert.equal((await find(1)).status, 'merged');
  });
});
