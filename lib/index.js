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
 * @module dsh-workbuddy-auto-updater
 */

import { promises as fs, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

export const name = 'dsh-workbuddy-auto-updater';
export const inject = ['webServer'];

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_NAME = 'dsh-connect-workbuddy';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const HOME_DIR = process.env.USERPROFILE || process.env.HOME || '';
const DSH_HOME = process.env.DSH_HOME || join(HOME_DIR, '.dsh');
const PROFILE_NAME = process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE_NAME);

/**
 * Locate the dsh CLI without hard-coding a drive letter.
 *
 * Resolution order:
 *   1. DSH_CLI env var (explicit override);
 *   2. Electron's process.resourcesPath (the plugin runs inside the DSH app);
 *   3. the folder next to the running executable;
 *   4. common install roots (Program Files, LocalAppData, D:\Programs).
 * Returns null when nothing is found; the install step then reports a clear error.
 */
function resolveDshCmd() {
  const candidates = [];
  if (process.env.DSH_CLI) candidates.push(process.env.DSH_CLI);
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'runtime', 'cli', 'bin', 'dsh.cmd'));
  }
  if (process.execPath) {
    candidates.push(join(dirname(process.execPath), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
  }
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LocalAppData,
    'D:\\Programs'
  ].filter(Boolean);
  // 安装目录名可能是无空格的 DeepSeekHarness 或带空格的 DeepSeek Harness，两种都探测
  const installDirs = ['DeepSeekHarness', 'DeepSeek Harness'];
  for (const root of roots) {
    for (const dir of installDirs) {
      candidates.push(join(root, dir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
    }
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* keep probing */
    }
  }
  return null;
}

const DSH_CMD = resolveDshCmd();
const WORKSPACE_YAML = join(PROFILE_DIR, 'pnpm-workspace.yaml');
const INSTALLED_PKG_JSON = join(PROFILE_DIR, 'node_modules', PACKAGE_NAME, 'package.json');
const STATE_FILE = join(PLUGIN_DIR, 'state.json');
const LOG_DIR = join(PLUGIN_DIR, 'logs');
const LOG_FILE = join(LOG_DIR, 'updater.log');
const LOG_OLD_FILE = join(LOG_DIR, 'updater.old.log');

const DEFAULT_STATE = {
  config: { enabled: true, intervalHours: 24 },
  currentVersion: null,
  latestVersion: null,
  lastCheckAt: null,
  lastResult: null,
  lastMessage: null,
  running: false
};

const state = structuredClone(DEFAULT_STATE);
const logLines = [];

/** Compare x.y.z versions: 1 if a>b, -1 if a<b, 0 if equal. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function appendLog(line) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(LOG_FILE, line + '\n', 'utf8');
}

/** Keep an in-memory ring (newest 200) and mirror to the rotating log file. */
function log(message, level = 'INFO') {
  const line = `${timestamp()} [${level}] ${message}`;
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  appendLog(line).catch(() => {});
}

async function rotateLogIfNeeded() {
  try {
    const st = await fs.stat(LOG_FILE);
    if (st.size > 1_000_000) await fs.rename(LOG_FILE, LOG_OLD_FILE);
  } catch {
    /* log does not exist yet */
  }
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    if (saved.config && typeof saved.config === 'object') {
      state.config.enabled = saved.config.enabled !== false;
      const hours = Number(saved.config.intervalHours);
      state.config.intervalHours = Number.isFinite(hours) ? Math.min(168, Math.max(1, hours)) : 24;
    }
    for (const key of ['currentVersion', 'latestVersion', 'lastCheckAt', 'lastResult', 'lastMessage']) {
      if (saved[key] !== void 0) state[key] = saved[key];
    }
  } catch {
    /* first run: keep defaults */
  }
}

async function saveState() {
  const persisted = {
    config: state.config,
    currentVersion: state.currentVersion,
    latestVersion: state.latestVersion,
    lastCheckAt: state.lastCheckAt,
    lastResult: state.lastResult,
    lastMessage: state.lastMessage
  };
  await fs.writeFile(STATE_FILE, JSON.stringify(persisted, null, 2), 'utf8');
}

async function readCurrentVersion() {
  const raw = await fs.readFile(INSTALLED_PKG_JSON, 'utf8');
  return JSON.parse(raw).version;
}

