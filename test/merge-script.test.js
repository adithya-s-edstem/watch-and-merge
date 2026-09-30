// Runs merge-when-approved.sh against a fake `gh` on PATH.
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'merge-when-approved.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-and-merge-sh-'));
const binDir = path.join(tmp, 'bin');
const stateDir = path.join(tmp, 'state');

// Fake gh: `pr view` prints the next line of views.txt (repeating the last one) as the script's
// "state<TAB>review<TAB>draft" row, or fails if view-error exists. `pr merge` fails if merge-error exists.
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, 'gh'), `#!/bin/sh
echo "$@" >> "$STATE/calls.log"
case "$1 $2" in
  "pr view")
    if [ -f "$STATE/view-error" ]; then echo "HTTP 502" >&2; exit 1; fi
    n=$(cat "$STATE/n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STATE/n"
    total=$(wc -l < "$STATE/views.txt")
    [ "$n" -gt "$total" ] && n=$total
    sed -n "\${n}p" "$STATE/views.txt"
    ;;
  "pr merge")
    if [ -f "$STATE/merge-error" ]; then echo "checks pending" >&2; exit 1; fi
    ;;
esac
`, { mode: 0o755 });

const tsv = (state, review, draft) => [state, review, draft].join('\t');

function setViews(...rows) {
  fs.writeFileSync(path.join(stateDir, 'views.txt'), rows.join('\n') + '\n');
}

// A PATH with `date` but no `gh`, for the missing-gh case
const noGhDir = path.join(tmp, 'no-gh');
fs.mkdirSync(noGhDir);
fs.symlinkSync(spawnSync('bash', ['-c', 'command -v date'], { encoding: 'utf8' }).stdout.trim(), path.join(noGhDir, 'date'));
const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();

function run(args, { withGh = true } = {}) {
  const PATH = withGh ? `${binDir}${path.delimiter}${process.env.PATH}` : noGhDir;
  return spawnSync(BASH, [SCRIPT, ...args], {
    env: { ...process.env, PATH, STATE: stateDir },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

const calls = () => {
  const f = path.join(stateDir, 'calls.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
};

beforeEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(stateDir);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('merge-when-approved.sh', () => {
  it('rejects a non-numeric or zero interval', () => {
    for (const interval of ['abc', '0', '-1', '1.5']) {
      const r = run(['1', 'o/r', interval]);
      assert.equal(r.status, 1, `interval ${interval}`);
      assert.match(r.stderr, /Interval must be a positive integer/);
    }
    assert.deepEqual(calls(), []);
  });

  it('exits 0 when the PR is already merged', () => {
    setViews(tsv('MERGED', 'APPROVED', 'false'));
    const r = run(['5', 'o/r', '1']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already merged/);
    assert.deepEqual(calls().filter(c => c.startsWith('pr merge')), []);
  });

  it('exits 1 when the PR is closed without merging', () => {
    setViews(tsv('CLOSED', 'APPROVED', 'false'));
    const r = run(['5', 'o/r', '1']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /closed without merging/);
    assert.deepEqual(calls().filter(c => c.startsWith('pr merge')), []);
  });

  it('merges (merge commit, delete branch) as soon as the PR is approved', () => {
    setViews(tsv('OPEN', 'APPROVED', 'false'));
    const r = run(['932', 'edstem-tech/stumped', '1']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Merged edstem-tech\/stumped#932/);
    assert.deepEqual(calls().filter(c => c.startsWith('pr merge')),
      ['pr merge 932 --repo edstem-tech/stumped --merge --delete-branch']);
  });

  it('keeps polling until the PR is approved', () => {
    setViews(tsv('OPEN', 'REVIEW_REQUIRED', 'false'), tsv('OPEN', 'APPROVED', 'false'));
    const r = run(['5', 'o/r', '1']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Not ready \(state=OPEN, review=REVIEW_REQUIRED, draft=false\)/);
    assert.equal(calls().filter(c => c.startsWith('pr view')).length, 2);
  });

  it('does not merge an approved draft', () => {
    // Draft first, then closed so the loop ends
    setViews(tsv('OPEN', 'APPROVED', 'true'), tsv('CLOSED', 'APPROVED', 'true'));
    const r = run(['5', 'o/r', '1']);
    assert.match(r.stdout, /Not ready \(state=OPEN, review=APPROVED, draft=true\)/);
    assert.deepEqual(calls().filter(c => c.startsWith('pr merge')), []);
  });

  it('keeps polling when the merge is blocked', () => {
    setViews(tsv('OPEN', 'APPROVED', 'false'), tsv('MERGED', 'APPROVED', 'false'));
    fs.writeFileSync(path.join(stateDir, 'merge-error'), '');
    const r = run(['5', 'o/r', '1']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Merge not possible yet: checks pending/);
    assert.equal(calls().filter(c => c.startsWith('pr merge')).length, 1);
  });

  it('retries after a gh error', () => {
    setViews(tsv('MERGED', 'APPROVED', 'false'));
    fs.writeFileSync(path.join(stateDir, 'view-error'), '');
    // Clear the error after the first attempt has had time to fail and sleep
    const child = spawn('bash', ['-c', `sleep 0.5; rm -f "${stateDir}/view-error"`]);
    const r = run(['5', 'o/r', '1']);
    child.kill();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /gh error: HTTP 502/);
  });

  it('fails cleanly when gh is not installed', () => {
    const r = run(['5', 'o/r', '1'], { withGh: false });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gh CLI not found/);
  });
});
