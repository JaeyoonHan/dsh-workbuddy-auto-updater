/**
 * End-to-end proof that the reported hole is closed.
 *
 * Boots a real node:http server with the same `guarded` wrapper and the same
 * three routes the plugin registers, then replays the attack that used to work
 * (a text/plain POST from a foreign Origin) plus a set of near-miss bypasses.
 *
 * Run: node test/e2e-hardening.mjs
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { checkLocalRequest, HttpError, readJsonBody } from '../lib/guard.js';

/** The in-memory config the routes mutate, standing in for the plugin state. */
const state = { config: { enabled: true, intervalHours: 24 }, checks: 0 };

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function guarded(handler) {
  return async (req, res) => {
    const verdict = checkLocalRequest(req);
    if (!verdict.ok) {
      sendJson(res, verdict.status, { error: verdict.code });
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof HttpError) sendJson(res, error.status, { error: error.code, message: error.message });
      else sendJson(res, 500, { error: 'internal-error', message: String(error?.message ?? error) });
    }
  };
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/plugins/dsh-workbuddy-auto-updater/state') {
    await guarded(async (r, s) => {
      if (r.method !== 'GET') throw new HttpError(405, 'method-not-allowed');
      sendJson(s, 200, state);
    })(req, res);
    return;
  }
  if (path === '/plugins/dsh-workbuddy-auto-updater/check') {
    await guarded(async (r, s) => {
      if (r.method !== 'POST') throw new HttpError(405, 'method-not-allowed');
      await readJsonBody(r);
      state.checks += 1;
      sendJson(s, 202, { started: true });
    })(req, res);
    return;
  }
  if (path === '/plugins/dsh-workbuddy-auto-updater/config') {
    await guarded(async (r, s) => {
      if (r.method !== 'POST') throw new HttpError(405, 'method-not-allowed');
      const body = await readJsonBody(r);
      if (typeof body.enabled === 'boolean') state.config.enabled = body.enabled;
      if (body.intervalHours !== undefined) {
        state.config.intervalHours = Math.min(168, Math.max(1, Math.round(Number(body.intervalHours))));
      }
      sendJson(s, 200, state);
    })(req, res);
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const ORIGIN = `http://127.0.0.1:${port}`;
console.log('listening on', ORIGIN, '\n');

/** Send one request and report what the server answered. */
async function probe(label, { method = 'GET', path = '/state', headers = {}, body, expected }) {
  const response = await fetch(ORIGIN + '/plugins/dsh-workbuddy-auto-updater' + path, { method, headers, body });
  const text = await response.text();
  const mark = response.status === expected ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}: ${response.status} (expected ${expected})  ${text.slice(0, 90)}`);
  assert.equal(response.status, expected, `${label}: expected ${expected}, got ${response.status} — ${text}`);
  return { status: response.status, text };
}

console.log('=== 1. The attack that used to work ===');
await probe('text/plain POST from foreign Origin (the reported bug)', {
  method: 'POST',
  path: '/config',
  headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
  body: JSON.stringify({ intervalHours: 1 }),
  expected: 403,
});
assert.equal(state.config.intervalHours, 24, 'config must be untouched after the attack');
console.log('  config still 24 ->', state.config.intervalHours, '\n');

console.log('=== 2. Near-miss bypasses ===');
await probe('no Origin, no content-type, foreign page form post', {
  method: 'POST',
  path: '/config',
  headers: {},
  body: 'intervalHours=1',
  expected: 415,
});
await probe('same-origin Origin but text/plain body', {
  method: 'POST',
  path: '/config',
  headers: { 'content-type': 'text/plain', origin: ORIGIN },
  body: JSON.stringify({ intervalHours: 1 }),
  expected: 415,
});
await probe('json content-type but foreign Origin', {
  method: 'POST',
  path: '/config',
  headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  body: JSON.stringify({ intervalHours: 1 }),
  expected: 403,
});
await probe('json content-type but DNS-rebinding Host', {
  method: 'POST',
  path: '/config',
  headers: { 'content-type': 'application/json', host: 'attacker.example', origin: 'http://attacker.example' },
  body: JSON.stringify({ intervalHours: 1 }),
  expected: 403,
});
await probe('trigger a real install via /check from a foreign page', {
  method: 'POST',
  path: '/check',
  headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
  body: '{}',
  expected: 403,
});
await probe('malformed JSON with correct headers', {
  method: 'POST',
  path: '/config',
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: '{oops',
  expected: 400,
});
console.log();

console.log('=== 3. The card itself still works ===');
await probe('GET state (no Origin, like a direct fetch)', { expected: 200 });
await probe('GET state from same origin', { headers: { origin: ORIGIN }, expected: 200 });
await probe('POST config from the card', {
  method: 'POST',
  path: '/config',
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: JSON.stringify({ intervalHours: 12 }),
  expected: 200,
});
assert.equal(state.config.intervalHours, 12, 'a legitimate write must land');
console.log('  config changed to 12 ->', state.config.intervalHours);
await probe('POST check from the card', {
  method: 'POST',
  path: '/check',
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: '{}',
  expected: 202,
});
assert.equal(state.checks, 1, 'a legitimate check must run exactly once');
console.log();

server.close();
console.log('ALL E2E ASSERTIONS PASSED');