async function fetchLatestVersion() {
  const resp = await fetch(REGISTRY_URL, { headers: { accept: 'application/json' } });
  if (!resp.ok) throw new Error(`registry HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.version) throw new Error('registry returned no version');
  return data.version;
}

async function updateExclude(latest) {
  let yaml;
  try {
    yaml = await fs.readFile(WORKSPACE_YAML, 'utf8');
  } catch {
    log('pnpm-workspace.yaml 不存在，跳过 exclude 更新', 'WARN');
    return;
  }
  const re = /dsh-connect-workbuddy@\d+\.\d+\.\d+/;
  if (re.test(yaml)) {
    await fs.writeFile(WORKSPACE_YAML, yaml.replace(re, `${PACKAGE_NAME}@${latest}`), 'utf8');
    log(`已更新 minimumReleaseAgeExclude -> ${latest}`);
  } else {
    log('yaml 中未找到 exclude 版本条目，跳过本步', 'WARN');
  }
}

async function runDshInstall(latest) {
  if (!DSH_CMD) {
    throw new Error('未找到 dsh CLI，可设置环境变量 DSH_CLI 指向 dsh.cmd 后重试');
  }
  const spec = `${PACKAGE_NAME}@${latest}`;
  log(`执行：dsh plugin --profile ${PROFILE_NAME} add ${spec}`);
  const { stdout, stderr } = await execFileAsync(
    'cmd.exe',
    ['/c', DSH_CMD, 'plugin', '--profile', PROFILE_NAME, 'add', spec],
    { cwd: PROFILE_DIR, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }
  );
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

async function runCheck(manual) {
  if (state.running) {
    log('已有检查在进行，本次跳过', 'WARN');
    return;
  }
  state.running = true;
  try {
    await rotateLogIfNeeded();
    log(manual ? '手动检查开始' : '定时检查开始');
    const current = await readCurrentVersion();
    state.currentVersion = current;
    log(`当前已装版本：${current}`);
    const latest = await fetchLatestVersion();
    state.latestVersion = latest;
    state.lastCheckAt = Date.now();
    log(`npm 最新版本：${latest}`);
    if (compareVersions(latest, current) <= 0) {
      log(`已是最新（${current}），无需更新`);
      state.lastResult = 'up-to-date';
      state.lastMessage = `已是最新 ${current}`;
    } else {
      log(`发现新版本：${current} -> ${latest}`);
      await updateExclude(latest);
      const output = await runDshInstall(latest);
      if (output) log(`安装输出：${output}`);
      const after = await readCurrentVersion();
      if (after === latest) {
        log(`更新成功并验证：${after}（重启 DSH 后生效）`);
        state.currentVersion = after;
        state.lastResult = 'updated';
        state.lastMessage = `已更新 ${current} -> ${after}，重启后生效`;
      } else {
        log(`安装命令已执行但版本不符：期望 ${latest}，实际 ${after}`, 'ERROR');
        state.lastResult = 'failed';
        state.lastMessage = `安装后版本不符（实际 ${after}）`;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`检查失败：${message}`, 'ERROR');
    state.lastResult = 'failed';
    state.lastMessage = message;
  } finally {
    state.running = false;
    await saveState();
  }
}

let wakeTimer = null;
let intervalTimer = null;

function stopTimers() {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

function startTimers() {
  stopTimers();
  if (!state.config.enabled) {
    log('自动检查已关闭');
    return;
  }
  const periodMs = state.config.intervalHours * 3_600_000;
  log(`自动检查已开启，每 ${state.config.intervalHours} 小时一次`);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    runCheck(false).catch(() => {});
    intervalTimer = setInterval(() => runCheck(false).catch(() => {}), periodMs);
  }, 60_000);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        return resolve(JSON.parse(raw));
      } catch (error) {
        return reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function publicState() {
  return {
    config: state.config,
    currentVersion: state.currentVersion,
    latestVersion: state.latestVersion,
    lastCheckAt: state.lastCheckAt,
    lastResult: state.lastResult,
    lastMessage: state.lastMessage,
    running: state.running,
    recentLogs: logLines.slice(-80)
  };
}

export function apply(ctx) {
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-workbuddy-auto-updater/state',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      return sendJson(res, 200, publicState());
    }
  });

  const checkDispose = ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-workbuddy-auto-updater/check',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      if (state.running) return sendJson(res, 409, { error: 'check already running' });
      runCheck(true).catch(() => {});
      return sendJson(res, 202, { started: true });
    }
  });

  const configDispose = ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-workbuddy-auto-updater/config',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      let body;
      try {
        body = await readBody(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
      let changed = false;
      if (typeof body.enabled === 'boolean') {
        state.config.enabled = body.enabled;
        changed = true;
      }
      if (body.intervalHours !== void 0) {
        const hours = Number(body.intervalHours);
        if (Number.isFinite(hours)) {
          state.config.intervalHours = Math.min(168, Math.max(1, Math.round(hours)));
          changed = true;
        }
      }
      if (!changed) return sendJson(res, 400, { error: 'no valid fields' });
      await saveState();
      startTimers();
      return sendJson(res, 200, publicState());
    }
  });

  ctx.effect(() => {
    loadState()
      .then(() => {
        startTimers();
      })
      .catch((error) => log(`初始化失败：${error instanceof Error ? error.message : String(error)}`, 'ERROR'));
    return () => {
      stopTimers();
      dispose();
      checkDispose();
      configDispose();
    };
  }, 'dsh-workbuddy-auto-updater: lifecycle');
}
