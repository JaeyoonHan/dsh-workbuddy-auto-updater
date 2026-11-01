/**
 * Security and parsing primitives for dsh-workbuddy-auto-updater.
 *
 * Kept free of plugin wiring so every rule below is unit-testable on its own:
 * the local-request gate, strict semver quoting for anything that reaches the
 * filesystem or a child process, and a body reader that refuses cross-site
 * simple requests before parsing.
 *
 * @module dsh-workbuddy-auto-updater/guard
 */

import { isIP } from 'node:net';

/** An error carrying the HTTP status and machine-readable code to answer with. */
export class HttpError extends Error {
  /**
   * @param {number} status - HTTP status to respond with.
   * @param {string} code - stable machine-readable code.
   * @param {string} [message] - human-readable detail.
   */
  constructor(status, code, message) {
    super(message ?? code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Hostnames every browser treats as this machine. Kept in the bracketed IPv6
 * spelling the Host parser produces, so both sides of the comparison agree.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Whether a bare hostname is inside IPv4 loopback space (127.0.0.0/8). */
function isIpv4Loopback(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (match === null) return false;
  const parts = match.slice(1, 5);
  if (parts.some((part) => Number(part) > 255)) return false;
  if (parts.some((part) => part.length > 1 && part.startsWith('0'))) return false;
  return Number(parts[0]) === 127;
}

/** Whether a bare hostname names this machine by name or loopback literal. */
function isLocalHostname(hostname) {
  const name = hostname.endsWith('.') && !hostname.endsWith('..') ? hostname.slice(0, -1) : hostname;
  return LOOPBACK_HOSTS.has(name) || name === '::1' || isIpv4Loopback(name);
}

/**
 * Strip the optional `:port` from a Host header value, IPv6-bracket aware.
 * An unparseable value is returned unchanged so no caller can mistake it for a
 * trusted name.
 */
function hostnameOfHost(host) {
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    if (end === -1) return hostname;
    const after = hostname.slice(end + 1);
    if (after !== '' && !/^:\d+$/u.test(after)) return hostname;
    return hostname.slice(0, end + 1);
  }
  const colon = hostname.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/u.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
  return hostname;
}

/** Whether a value is a concrete IPv4 dotted quad or an IPv6 literal. */
function isIpLiteral(value) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255 && !(part.length > 1 && part.startsWith('0')));
  }
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return isIP(inner) === 6;
}

/**
 * Whether a Host header names the address this connection actually arrived on.
 *
 * "Must be loopback" is the wrong question: the harness refuses wildcard binds
 * but allows binding one concrete local address, and a user who binds their LAN
 * IP legitimately sends that IP in Host. So the question is "was this request
 * addressed to the socket it landed on?", which `req.socket.localAddress`
 * answers and a DNS-rebinding page cannot forge.
 *
 * @param {string | undefined} host - raw `host` header value.
 * @param {string | undefined} localAddress - `req.socket.localAddress`.
 * @returns {boolean} true when the Host header matches the bound interface.
 */
export function hostMatchesListener(host, localAddress) {
  if (host === undefined || host.trim() === '') return false;
  const hostname = hostnameOfHost(host);
  if (isLocalHostname(hostname)) return true;
  if (hostname === '0.0.0.0' || hostname === '[::]') return false;
  if (localAddress === undefined || localAddress.trim() === '') return false;
  const local = localAddress.trim().toLowerCase();
  if (!isIpLiteral(local) && !isIpLiteral(`[${local}]`)) return false;
  const bare = (value) =>
    value.startsWith('[') && value.endsWith(']') && isIP(value.slice(1, -1)) === 6 ? value.slice(1, -1) : value;
  return bare(hostname) === bare(local);
}

/**
 * Whether a browser-sent Origin may drive this route.
 *
 * An ABSENT Origin passes: that is the shape of a non-browser client (the
 * plugin's own fetch, curl, the tests). A PRESENT Origin must name this
 * machine, judged by the same rule as the Host header.
 *
 * @param {string | undefined} origin - raw `origin` header value.
 * @param {string | undefined} localAddress - `req.socket.localAddress`.
 * @returns {boolean} true when the Origin is absent or local.
 */
