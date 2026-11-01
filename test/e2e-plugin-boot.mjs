/**
 * Load the plugin the way DSH does and prove the wiring works.
 *
 * Stands in a fake cordis context exposing `webServer.register` and
 * `ctx.effect`, then asserts: apply() does not throw, exactly the three routes
 * are registered, the lifecycle disposer removes them, and a real request
 * through a real server is both blocked and allowed as expected.
 *
 * Run: node test/e2e-plugin-boot.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const module = await import('../lib/index.js');

console.log('=== 1. Export surface ===');
assert.equal(module.name, 'dsh-workbuddy-auto-updater');
assert.deepEqual(module.inject, ['webServer']);
assert.equal(typeof module.apply, 'function');
console.log('   name   :', module.name);
console.log('   inject :', module.inject.join(', '));
console.log('   apply  : function');
console.log();

console.log('=== 2. apply() against a cordis-like context ===');
const routes = [];
const effects = [];
const fakeCtx = {
  webServer: {
    register(route) {
      routes.push(route);
      return () => {
        const at = routes.indexOf(route);
        if (at !== -1) routes.splice(at, 1);
      };
    },
  },
  effect(factory) {
    effects.push(factory);
    return () => {};
  },
};

module.apply(fakeCtx);

console.log('   routes registered:', routes.length);
for (const route of routes) console.log('     -', route.kind, route.path);
assert.equal(routes.length, 3, 'exactly three routes must be registered');
const paths = routes.map((r) => r.path).sort();
assert.deepEqual(paths, [
  '/plugins/dsh-workbuddy-auto-updater/check',
  '/plugins/dsh-workbuddy-auto-updater/config',
  '/plugins/dsh-workbuddy-auto-updater/state',
]);
assert.equal(effects.length, 1, 'one lifecycle effect');
console.log();

console.log('=== 3. The lifecycle disposer removes every route ===');
const disposer = effects[0]();
console.log('   effect return value:', typeof disposer);
await disposer();
assert.equal(routes.length, 0, 'all routes must be disposed');
console.log('   routes after disposal:', routes.length);
console.log();

console.log('=== 4. Drive the real handlers over a real socket ===');
// Re-apply to get fresh routes, then serve them.
module.apply(fakeCtx);
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const route = routes.find((r) => r.path === path);
  if (route === undefined) {
    res.writeHead(404);
    res.end();
    return;
  }
  await route.handler(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const ORIGIN = `http://127.0.0.1:${port}`;
console.log('   serving on', ORIGIN);

async function call(label, { method = 'GET', path = '/state', headers = {}, body, expected }) {
  const response = await fetch(ORIGIN + '/plugins/dsh-workbuddy-auto-updater' + path, { method, headers, body });
  const text = await response.text();
  const ok = response.status === expected;
  console.log(`   [${ok ? 'PASS' : 'FAIL'}] ${label}: ${response.status} (want ${expected})`);
  assert.equal(response.status, expected, `${label}: ${text.slice(0, 120)}`);
}

await call('GET state', { expected: 200 });
await call('POST config, foreign origin', {
  method: 'POST',
  path: '/config',
  headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  body: JSON.stringify({ intervalHours: 1 }),
  expected: 403,
});
await call('POST config, text/plain', {
  method: 'POST',
  path: '/config',
  headers: { 'content-type': 'text/plain', origin: ORIGIN },
  body: JSON.stringify({ intervalHours: 1 }),
  expected: 415,
});
await call('POST check, foreign origin', {
  method: 'POST',
  path: '/check',
  headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
  body: '{}',
  expected: 403,
});
await call('PUT state (wrong method)', { method: 'PUT', expected: 405 });

// A real config write must be refused only on the guard, not on state: the
// interval must remain at its default because every attempt above failed.
const stateResponse = await fetch(ORIGIN + '/plugins/dsh-workbuddy-auto-updater/state');
const body = await stateResponse.json();
console.log('   intervalHours still:', body.config.intervalHours);
assert.equal(body.config.intervalHours, 24, 'no rejected write may change the config');
assert.equal(typeof body.cli, 'string', 'the card reports the resolved CLI');
console.log('   cli reported:', body.cli);
console.log();

server.close();
console.log('ALL BOOT ASSERTIONS PASSED');
