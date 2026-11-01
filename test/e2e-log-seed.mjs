/**
 * The card's log panel must survive a restart.
 *
 * Regression guard: the in-memory ring started empty on every launch, so a
 * restarted DSH showed an empty log even though `logs/updater.log` was full.
 * The fix seeds the ring from the file during startup.
 *
 * Run: node test/e2e-log-seed.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const work = await mkdtemp(join(tmpdir(), 'wbupd-'));
const home = join(work, 'home');
await mkdir(join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-connect-workbuddy'), { recursive: true });

// A profile with an installed upstream version, so the plugin can resolve one.
await writeFile(
  join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-connect-workbuddy', 'package.json'),
  JSON.stringify({ name: 'dsh-connect-workbuddy', version: '5.16.0' }),
  'utf8',
);

// Point the plugin at this fake home BEFORE importing it: the module reads the
// environment at import time to build its paths.
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.DSH_HOME;
delete process.env.DSH_PROFILE;

const pluginDir = join(work, 'plugin');
await mkdir(join(pluginDir, 'lib'), { recursive: true });

// The plugin resolves its own directory via dirname(dirname(import.meta.url)),
// i.e. it treats its `lib/` folder as the parent of the file. Mirror the real
// layout so the log path lands beside `lib/` and not one level too high.
const { copyFile } = await import('node:fs/promises');
for (const file of ['index.js', 'guard.js', 'cli.js']) {
  await copyFile(new URL(`../lib/${file}`, import.meta.url), join(pluginDir, 'lib', file));
}

// Seed a log file with history, as if a previous session had written it.
await mkdir(join(pluginDir, 'logs'), { recursive: true });
const history = [];
for (let index = 0; index < 12; index += 1) {
  history.push(`2026-11-01 10:${String(index).padStart(2, '0')}:00 [INFO] 历史日志第 ${index} 条`);
}
await writeFile(join(pluginDir, 'logs', 'updater.log'), `${history.join('\n')}\n`, 'utf8');

const routes = [];
const fakeCtx = {
  webServer: {
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  effect(factory) {
    factory();
    return () => {};
  },
};

const module = await import(pathToFileURL(join(pluginDir, 'lib', 'index.js')).href);
module.apply(fakeCtx);

// Let the startup promise chain settle.
await new Promise((resolve) => setTimeout(resolve, 300));

console.log('=== 1. The card reports the seeded history ===');
const stateRoute = routes.find((route) => route.path.endsWith('/state'));
assert.ok(stateRoute !== undefined, 'state route must be registered');

/** Minimal response recorder. */
function recorder() {
  const out = { status: 0, body: '' };
  return {
    out,
    writeHead(status) {
      out.status = status;
    },
    end(chunk) {
      out.body = chunk ?? '';
    },
  };
}

/** Minimal request for a loopback GET. */
function getRequest() {
  return { method: 'GET', url: '/plugins/dsh-workbuddy-auto-updater/state', headers: { host: '127.0.0.1:1' }, socket: { localAddress: '127.0.0.1' } };
}

const res = recorder();
await stateRoute.handler(getRequest(), res);
assert.equal(res.out.status, 200);
const payload = JSON.parse(res.out.body);
console.log('   recentLogs count:', payload.recentLogs.length);
assert.ok(payload.recentLogs.length >= 12, `expected the 12 seeded lines, got ${payload.recentLogs.length}`);
assert.ok(
  payload.recentLogs.some((line) => line.includes('历史日志第 0 条')),
  'the oldest seeded line must be present',
);
assert.ok(
  payload.recentLogs.some((line) => line.includes('历史日志第 11 条')),
  'the newest seeded line must be present',
);
console.log('   oldest line:', payload.recentLogs[0]);
console.log('   newest line:', payload.recentLogs.at(-1));
console.log();

console.log('=== 2. Startup appended its own line on top ===');
const startupLines = payload.recentLogs.filter((line) => line.includes('自动检查已开启'));
console.log('   startup lines:', startupLines.length);
assert.ok(startupLines.length >= 1, 'startup must log that auto-check is armed');
console.log();

console.log('=== 3. The ring is capped, never unbounded ===');
assert.ok(payload.recentLogs.length <= 200, 'the in-memory ring must stay bounded');
console.log('   ring size:', payload.recentLogs.length, '(cap 200)');
console.log();

await rm(work, { recursive: true, force: true });
console.log('ALL LOG-SEED ASSERTIONS PASSED');
process.exit(0);
