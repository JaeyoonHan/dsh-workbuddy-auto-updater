/**
 * Locating and running the dsh CLI without a shell in the argument path.
 *
 * `dsh plugin add pkg@<version>` is the one place this plugin hands a
 * network-derived string to another process. The shipped launcher is a Windows
 * batch file, and running a `.cmd` requires `cmd.exe /c`, which re-parses the
 * argument list: `execFile` quoting does not survive it, so a version string
 * carrying `&` becomes a second command.
 *
 * Two independent defenses, in order:
 *   1. resolve the Electron executable and the CLI entry script directly and
 *      spawn them with `ELECTRON_RUN_AS_NODE=1` — no batch file, no shell, no
 *      re-parse, so metacharacters have nowhere to be interpreted;
 *   2. only when that fails, fall back to the batch launcher, which is safe
 *      solely because {@link import('./guard.js').isSafeVersion} has already
 *      proven the version is digits and dots. Both gates must fail for this to
 *      be reachable, and they are independent.
 *
 * @module dsh-workbuddy-auto-updater/cli
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Relative location of the CLI entry script inside the application bundle. */
const CLI_SCRIPT_SUFFIX = join('dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');

/** Relative location of the packed application archive that holds the script. */
const ASAR_SUFFIX = join('resources', 'app.asar');

/** Relative location of the batch launcher shipped with the runtime. */
const LAUNCHER_SUFFIX = join('resources', 'runtime', 'cli', 'bin', 'dsh.cmd');

/** Windows executable names the desktop app may use. */
const EXE_NAMES = ['DeepSeek Harness.exe', 'DeepSeekHarness.exe'];

/** First existing path from a list, or undefined. */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (candidate !== undefined && existsSync(candidate)) return candidate;
    } catch {
      /* keep probing */
    }
  }
  return undefined;
}

/**
 * The CLI entry script for one installation root.
 *
 * The script lives INSIDE `app.asar`, which plain Node cannot stat: asar is a
 * virtual filesystem only an Electron-patched `fs` understands. So the check is
 * made against the archive container instead — its presence proves the bundle
 * is installed, and `ELECTRON_RUN_AS_NODE` resolves the path within it.
 *
 * @param {string} root - installation root (the folder holding the executable).
 * @returns {string | undefined} the script path, or undefined when the bundle is absent.
 */
function scriptUnder(root) {
  const archive = join(root, ASAR_SUFFIX);
  try {
    if (!existsSync(archive)) return undefined;
  } catch {
    return undefined;
  }
  return join(archive, CLI_SCRIPT_SUFFIX);
}

/**
 * The roots a packaged installation may live under.
 *
 * `process.resourcesPath` and `process.execPath` only answer this when the code
 * runs inside the Electron app. Under plain Node — a test, a script, an
 * external caller — neither exists, so the well-known install locations are
 * probed as well, and `DSH_EXE` lets an operator point at the real one.
 */
function installRoots() {
  const roots = [];
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined;
  if (resourcesPath !== undefined) roots.push(dirname(resourcesPath));
  if (typeof process.execPath === 'string' && process.execPath !== '') {
    roots.push(dirname(process.execPath));
  }
  if (typeof process.env.DSH_EXE === 'string' && process.env.DSH_EXE !== '') {
    roots.push(dirname(process.env.DSH_EXE));
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LocalAppData]) {
    if (typeof base === 'string' && base !== '') roots.push(join(base, 'DeepSeekHarness'), join(base, 'DeepSeek Harness'));
  }
  return [...new Set(roots)];
}

/**
 * Resolve how to invoke the CLI.
 *
 * Prefers a direct `executable + script` pair, which never involves a shell.
 *
 * @returns {{ kind: 'direct', exe: string, script: string } | { kind: 'launcher', launcher: string } | undefined} the invocation strategy, or undefined when nothing was found.
 */
export function resolveCli() {
  const explicitExe = process.env.DSH_EXE;
  const explicitScript = process.env.DSH_CLI_SCRIPT;
  const explicitLauncher = process.env.DSH_CLI;

  if (
    typeof explicitExe === 'string' &&
    explicitExe !== '' &&
    typeof explicitScript === 'string' &&
    explicitScript !== '' &&
    existsSync(explicitExe)
  ) {
    return { kind: 'direct', exe: explicitExe, script: explicitScript };
  }

  const roots = installRoots();
  const exe = firstExisting(roots.flatMap((root) => EXE_NAMES.map((name) => join(root, name))));
  // `scriptUnder` already proved the archive exists; the script path INSIDE it
  // cannot be stat'd by plain Node, so it must not be re-checked here.
  const script = roots.map((root) => scriptUnder(root)).find((value) => value !== undefined);
  if (exe !== undefined && script !== undefined) return { kind: 'direct', exe, script };

  const launcher = firstExisting([...roots.map((root) => join(root, LAUNCHER_SUFFIX)), explicitLauncher]);
  if (launcher !== undefined) return { kind: 'launcher', launcher };

  return undefined;
}

/**
 * Run one `dsh plugin` command.
 *
 * The caller MUST have validated every version string with
 * {@link import('./guard.js').isSafeVersion} first. The direct path does not
 * depend on that, but the launcher fallback does, and keeping the contract in
 * one place is what makes the fallback safe to keep.
 *
 * @param {string[]} args - CLI arguments, already validated.
 * @param {{ cwd: string, timeoutMs?: number }} options - working directory and budget.
 * @returns {Promise<string>} combined stdout and stderr.
 * @throws {Error} when nothing was resolved or the command failed.
 */
export async function runDshCli(args, options) {
  const cli = resolveCli();
  if (cli === undefined) {
    throw new Error('未找到 dsh CLI：可设置 DSH_EXE + DSH_CLI_SCRIPT 或 DSH_CLI 环境变量后重试');
  }
  const settings = {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 10 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  };

  if (cli.kind === 'direct') {
    const { stdout, stderr } = await execFileAsync(
      cli.exe,
      ['--expose-internals', cli.script, ...args],
      { ...settings, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
    );
    return [stdout, stderr].filter(Boolean).join('\n').trim();
  }

  const { stdout, stderr } = await execFileAsync('cmd.exe', ['/c', cli.launcher, ...args], settings);
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

/** Describe the resolved invocation for the status card and the log. */
export function describeCli() {
  const cli = resolveCli();
  if (cli === undefined) return 'not-found';
  if (cli.kind === 'direct') return `direct: ${cli.exe}`;
  return `launcher: ${cli.launcher}`;
}
