/**
 * Host half of dsh-workbuddy-auto-updater.
 *
 * Polls the npm registry for a newer dsh-connect-workbuddy and installs it via
 * the bundled dsh CLI, then exposes state + manual controls over read/write
 * routes consumed by the settings card:
 *
 *   GET  /plugins/dsh-workbuddy-auto-updater/state   — status + recent log
 *   POST /plugins/dsh-workbuddy-auto-updater/check   — run a check now
 *   POST /plugins/dsh-workbuddy-auto-updater/config  — update enabled/interval
 *
 * It only replaces files; the running DSH keeps the old code until restarted.
 *
 * ## Trust model
 *
 * These routes are registered directly on `ctx.webServer`, which does NOT apply
 * the gateway's credential check — `/api/*` answers 401 unauthenticated while a
 * plugin route would answer 200. So this module carries its own gate, matching
 * the one the official dsh-connect-workbuddy uses:
 *
 *   - every route: Host must name the socket it landed on, and a present Origin
 *     must name this machine ({@link checkLocalRequest});
 *   - every write route: additionally `content-type: application/json`, which a
 *     cross-site form cannot produce without a preflight this server refuses.
 *
 * Neither half is authentication. A local process can forge both headers. What
 * they buy is that a BROWSER on a foreign page cannot spend the user's disk by
 * proxying a request through this listener, which is the reported bug: a
 * `text/plain` POST from any origin used to change the config.
 *
 * The version string that reaches the installer is validated against the semver
 * pattern before use, and the installer prefers a shell-free invocation, so a
 * compromised registry answer cannot become a command.
 *
 * @module dsh-workbuddy-auto-updater
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeCli, runDshCli } from './cli.js';
import { checkLocalRequest, compareVersions, HttpError, isSafeVersion, readJsonBody } from './guard.js';

export const name = 'dsh-workbuddy-auto-updater';
export const inject = ['webServer'];

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_NAME = 'dsh-connect-workbuddy';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const HOME_DIR = process.env.USERPROFILE || process.env.HOME || '';
const DSH_HOME = process.env.DSH_HOME || join(HOME_DIR, '.dsh');
const PROFILE_NAME = process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE_NAME);

const WORKSPACE_YAML = join(PROFILE_DIR, 'pnpm-workspace.yaml');
const INSTALLED_PKG_JSON = join(PROFILE_DIR, 'node_modules', PACKAGE_NAME, 'package.json');
const STATE_FILE = join(PLUGIN_DIR, 'state.json');
const LOG_DIR = join(PLUGIN_DIR, 'logs');
const LOG_FILE = join(LOG_DIR, 'updater.log');
const LOG_OLD_FILE = join(LOG_DIR, 'updater.old.log');

const LOG_ROTATE_BYTES = 1_000_000;
const MEMORY_LOG_LINES = 200;
const ROUTE_LOG_LINES = 80;
const STATE_VERSION = 1;

const DEFAULT_STATE = {
  config: { enabled: true, intervalHours: 24 },
  currentVersion: null,
  latestVersion: null,
  lastCheckAt: null,
  lastResult: null,
  lastMessage: null,
  lastError: null,
  installedAt: null,
  cli: null,
  running: false,
};

const state = structuredClone(DEFAULT_STATE);
const logLines = [];

/** Timestamp in the profile's local time, for the log file. */
function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** Append one line to the rotating log file, surfacing failures once. */
async function appendLog(line) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(LOG_FILE, `${line}\n`, 'utf8');
}

/**
 * Record one event: an in-memory ring for the card, and a line on disk.
 *
 * A disk failure is reported once per process to stderr rather than swallowed,
 * so a full or read-only plugin directory is diagnosable instead of invisible.
 */
let logFileFailureReported = false;
function log(message, level = 'INFO') {
  const line = `${timestamp()} [${level}] ${message}`;
  logLines.push(line);
  if (logLines.length > MEMORY_LOG_LINES) logLines.shift();
  appendLog(line).catch((error) => {
    if (logFileFailureReported) return;
    logFileFailureReported = true;
    console.error('[dsh-workbuddy-auto-updater] 无法写入日志文件:', error instanceof Error ? error.message : String(error));
  });
}

/** Rotate the log file when it grows past the cap. */
async function rotateLogIfNeeded() {
  try {
    const stats = await fs.stat(LOG_FILE);
    if (stats.size > LOG_ROTATE_BYTES) await fs.rename(LOG_FILE, LOG_OLD_FILE);
  } catch {
    /* no log file yet */
  }
}

/**
 * Write the state file atomically: a crash mid-write leaves the previous
 * document intact instead of a truncated one that the next load silently
 * discards.
 */
async function saveState() {
  const persisted = {
    version: STATE_VERSION,
    config: state.config,
    currentVersion: state.currentVersion,
    latestVersion: state.latestVersion,
    lastCheckAt: state.lastCheckAt,
    lastResult: state.lastResult,
    lastMessage: state.lastMessage,
    lastError: state.lastError,
    installedAt: state.installedAt,
  };
  await fs.mkdir(PLUGIN_DIR, { recursive: true });
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, STATE_FILE);
}