export function originIsLocal(origin, localAddress) {
  if (origin === undefined || origin.trim() === '') return true;
  try {
    const { hostname } = new URL(origin);
    const bare = hostname.startsWith('[') ? hostname : hostname.toLowerCase();
    if (isLocalHostname(bare)) return true;
    return hostMatchesListener(bare, localAddress);
  } catch {
    return false;
  }
}

/**
 * The full gate every route here must clear: Host AND Origin.
 *
 * Both halves are cheap and NEITHER IS AUTHENTICATION. A local process can send
 * whatever headers it likes; what these checks buy is that a BROWSER on a
 * foreign page cannot drive these routes (the browser chooses Origin for us,
 * and rebinding fails the Host comparison). State-changing routes add a
 * content-type requirement on top, which a cross-site form cannot satisfy
 * without a preflight this server never answers.
 *
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @returns {{ ok: true } | { ok: false, status: number, code: string }} the verdict.
 */
export function checkLocalRequest(req) {
  const localAddress = req.socket?.localAddress;
  if (!hostMatchesListener(req.headers.host, localAddress)) {
    return { ok: false, status: 403, code: 'host-not-trusted' };
  }
  if (!originIsLocal(req.headers.origin, localAddress)) {
    return { ok: false, status: 403, code: 'origin-not-trusted' };
  }
  return { ok: true };
}

/**
 * Read a JSON object body, refusing anything a cross-site \"simple request\"
 * could send.
 *
 * Requiring `application/json` is the CSRF defense that survives a spoofed
 * Origin: a browser cannot send that content type cross-origin without a
 * preflight, and the server answers no preflight. The size cap bounds memory.
 *
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @param {number} [limitBytes] - maximum accepted body size.
 * @returns {Promise<Record<string, unknown>>} the parsed object (empty for no body).
 * @throws {HttpError} 415 for a non-JSON content type, 413 over the cap, 400 for bad JSON.
 */
export function readJsonBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-type'];
    const type = typeof declared === 'string' ? declared.split(';')[0].trim().toLowerCase() : '';
    if (type !== 'application/json') {
      req.resume();
      reject(new HttpError(415, 'unsupported-media-type', 'content-type must be application/json'));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        fail(new HttpError(413, 'payload-too-large', 'request body exceeds the size limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(new HttpError(400, 'invalid-json', 'request body is not valid JSON'));
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        reject(new HttpError(400, 'body-not-object', 'request body must be a JSON object'));
        return;
      }
      resolve(parsed);
    });
    req.on('error', (error) => fail(new HttpError(400, 'request-error', String(error?.message ?? error))));
  });
}

/**
 * Full semver shape, prerelease and build metadata included.
 *
 * This pattern is also the QUOTING RULE for every version string that reaches a
 * child process: it admits only digits, ASCII letters, dots and hyphens, so a
 * registry answer can never contribute a shell metacharacter. Anything that
 * fails it is discarded instead of being handed on.
 */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/u;

/**
 * Parse a version string into comparable parts.
 * @param {unknown} text - candidate version.
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[], text: string } | undefined} parts, or undefined when malformed.
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  const match = VERSION_PATTERN.exec(trimmed);
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
    text: trimmed,
  };
}

/** Whether a string is a version this plugin will act on. */
export function isSafeVersion(text) {
  return parseVersion(text) !== undefined;
}

/** Compare two prerelease identifiers per semver: numeric first, then lexical. */
function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/u.test(a);
  const bNumeric = /^\d+$/u.test(b);
  if (aNumeric && bNumeric) {
    const left = Number(a);
    const right = Number(b);
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Compare two versions with full semver precedence, so a prerelease never
 * outranks the release it precedes.
 *
 * @param {string} a - left version.
 * @param {string} b - right version.
 * @returns {number | undefined} 1 when a>b, -1 when a<b, 0 when equal; undefined when either is malformed.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return undefined;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  const leftPre = left.prerelease;
  const rightPre = right.prerelease;
  if (leftPre.length === 0 && rightPre.length === 0) return 0;
  if (leftPre.length === 0) return 1;
  if (rightPre.length === 0) return -1;
  const length = Math.max(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftPre[index];
    const rightPart = rightPre[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const order = compareIdentifiers(leftPart, rightPart);
    if (order !== 0) return order;
  }
  return 0;
}
