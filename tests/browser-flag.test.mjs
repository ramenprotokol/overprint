// The browser smoke test may skip on a machine without Chrome, but never in
// CI: with REQUIRE_BROWSER=1 a missing Chrome is a failure, not a skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { browserPlan, findChrome } from './cdp.mjs';
import { root } from './helpers.mjs';

const MISSING = join(root, 'no-such-dir', 'chrome');

test('an explicit CHROME_PATH that does not exist means “no Chrome”, not a silent fallback', () => {
  assert.equal(findChrome({ CHROME_PATH: MISSING }), null);
});

test('browserPlan: run with Chrome, skip without it, fail without it when REQUIRE_BROWSER=1', () => {
  assert.deepEqual(browserPlan('/opt/chrome', {}), { run: true });
  assert.deepEqual(browserPlan('/opt/chrome', { REQUIRE_BROWSER: '1' }), { run: true });
  const skip = browserPlan(null, {});
  assert.equal(typeof skip.skip, 'string');
  assert.match(skip.skip, /CHROME_PATH/);
  const fail = browserPlan(null, { REQUIRE_BROWSER: '1' });
  assert.equal(typeof fail.fail, 'string');
  assert.match(fail.fail, /REQUIRE_BROWSER=1/);
  assert.ok(browserPlan(null, { REQUIRE_BROWSER: '0' }).skip, 'only the exact value 1 makes it required');
});

function runBrowserTest(extraEnv) {
  const env = { ...process.env, CHROME_PATH: MISSING, ...extraEnv };
  if (!('REQUIRE_BROWSER' in extraEnv)) delete env.REQUIRE_BROWSER;
  // Strip the parent runner's context so the child is a plain, top-level test run.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(root, 'tests', 'browser.test.mjs')], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
}

test('end to end: a missing Chrome skips by default…', () => {
  const r = runBrowserTest({});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /# skipped 1/);
  assert.match(r.stdout, /# fail 0/);
});

test('…and fails the run when REQUIRE_BROWSER=1', () => {
  const r = runBrowserTest({ REQUIRE_BROWSER: '1' });
  assert.notEqual(r.status, 0, 'the run should fail');
  assert.match(r.stdout, /# fail 1/);
  assert.match(r.stdout, /REQUIRE_BROWSER=1/);
});