/** Load persisted state, clamping anything a hand edit could have broken. */
async function loadState() {
  let raw;
  try {
    raw = await fs.readFile(STATE_FILE, 'utf8');
  } catch {
    return;
  }
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    log('state.json 无法解析，已按首次运行处理', 'WARN');
    return;
  }
  if (typeof saved !== 'object' || saved === null) return;
  if (typeof saved.config === 'object' && saved.config !== null) {
    if (typeof saved.config.enabled === 'boolean') state.config.enabled = saved.config.enabled;
    const hours = Number(saved.config.intervalHours);
    state.config.intervalHours = Number.isFinite(hours) ? Math.min(168, Math.max(1, Math.round(hours))) : 24;
  }
  for (const key of ['currentVersion', 'latestVersion', 'lastResult']) {
    if (typeof saved[key] === 'string') state[key] = saved[key];
  }
  if (typeof saved.lastCheckAt === 'number' && Number.isFinite(saved.lastCheckAt)) state.lastCheckAt = saved.lastCheckAt;
  if (typeof saved.installedAt === 'number' && Number.isFinite(saved.installedAt)) state.installedAt = saved.installedAt;
}

/** The version currently on disk for the upstream package. */
async function readInstalledVersion() {
  const raw = await fs.readFile(INSTALLED_PKG_JSON, 'utf8');
  const parsed = JSON.parse(raw);
  const version = parsed?.version;
  if (!isSafeVersion(version)) throw new Error(`已装版本无法识别：${String(version)}`);
  return version;
}

/**
 * Seed the in-memory log ring from the log file on startup.
 *
 * Without this the ring starts empty on every launch, so the card's log panel
 * showed nothing after a restart even though the file was full — the history
 * was written but unreadable from the UI.
 */
async function loadLogTail() {
  let raw;
  try {
    raw = await fs.readFile(LOG_FILE, 'utf8');
  } catch {
    return;
  }
  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  logLines.push(...lines.slice(-MEMORY_LOG_LINES));
}

/**
 * Ask npm for the latest published version.
 *
 * The answer is validated before it is used for anything: a registry response
 * is network input, and every consumer below either writes it into a YAML file
 * or passes it to the installer.
 */
