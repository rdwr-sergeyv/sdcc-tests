#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const composeFile = path.join(root, 'docker', 'legacy-portal', 'docker-compose.yml');
const stateDir = path.join(root, '.tmp', 'dp-isolate');
const logsDir = path.join(root, 'logs');
const clientPidFile = path.join(stateDir, 'client.pid');
const clientLogFile = path.join(logsDir, 'dp-isolate-client.log');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const portalPort = Number(process.env.LEGACY_PORTAL_PORT || readEnv('LEGACY_PORTAL_PORT') || 8000);
const clientPort = Number(process.env.DP_ISOLATE_CLIENT_PORT || readEnv('DP_ISOLATE_CLIENT_PORT') || 5173);
const portalUrl = process.env.SDCC_PORTAL_PUBLIC_URL || readEnv('SDCC_PORTAL_PUBLIC_URL') || `http://localhost:${portalPort}`;
const clientUrl = `http://localhost:${clientPort}`;

const commands = {
  help,
  run,
  status,
  'portal-up': portalUp,
  'portal-down': portalDown,
  'portal-logs': portalLogs,
  'client-up': clientUp,
  'client-down': clientDown,
  'client-logs': clientLogs,
  open: openClient,
  logs,
  restart,
  rebuild,
  stop,
  clean,
};

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  const command = process.argv[2] || 'help';
  const fn = commands[command];
  if (!fn) {
    console.error(`Unknown command: ${command}`);
    help();
    process.exitCode = 2;
    return;
  }
  await fn();
}

function help() {
  console.log(`Usage:
  make                         Show this help
  make run-dp-isolate          Start legacy portal, start DP Isolate client, open browser
  make dp-isolate:start        Same as run-dp-isolate
  make dp-isolate:restart      Stop, then start DP Isolate stack and client
  make dp-isolate:rebuild      Rebuild/recreate portal, restart client, open browser
  make dp-isolate:stop         Stop client and portal
  make dp-isolate:status       Show portal/client status
  make status                  Show portal/client status
  make portal-up               Start legacy portal Docker Compose stack
  make portal-down             Stop legacy portal Docker Compose stack
  make portal-logs             Show recent legacy portal Docker logs
  make client-up               Start DP Isolate Vite client in the background
  make client-down             Stop the background DP Isolate client
  make client-logs             Show recent DP Isolate client logs
  make open-dp-isolate         Open ${clientUrl}
  make logs                    Show recent portal and client logs
  make stop                    Stop client and portal
  make clean                   Remove local launcher state and logs

Environment:
  LEGACY_PORTAL_PORT           Portal port, default ${portalPort}
  DP_ISOLATE_CLIENT_PORT       Client port, default ${clientPort}
  PORTAL_ORIGIN                Vite proxy target, default ${portalUrl}
  DP_ISOLATE_COMPOSE_PROFILE   Compose profile, default internal-mongo
`);
}

async function run() {
  await portalUp();
  await clientUp();
  await openClient();
}

async function status() {
  console.log('Legacy portal Docker:');
  const ps = dockerCompose(['ps']);
  if (ps.status === 0) {
    process.stdout.write(ps.stdout || '(no compose status output)\n');
  } else {
    console.log('not available');
    if (ps.stderr) process.stderr.write(ps.stderr);
    if (ps.error) process.stderr.write(`${ps.error.message}\n`);
  }
  console.log(`\nPortal HTTP ${portalUrl}: ${await isHttpReady(portalUrl) ? 'ready' : 'not ready'}`);
  console.log(`DP Isolate client ${clientUrl}: ${await isHttpReady(clientUrl) ? 'ready' : 'not ready'}`);
  const pid = readPid();
  console.log(`Client PID file: ${pid ? pid : 'none'}`);
  console.log(`Client log: ${clientLogFile}`);
}

async function portalUp() {
  const profile = Object.hasOwn(process.env, 'DP_ISOLATE_COMPOSE_PROFILE')
    ? process.env.DP_ISOLATE_COMPOSE_PROFILE
    : 'internal-mongo';
  const args = profile && profile !== 'none'
    ? ['--profile', profile, 'up', '--build', '-d']
    : ['up', '--build', '-d'];
  console.log(`Starting legacy portal Docker Compose stack (${profile && profile !== 'none' ? `profile: ${profile}` : 'no profile'})...`);
  console.log('Checking Docker CLI...');
  ensureCommand('docker', ['--version'], 'Docker CLI is required.');
  await runDockerComposeLive(args);
  await waitForUrl(portalUrl, 120000, 'legacy portal');
}

async function portalDown() {
  console.log('Stopping legacy portal Docker Compose stack...');
  await runDockerComposeLive(['down']);
}

async function portalLogs() {
  await runDockerComposeLive(['logs', '--tail', '120']);
}

async function portalRebuild() {
  const profile = Object.hasOwn(process.env, 'DP_ISOLATE_COMPOSE_PROFILE')
    ? process.env.DP_ISOLATE_COMPOSE_PROFILE
    : 'internal-mongo';
  const args = profile && profile !== 'none'
    ? ['--profile', profile, 'up', '--build', '--force-recreate', '-d']
    : ['up', '--build', '--force-recreate', '-d'];
  console.log(`Rebuilding legacy portal Docker Compose stack (${profile && profile !== 'none' ? `profile: ${profile}` : 'no profile'})...`);
  console.log('Checking Docker CLI...');
  ensureCommand('docker', ['--version'], 'Docker CLI is required.');
  await runDockerComposeLive(args);
  await waitForUrl(portalUrl, 120000, 'legacy portal');
}

