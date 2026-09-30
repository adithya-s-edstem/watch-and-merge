const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// Keep the server from reading or writing the real watches.json on load
process.env.DATA_FILE = path.join(os.tmpdir(), `watch-and-merge-parse-${process.pid}.json`);
const { parsePr } = require('../server.js');

describe('parsePr', () => {
  it('parses a full PR URL', () => {
    assert.deepEqual(parsePr('https://github.com/octo/repo/pull/12'), { repo: 'octo/repo', number: 12 });
  });

  it('accepts http, www and a missing scheme', () => {
    const want = { repo: 'octo/repo', number: 7 };
    assert.deepEqual(parsePr('http://github.com/octo/repo/pull/7'), want);
    assert.deepEqual(parsePr('https://www.github.com/octo/repo/pull/7'), want);
    assert.deepEqual(parsePr('github.com/octo/repo/pull/7'), want);
  });

  it('ignores trailing path, query and fragment', () => {
    const want = { repo: 'octo/repo', number: 5 };
    assert.deepEqual(parsePr('https://github.com/octo/repo/pull/5/files'), want);
    assert.deepEqual(parsePr('https://github.com/octo/repo/pull/5?diff=split'), want);
    assert.deepEqual(parsePr('https://github.com/octo/repo/pull/5#issuecomment-1'), want);
  });

  it('parses the owner/repo#N shorthand', () => {
    assert.deepEqual(parsePr('octo/repo#99'), { repo: 'octo/repo', number: 99 });
  });

  it('allows dots, dashes and underscores in owner and repo names', () => {
    assert.deepEqual(parsePr('my-org/my_repo.js#3'), { repo: 'my-org/my_repo.js', number: 3 });
  });

  it('trims surrounding whitespace', () => {
    assert.deepEqual(parsePr('  octo/repo#1\n'), { repo: 'octo/repo', number: 1 });
  });

  it('preserves the repo casing it was given', () => {
    assert.equal(parsePr('Octo/Repo#1').repo, 'Octo/Repo');
  });

  it('rejects input that is not a PR reference', () => {
    for (const bad of [
      '',
      'octo/repo',
      'octo/repo#',
      'octo/repo#abc',
      '#12',
      'https://github.com/octo/repo',
      'https://github.com/octo/repo/issues/12',
      'https://gitlab.com/octo/repo/pull/12',
      'https://github.com/octo/repo/pull/',
      'not a url',
    ]) {
      assert.equal(parsePr(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});
