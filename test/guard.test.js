/**
 * The gate a foreign page must not pass, and the version quoting that keeps a
 * registry answer out of a shell.
 *
 * The CSRF case is the regression this suite exists for: a `text/plain` POST
 * from an arbitrary origin changed the config, because the route read the body
 * without checking either the content type or where the request came from.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import {
  checkLocalRequest,
  compareVersions,
  hostMatchesListener,
  HttpError,
  isSafeVersion,
  originIsLocal,
  parseVersion,
  readJsonBody,
} from '../lib/guard.js';

/** A minimal request stub carrying only what the guard reads. */
function request({ headers = {}, localAddress = '127.0.0.1', body = '', method = 'POST' } = {}) {
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')]);
  stream.method = method;
  stream.headers = headers;
  stream.socket = { localAddress };
  return stream;
}

test('the plugin own request passes the gate', () => {
  const req = request({ headers: { host: '127.0.0.1:51597', origin: 'http://127.0.0.1:51597' } });
  assert.deepEqual(checkLocalRequest(req), { ok: true });
});

test('a cross-site origin is refused', () => {
  const req = request({ headers: { host: '127.0.0.1:51597', origin: 'https://evil.example' } });
  const verdict = checkLocalRequest(req);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 403);
  assert.equal(verdict.code, 'origin-not-trusted');
});

test('a DNS-rebinding Host is refused even when Origin is absent', () => {
  const req = request({ headers: { host: 'attacker.example:51597', origin: 'http://attacker.example:51597' } });
  const verdict = checkLocalRequest(req);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'host-not-trusted');
});

test('a missing Host is refused', () => {
  const verdict = checkLocalRequest(request({ headers: {} }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'host-not-trusted');
});

test('an absent Origin passes, because that is a non-browser client', () => {
  const verdict = checkLocalRequest(request({ headers: { host: '127.0.0.1:51597' } }));
  assert.deepEqual(verdict, { ok: true });
});

test('localhost and the bind literal both name this machine', () => {
  assert.equal(hostMatchesListener('localhost:51597', '127.0.0.1'), true);
  assert.equal(hostMatchesListener('127.0.0.1:51597', '127.0.0.1'), true);
  assert.equal(hostMatchesListener('[::1]:51597', '::1'), true);
  assert.equal(hostMatchesListener('192.168.1.5:51597', '192.168.1.5'), true);
  assert.equal(hostMatchesListener('192.168.1.6:51597', '192.168.1.5'), false);
  assert.equal(hostMatchesListener('0.0.0.0:51597', '0.0.0.0'), false);
});

test('a spoofed or unparseable origin is refused', () => {
  assert.equal(originIsLocal('https://evil.example', '127.0.0.1'), false);
  assert.equal(originIsLocal('null', '127.0.0.1'), false);
  assert.equal(originIsLocal('http://127.0.0.1:51597', '127.0.0.1'), true);
  assert.equal(originIsLocal(undefined, '127.0.0.1'), true);
});

test('a cross-site simple request cannot reach the body', async () => {
  const req = request({
    headers: { 'content-type': 'text/plain', host: '127.0.0.1:51597', origin: 'https://evil.example' },
    body: '{"intervalHours":1}',
  });
  await assert.rejects(readJsonBody(req), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 415);
    assert.equal(error.code, 'unsupported-media-type');
    return true;
  });
});

test('a JSON body is parsed, and a non-object is refused', async () => {
  const good = request({ headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"enabled":false}' });
  assert.deepEqual(await readJsonBody(good), { enabled: false });

  const array = request({ headers: { 'content-type': 'application/json' }, body: '[1,2]' });
  await assert.rejects(readJsonBody(array), (error) => error.code === 'body-not-object');

  const broken = request({ headers: { 'content-type': 'application/json' }, body: '{oops' });
  await assert.rejects(readJsonBody(broken), (error) => error.code === 'invalid-json');
});

test('an oversized body is refused', async () => {
  const req = request({ headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(4096) }) });
  await assert.rejects(readJsonBody(req, 1024), (error) => error.code === 'payload-too-large');
});

test('only strict semver is accepted for anything that leaves the process', () => {
  assert.equal(isSafeVersion('5.16.0'), true);
  assert.equal(isSafeVersion('5.16.0-rc.1'), true);
  assert.equal(isSafeVersion('5.16.0+build.7'), true);
  assert.equal(isSafeVersion('1.0.0&echo PWNED'), false);
  assert.equal(isSafeVersion('1.0.0" & echo PWNED'), false);
  assert.equal(isSafeVersion('1.0.0^&calc'), false);
  assert.equal(isSafeVersion('5.16'), false);
  assert.equal(isSafeVersion('latest'), false);
  assert.equal(isSafeVersion(''), false);
  assert.equal(isSafeVersion(undefined), false);
  assert.equal(isSafeVersion(519), false);
});

test('a prerelease never outranks the release it precedes', () => {
  assert.equal(compareVersions('5.17.0', '5.16.0'), 1);
  assert.equal(compareVersions('5.16.0', '5.16.0'), 0);
  assert.equal(compareVersions('5.9.0', '5.10.0'), -1);
  assert.equal(compareVersions('5.16.0-rc.1', '5.16.0'), -1);
  assert.equal(compareVersions('5.16.0', '5.16.0-rc.1'), 1);
  assert.equal(compareVersions('5.17.0-rc.1', '5.16.0'), 1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-beta.1'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareVersions('garbage', '1.0.0'), undefined);
});

test('parseVersion exposes the parts the comparer uses', () => {
  assert.deepEqual(parseVersion('5.16.0-rc.1'), {
    major: 5,
    minor: 16,
    patch: 0,
    prerelease: ['rc', '1'],
    text: '5.16.0-rc.1',
  });
  assert.equal(parseVersion('nope'), undefined);
});
