// Optional tailnet reachability for the Marketplace image.
//
// Inert unless TS_AUTHKEY is set and non-empty. When it is, a userspace
// tailscaled runs as the app user with in-memory state and an outbound HTTP
// proxy on 127.0.0.1:1055, and Marketplace starts as a child process whose
// environment never contains TS_AUTHKEY. The key reaches `tailscale up`
// through a 0600 file that is deleted as soon as `up` returns, so it never
// appears in argv, logs or health output. If the node does not come up,
// Marketplace still starts and tailnet connectors report tailnet_unavailable.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TAILNET_PROXY_LISTEN = '127.0.0.1:1055';
export const TAILNET_PROXY_URL = `http://${TAILNET_PROXY_LISTEN}`;
export const DEFAULT_TS_HOSTNAME = 'tealbrick-marketplace';
export const TAILNET_UP_TIMEOUT_MS = 30_000;
const HOSTNAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export function tailnetRequested(env) {
  return typeof env.TS_AUTHKEY === 'string' && env.TS_AUTHKEY.trim() !== '';
}

/** Environment without the auth key (and without caller-supplied tailnet wiring). */
export function withoutAuthKey(env) {
  const next = { ...env };
  delete next.TS_AUTHKEY;
  return next;
}

/** The environment Marketplace runs with after a tailnet start attempt. */
export function appEnvironment(env, outcome) {
  const next = withoutAuthKey(env);
  delete next.MARKETPLACE_TAILNET_PROXY;
  delete next.MARKETPLACE_TAILNET_STATE;
  if (outcome.state === 'connected') next.MARKETPLACE_TAILNET_PROXY = TAILNET_PROXY_URL;
  else next.MARKETPLACE_TAILNET_STATE = 'unavailable';
  return next;
}

export function tailnetHostname(env) {
  const requested = (env.TS_HOSTNAME ?? '').trim().toLowerCase();
  return HOSTNAME_PATTERN.test(requested) ? requested : DEFAULT_TS_HOSTNAME;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a CLI to completion with a hard deadline. Output is captured, never printed. */
function run(spawn, command, args, env, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(-1);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr?.resume();
    child.once('error', () => finish(-1));
    child.once('close', (code) => finish(code ?? -1));
  });
}

/**
 * Start tailscaled and bring the node up. Resolves to
 * `{ state: 'connected', stop }` or `{ state: 'unavailable', reason }`.
 * Reasons are fixed codes; nothing secret is ever logged.
 */
export async function startTailnet(options) {
  const env = options.env;
  const log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  const spawn = options.spawn ?? nodeSpawn;
  const binDir = options.binDir ?? '/usr/local/bin';
  const timeoutMs = options.timeoutMs ?? TAILNET_UP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const tailscaled = path.join(binDir, 'tailscaled');
  const tailscale = path.join(binDir, 'tailscale');
  const childEnv = withoutAuthKey(env);
  const hostname = tailnetHostname(env);
  if (!fs.existsSync(tailscaled) || !fs.existsSync(tailscale)) {
    log('marketplace tailnet unavailable: tailscale binaries are missing from the image; starting without the tailnet');
    return { state: 'unavailable', reason: 'binaries_missing' };
  }
  const workDir = fs.mkdtempSync(path.join(options.tmpDir ?? os.tmpdir(), 'tailscaled-'));
  fs.chmodSync(workDir, 0o700);
  const socket = path.join(workDir, 'tailscaled.sock');
  const cli = (args, ms) => run(spawn, tailscale, [`--socket=${socket}`, ...args], childEnv, Math.max(1, ms));
  let exited = false;
  const daemon = spawn(
    tailscaled,
    [
      '--tun=userspace-networking',
      '--state=mem:',
      `--socket=${socket}`,
      `--outbound-http-proxy-listen=${TAILNET_PROXY_LISTEN}`,
      '--no-logs-no-support',
    ],
    { env: childEnv, stdio: ['ignore', 'ignore', 'ignore'] },
  );
  daemon.once('exit', () => {
    exited = true;
  });
  daemon.once('error', () => {
    exited = true;
  });
  const stop = () => {
    if (!exited) daemon.kill('SIGTERM');
    fs.rmSync(workDir, { recursive: true, force: true });
  };
  const fail = (reason, message) => {
    log(`marketplace tailnet unavailable: ${message}; starting without the tailnet`);
    stop();
    return { state: 'unavailable', reason };
  };

  while (!fs.existsSync(socket)) {
    if (exited) return fail('tailscaled_exited', 'tailscaled exited during startup');
    if (Date.now() >= deadline) return fail('tailscaled_timeout', 'tailscaled did not start in time');
    await sleep(100);
  }

  const keyFile = path.join(workDir, 'authkey');
  fs.writeFileSync(keyFile, env.TS_AUTHKEY.trim(), { mode: 0o600 });
  let up;
  try {
    const remaining = deadline - Date.now();
    up = await cli(
      [
        'up',
        `--auth-key=file:${keyFile}`,
        `--hostname=${hostname}`,
        '--accept-dns=false',
        `--timeout=${Math.max(1, Math.floor(remaining / 1000))}s`,
      ],
      remaining + 2_000,
    );
  } finally {
    fs.rmSync(keyFile, { force: true });
  }
  if (up.code !== 0) return fail('up_failed', 'tailscale up did not complete (check the auth key, its tags and expiry)');

  while (Date.now() < deadline) {
    const status = await cli(['status', '--json'], Math.min(5_000, deadline - Date.now()));
    try {
      if (status.code === 0 && JSON.parse(status.stdout).BackendState === 'Running') {
        log(`marketplace tailnet connected as ${hostname}`);
        return { state: 'connected', stop, daemon };
      }
    } catch {
      // Not JSON yet; retry until the deadline.
    }
    if (exited) return fail('tailscaled_exited', 'tailscaled exited during startup');
    await sleep(500);
  }
  return fail('not_running', 'the tailnet node did not reach Running in time');
}

/**
 * Entrypoint decision. Without TS_AUTHKEY the app is imported in-process
 * exactly as before. With it, the tailnet is started and the app runs as a
 * child process with a scrubbed environment.
 */
export async function launchMarketplace(options) {
  const env = options.env;
  if (!tailnetRequested(env)) {
    await options.importApp();
    return { mode: 'direct' };
  }
  const outcome = await (options.startTailnet ?? startTailnet)({ env, log: options.log });
  const child = options.spawnApp(appEnvironment(env, outcome));
  return { mode: 'supervised', outcome, child };
}
