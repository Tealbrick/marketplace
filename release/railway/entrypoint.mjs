import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { launchMarketplace } from './tailnet.mjs';

const APP_UID = 1000;
const APP_GID = 1000;
const DATA_ROOT = '/data';
const DATA_DIRS = ['/data/state', '/data/logs'];

function fail(message) {
  process.stderr.write(`marketplace startup denied: ${message}\n`);
  process.exit(78);
}

function assertRealDirectory(pathname) {
  const info = fs.lstatSync(pathname);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail(`${pathname} must be a real directory`);
  }
}

function ensureWritableDir(pathname) {
  try {
    fs.mkdirSync(pathname, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  let info = fs.lstatSync(pathname);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail(`${pathname} must be a real directory`);
  }
  // On restarts, the expected state is already app-owned and private. Verify
  // with lstat and avoid opening a mode-0700 directory as root without DAC
  // override. The root-owned /data parent prevents the app from replacing it.
  if (info.uid === APP_UID && info.gid === APP_GID && (info.mode & 0o777) === 0o700) {
    return;
  }
  if (info.uid !== 0) fail(`${pathname} has unsafe permissions and is not root-owned`);
  const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    info = fs.fstatSync(fd);
    if (!info.isDirectory() || info.uid !== 0) fail(`${pathname} changed during bootstrap`);
    if ((info.mode & 0o777) !== 0o700) fs.fchmodSync(fd, 0o700);
    fs.fchownSync(fd, APP_UID, APP_GID);
  } finally {
    fs.closeSync(fd);
  }
}

function prepareRailwayVolume() {
  if (process.env.RAILWAY_RUN_UID !== '0') {
    fail('root execution requires RAILWAY_RUN_UID=0');
  }
  assertRealDirectory(DATA_ROOT);
  const rootFd = fs.openSync(DATA_ROOT, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    // Keep the mount root root-owned, but make it traversable after dropping uid.
    fs.fchmodSync(rootFd, 0o755);
  } finally {
    fs.closeSync(rootFd);
  }
  for (const pathname of DATA_DIRS) ensureWritableDir(pathname);

  // Restrict supplementary groups before dropping to the app account. Only the
  // two direct data directories above are changed; volume contents are untouched.
  process.setgroups([]);
  process.setgid(APP_GID);
  process.setuid(APP_UID);
  if (process.getuid() !== APP_UID || process.getgid() !== APP_GID) {
    fail('privilege drop did not reach the Marketplace app identity');
  }
  process.stderr.write('marketplace privilege drop complete uid=1000 gid=1000\n');
}

const uid = process.getuid();
if (uid === 0) {
  prepareRailwayVolume();
} else {
  if (process.env.RAILWAY_RUN_UID === '0') {
    fail('RAILWAY_RUN_UID=0 was set but the runtime did not start as root');
  }
  if (uid !== APP_UID || process.getgid() !== APP_GID) {
    fail('Marketplace must run as uid=1000 gid=1000');
  }
}

// Without TS_AUTHKEY this imports the app in-process exactly as before. With
// it, tailscaled starts as this (already unprivileged) user and the app runs
// as a child whose environment never contains TS_AUTHKEY.
const launched = await launchMarketplace({
  env: process.env,
  importApp: () => import('./dist/marketplace-program.mjs'),
  spawnApp: (env) =>
    spawn(process.execPath, ['./dist/marketplace-program.mjs'], { env, stdio: 'inherit' }),
});
if (launched.mode === 'supervised') {
  delete process.env.TS_AUTHKEY;
  const { child, outcome } = launched;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.once('exit', (code, signal) => {
    if (outcome.state === 'connected') outcome.stop();
    process.exit(code ?? (signal ? 1 : 0));
  });
  if (outcome.state === 'connected') {
    outcome.daemon.once('exit', () => {
      process.stderr.write('marketplace tailnet: tailscaled stopped; tailnet connectors now report tailnet_unavailable\n');
    });
  }
}
