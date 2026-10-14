import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntimeHealth, RUNTIME_RESTART_HINT } from '../src/runtime-health.mjs';

const RUNNING = '0.2.0-beta.2.hiyori.5';
const UPDATED = '0.2.0-beta.2.hiyori.6';

function packageFixture(t, version = RUNNING) {
  const root = mkdtempSync(join(tmpdir(), 'whale-runtime-health-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageFile = join(root, 'package.json');
  const write = value => writeFileSync(packageFile, JSON.stringify({ name: 'whale_craft', version: value }));
  write(version);
  return { root, packageFile, write };
}

test('a fresh process reports matching disk and running versions', t => {
  const { root } = packageFixture(t);
  assert.deepEqual(createRuntimeHealth(RUNNING, root)(), {
    runningVersion: RUNNING, installedVersion: RUNNING, restartRequired: false,
  });
});

test('a replaced package reports the cached process needs to restart, using a file URL', t => {
  const { root } = packageFixture(t, UPDATED);
  assert.deepEqual(createRuntimeHealth(RUNNING, pathToFileURL(root))(), {
    runningVersion: RUNNING, installedVersion: UPDATED, restartRequired: true,
  });
  assert.match(RUNTIME_RESTART_HINT, /应用 → 退出/);
  assert.match(RUNTIME_RESTART_HINT, /X 只会隐藏窗口/);
});

test('missing, malformed and invalid package metadata do not claim an update', t => {
  const { root, packageFile, write } = packageFixture(t);
  const get = createRuntimeHealth(RUNNING, root, { cacheMs: 0 });
  for (const content of ['{', 'null', '{}', JSON.stringify({ version: 6 }), JSON.stringify({ version: 'broken' })]) {
    writeFileSync(packageFile, content);
    assert.deepEqual(get(), { runningVersion: RUNNING, installedVersion: null, restartRequired: false });
  }
  rmSync(packageFile);
  assert.equal(get().restartRequired, false);
  write(UPDATED);
  assert.equal(get().restartRequired, true);
});

test('cache refreshes at one second even when a larger TTL is requested', t => {
  const { root, write } = packageFixture(t);
  let time = 5000;
  const get = createRuntimeHealth(RUNNING, root, { cacheMs: 60000, now: () => time });
  const first = get();
  first.installedVersion = 'caller mutation';
  write(UPDATED);
  time += 999;
  assert.equal(get().installedVersion, RUNNING);
  time += 1;
  assert.deepEqual(get(), { runningVersion: RUNNING, installedVersion: UPDATED, restartRequired: true });
});

test('a failed read is temporary and the next cache refresh detects a repaired package', t => {
  const { root, packageFile, write } = packageFixture(t);
  let time = 100;
  writeFileSync(packageFile, '{');
  const get = createRuntimeHealth(RUNNING, pathToFileURL(root).href, { cacheMs: 250, now: () => time });
  assert.equal(get().installedVersion, null);
  write(UPDATED);
  time += 250;
  assert.equal(get().restartRequired, true);
});

test('a backwards clock cannot retain stale cache data indefinitely', t => {
  const { root, write } = packageFixture(t);
  let time = 1000;
  const get = createRuntimeHealth(RUNNING, root, { now: () => time });
  get();
  write(UPDATED);
  time = 500;
  assert.equal(get().installedVersion, UPDATED);
});
