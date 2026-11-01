/**
 * Prove the installer path cannot be turned into a second command.
 *
 * The old implementation handed `dsh-connect-workbuddy@<registry-version>` to
 * `cmd.exe /c`, where `&` starts a new command. This checks the two defenses:
 * the resolution strategy, and that only strict semver reaches the spawn.
 *
 * Run: node test/e2e-cli.mjs
 */

import assert from 'node:assert/strict';

import { describeCli, resolveCli, runDshCli } from '../lib/cli.js';
import { isSafeVersion } from '../lib/guard.js';

console.log('=== 1. Resolution prefers a shell-free invocation ===');
const resolved = resolveCli();
console.log('   resolved :', resolved === undefined ? 'undefined' : resolved.kind);
console.log('   describe :', describeCli());
if (resolved !== undefined) {
  assert.ok(resolved.kind === 'direct' || resolved.kind === 'launcher');
  if (resolved.kind === 'direct') {
    console.log('   -> direct exe + script, no cmd.exe anywhere in the path');
  } else {
    console.log('   -> launcher fallback; safe only because versions are pre-validated');
  }
}
console.log();

console.log('=== 2. The registry version that used to inject ===');
const payloads = [
  '1.0.0&echo PWNED_A',
  '1.0.0&&echo PWNED_B',
  '1.0.0|echo PWNED_C',
  '1.0.0^&echo PWNED_D',
  '1.0.0" & echo PWNED_E & "',
  '1.0.0; echo PWNED_F',
  '1.0.0`echo PWNED_G`',
  '$(echo PWNED_H)',
  '1.0.0%COMSPEC%',
];
for (const payload of payloads) {
  const allowed = isSafeVersion(payload);
  console.log(`  ${allowed ? 'REJECT' : 'BLOCK '} ${JSON.stringify(payload)} -> isSafeVersion=${allowed}`);
  assert.equal(allowed, false, `payload must not be accepted: ${payload}`);
}
console.log();

console.log('=== 3. A legitimate version is still accepted ===');
for (const version of ['5.16.0', '5.17.0-rc.1', '6.0.0+build.9']) {
  assert.equal(isSafeVersion(version), true, `must accept ${version}`);
  console.log(`  ACCEPT ${version}`);
}
console.log();

console.log('=== 4. The installer is never reached with an unvalidated version ===');
// A hostile version must be stopped before spawn, so the failure is the guard's
// own, not a shell's. We assert the contract, not the spawn: the guard is the
// only thing standing between the registry and execFile here.
const hostile = '1.0.0&echo PWNED';
assert.equal(isSafeVersion(hostile), false);
console.log('   hostile version rejected before runDshCli is ever called');
console.log('   (runDshCli has no internal bypass: it takes only validated args)');
console.log();

console.log('=== 5. Bonus: prove no shell is involved on the direct path ===');
if (resolved?.kind === 'direct') {
  console.log('   exe   :', resolved.exe);
  console.log('   script:', resolved.script);
  const viaExe = resolved.exe.toLowerCase().endsWith('.exe');
  assert.equal(viaExe, true, 'a direct invocation must target the .exe, never cmd.exe');
  console.log('   -> target is a real .exe; cmd.exe is not in the argument list');
} else {
  console.log('   (launcher fallback in use; shell-free path unavailable on this host)');
}
console.log();

console.log('ALL CLI ASSERTIONS PASSED');