async function clientUp() {
  if (await isHttpReady(clientUrl)) {
    console.log(`DP Isolate client is already ready at ${clientUrl}`);
    return;
  }

  if (!fs.existsSync(viteBin)) {
    throw new Error('Vite is not installed. Run npm install from sdcc-tests, then retry make run-dp-isolate.');
  }
  ensureDir(stateDir);
  ensureDir(logsDir);

  console.log(`Starting DP Isolate client on ${clientUrl}...`);
  const log = fs.openSync(clientLogFile, 'a');
  const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--config', 'client/dp-isolate/vite.config.js'], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      PORTAL_ORIGIN: process.env.PORTAL_ORIGIN || portalUrl,
      DP_ISOLATE_CLIENT_PORT: String(clientPort),
    },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });

  fs.writeFileSync(clientPidFile, String(child.pid));
  child.unref();
  console.log(`Started DP Isolate client on ${clientUrl} (pid ${child.pid}).`);
  console.log(`Client log: ${clientLogFile}`);
  await waitForUrl(clientUrl, 60000, 'DP Isolate client');
}

async function clientDown() {
  const pid = readPid();
  if (pid && isProcessRunning(pid)) {
    killProcessTree(pid);
    console.log(`Stopped DP Isolate client process ${pid}.`);
  } else {
    console.log('No running DP Isolate client PID found.');
  }
  removeIfExists(clientPidFile);
}

function clientLogs() {
  if (!fs.existsSync(clientLogFile)) {
    console.log(`No DP Isolate client log found at ${clientLogFile}`);
    return;
  }
  process.stdout.write(tailFile(clientLogFile, 120));
}

async function openClient() {
  await waitForUrl(clientUrl, 60000, 'DP Isolate client');
  openUrl(clientUrl);
  console.log(`Opened ${clientUrl}`);
}

async function stop() {
  await clientDown();
  await portalDown();
}

async function restart() {
  await stop();
  await run();
}

async function rebuild() {
  await clientDown();
  await portalRebuild();
  await clientUp();
  await openClient();
}

async function logs() {
  console.log('Recent legacy portal Docker logs:');
  await portalLogs();
  console.log('\nRecent DP Isolate client logs:');
  clientLogs();
}

function clean() {
  removeIfExists(clientPidFile);
  removeIfExists(clientLogFile);
  removeEmptyDir(stateDir);
  removeEmptyDir(logsDir);
  console.log('Removed DP Isolate launcher state where present.');
}

function readEnv(name) {
  const envFiles = [
    path.join(root, '.env'),
    path.join(root, 'docker', 'legacy-portal', '.env'),
    path.join(root, 'client', 'dp-isolate', '.env.local'),
  ];
  for (const file of envFiles) {
    if (!fs.existsSync(file)) continue;
    const value = parseEnvFile(file)[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseEnvFile(file) {
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/))
      .filter(Boolean)
      .map((match) => [match[1], stripQuotes(match[2].trim())]),
  );
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function dockerCompose(args) {
  return spawnSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function runDockerComposeLive(args) {
  return new Promise((resolve, reject) => {
    const command = ['docker', 'compose', '-f', composeFile, ...args].join(' ');
    let lastOutputAt = Date.now();
    console.log(`Running: ${command}`);
    const child = spawn('docker', ['compose', '-f', composeFile, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const heartbeat = setInterval(() => {
      if (Date.now() - lastOutputAt >= 15000) {
        console.log('docker compose is still running...');
        lastOutputAt = Date.now();
      }
    }, 5000);
    child.stdout.on('data', (chunk) => {
      lastOutputAt = Date.now();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      lastOutputAt = Date.now();
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      clearInterval(heartbeat);
      reject(error);
    });
    child.on('exit', (code) => {
      clearInterval(heartbeat);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`docker compose failed with exit code ${code}`));
      }
    });
  });
}

function ensureCommand(command, args, message) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0 || result.signal) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(message);
  }
}

async function waitForUrl(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let nextNotice = Date.now();
  console.log(`Waiting for ${label}: ${url}`);
  while (Date.now() < deadline) {
    if (await isHttpReady(url)) {
      console.log(`${label} is ready: ${url}`);
      return;
    }
    if (Date.now() >= nextNotice) {
      const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      console.log(`${label} is not ready yet; waiting up to ${remainingSeconds}s more...`);
      nextNotice = Date.now() + 10000;
    }
    await sleep(1500);
  }
  throw new Error(`${label} did not become ready within ${Math.round(timeoutMs / 1000)}s: ${url}`);
}

function isHttpReady(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 3000 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

function readPid() {
  if (!fs.existsSync(clientPidFile)) return null;
  const pid = Number(fs.readFileSync(clientPidFile, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        return;
      }
    }
  }
}

function openUrl(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeIfExists(file) {
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
}

function removeEmptyDir(dir) {
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmdirSync(dir);
  } catch {
    // Keep non-empty directories intact.
  }
}

function tailFile(file, maxLines) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  return lines.slice(-maxLines).join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