async function fetchLatestVersion() {
  const response = await fetch(REGISTRY_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
  const data = await response.json();
  const version = data?.version;
  if (!isSafeVersion(version)) throw new Error(`registry 返回了无法识别的版本：${String(version)}`);
  return version;
}

/**
 * Keep pnpm's minimumReleaseAge exclusion pointing at the version being
 * installed, so the install does not wait out the new-release cooldown.
 *
 * The replacement is anchored to this package: the previous pattern matched the
 * first `name@x.y.z` anywhere in the file, so an unrelated entry could be
 * rewritten.
 */
async function updateExclude(latest) {
  let yaml;
  try {
    yaml = await fs.readFile(WORKSPACE_YAML, 'utf8');
  } catch {
    log('pnpm-workspace.yaml 不存在，跳过 exclude 更新', 'WARN');
    return;
  }
  const pattern = /(dsh-connect-workbuddy@)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u;
  const found = pattern.exec(yaml);
  if (found === null) {
    log('yaml 中未找到 exclude 版本条目，跳过本步', 'WARN');
    return;
  }
  if (found[2] === latest) {
    log(`exclude 已指向 ${latest}，无需改动`);
    return;
  }
  const next = yaml.replace(pattern, `$1${latest}`);
  const temporary = `${WORKSPACE_YAML}.tmp`;
  await fs.writeFile(temporary, next, 'utf8');
  await fs.rename(temporary, WORKSPACE_YAML);
  log(`已更新 minimumReleaseAgeExclude -> ${latest}`);
}

/** Whether a check is in flight. */
let running = false;

/**
 * Run one check, optionally triggered by the user.
 *
 * Serialized: a second call while one runs is skipped, not queued.
 *
 * @param {boolean} manual - whether the user asked for this run.
 * @returns {Promise<void>} resolves when the run settled; never rejects.
 */
async function runCheck(manual) {
  if (running) {
    log('已有检查在进行，本次跳过', 'WARN');
    return;
  }
  running = true;
  state.running = true;
  try {
    await rotateLogIfNeeded();
    log(manual ? '手动检查开始' : '定时检查开始');
    const current = await readInstalledVersion();
    state.currentVersion = current;
    log(`当前已装版本：${current}`);

    const latest = await fetchLatestVersion();
    state.latestVersion = latest;
    state.lastCheckAt = Date.now();
    log(`npm 最新版本：${latest}`);

    const order = compareVersions(latest, current);
    if (order === undefined) throw new Error(`版本比较失败：${current} / ${latest}`);

    if (order <= 0) {
      log(`已是最新（${current}），无需更新`);
      state.lastResult = 'up-to-date';
      state.lastMessage = `已是最新 ${current}`;
      state.lastError = null;
    } else {
      log(`发现新版本：${current} -> ${latest}`);
      await updateExclude(latest);
      log(`执行：dsh plugin --profile ${PROFILE_NAME} add ${PACKAGE_NAME}@${latest}`);
      const output = await runDshCli(['plugin', '--profile', PROFILE_NAME, 'add', `${PACKAGE_NAME}@${latest}`], {
        cwd: PROFILE_DIR,
      });
      if (output !== '') log(`安装输出：${output}`);
      const after = await readInstalledVersion();
      if (after === latest) {
        log(`更新成功并验证：${after}（重启 DSH 后生效）`);
        state.currentVersion = after;
        state.installedAt = Date.now();
        state.lastResult = 'updated';
        state.lastMessage = `已更新 ${current} -> ${after}，重启后生效`;
        state.lastError = null;
      } else {
        log(`安装命令已执行但版本不符：期望 ${latest}，实际 ${after}`, 'ERROR');
        state.lastResult = 'failed';
        state.lastMessage = '安装后版本不符';
        state.lastError = `期望 ${latest}，实际 ${after}`;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`检查失败：${message}`, 'ERROR');
    state.lastResult = 'failed';
    state.lastMessage = '检查失败';
    state.lastError = message;
  } finally {
    running = false;
    state.running = false;
    await saveState().catch(() => {});
  }
}

let wakeTimer = null;
let intervalTimer = null;

/** Cancel both timers. */
function stopTimers() {
  if (wakeTimer !== null) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  if (intervalTimer !== null) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

/**
 * (Re)schedule automatic checks.
 *
 * A run is due when the last one is older than the configured interval, so a
 * machine that is only briefly awake still updates: the previous version armed
 * a fixed one-shot delay after every start and then relied on `setInterval`,
 * which never fires on a session shorter than the interval.
 *
 * Both timers are unref'd: they are background housekeeping and must never be
 * the reason a process stays alive, which matters for the app's own shutdown
 * and for anyone importing this module in a script.
 */
function startTimers() {
  stopTimers();
  if (!state.config.enabled) {
    log('自动检查已关闭');
    return;
  }
  const periodMs = state.config.intervalHours * 3_600_000;
  const elapsed = state.lastCheckAt === null ? Number.POSITIVE_INFINITY : Date.now() - state.lastCheckAt;
  const delay = Math.min(Math.max(periodMs - elapsed, 30_000), periodMs);
  log(`自动检查已开启，每 ${state.config.intervalHours} 小时一次`);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void runCheck(false);
    intervalTimer = setInterval(() => void runCheck(false), periodMs);
    intervalTimer.unref?.();
  }, delay);
  wakeTimer.unref?.();
}

/** The document the settings card renders. */
function publicState() {
  return {
    config: state.config,
    currentVersion: state.currentVersion,
    latestVersion: state.latestVersion,
    lastCheckAt: state.lastCheckAt,
    lastResult: state.lastResult,
    lastMessage: state.lastMessage,
    lastError: state.lastError,
    installedAt: state.installedAt,
    running: state.running,
    cli: state.cli,
    recentLogs: logLines.slice(-ROUTE_LOG_LINES),
  };
}

/** Answer with JSON and no caching. */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

/**
 * Answer a failed guard or handler with a JSON error.
 * @param {import('node:http').ServerResponse} res - response to write.
 * @param {unknown} error - thrown value.
 */
function sendError(res, error) {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.code, message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 500, { error: 'internal-error', message });
}

/**
 * Wrap a route handler with the local-request gate and JSON error mapping.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler - route body.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} the guarded handler.
 */
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
      sendError(res, error);
    }
  };
}

export function apply(ctx) {
  const disposers = [];

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-workbuddy-auto-updater/state',
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed');
        sendJson(res, 200, publicState());
      }),
    }),
  );

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-workbuddy-auto-updater/check',
      handler: guarded(async (req, res) => {
        if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed');
        await readJsonBody(req);
        if (running) throw new HttpError(409, 'check-already-running');
        void runCheck(true);
        sendJson(res, 202, { started: true });
      }),
    }),
  );

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-workbuddy-auto-updater/config',
      handler: guarded(async (req, res) => {
        if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed');
        const body = await readJsonBody(req);
        let changed = false;
        if (typeof body.enabled === 'boolean') {
          state.config.enabled = body.enabled;
          changed = true;
        }
        if (body.intervalHours !== undefined) {
          const hours = Number(body.intervalHours);
          if (!Number.isFinite(hours)) throw new HttpError(400, 'invalid-interval');
          state.config.intervalHours = Math.min(168, Math.max(1, Math.round(hours)));
          changed = true;
        }
        if (!changed) throw new HttpError(400, 'no-valid-fields');
        await saveState();
        startTimers();
        sendJson(res, 200, publicState());
      }),
    }),
  );

  ctx.effect(() => {
    Promise.all([loadState(), loadLogTail()])
      .then(() => {
        state.cli = describeCli();
        startTimers();
      })
      .catch((error) => log(`初始化失败：${error instanceof Error ? error.message : String(error)}`, 'ERROR'));
    return () => {
      stopTimers();
      for (const dispose of disposers.splice(0)) dispose();
    };
  }, 'dsh-workbuddy-auto-updater: lifecycle');
}
