#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const composeFile = path.join(
  root,
  "docker",
  "legacy-portal",
  "docker-compose.yml",
);
const stateDir = path.join(root, ".tmp", "dp-isolate");
const logsDir = path.join(root, "logs");
const clientPidFile = path.join(stateDir, "client.pid");
const clientLogFile = path.join(logsDir, "dp-isolate-client.log");
const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
const portalPort = Number(
  process.env.LEGACY_PORTAL_PORT || readEnv("LEGACY_PORTAL_PORT") || 8000,
);
const clientPort = Number(
  process.env.DP_ISOLATE_CLIENT_PORT ||
    readEnv("DP_ISOLATE_CLIENT_PORT") ||
    5173,
);
const portalUrl =
  process.env.SDCC_PORTAL_PUBLIC_URL ||
  readEnv("SDCC_PORTAL_PUBLIC_URL") ||
  `http://localhost:${portalPort}`;
const clientUrl = `http://localhost:${clientPort}`;
const backendServices = [
  "alert-manager-aggregator",
  "ar-config-poller",
  "asset-advertisement-aggregator",
  "asset-aggregator",
  "asset-health-aggregator",
  "attack-aggregator",
  "attacks-poller",
  "bgp-advertise-poller",
  "bgp-over-gre-aggregator",
  "bgp-peer-poller",
  "bgp-routing-poller",
  "cmd-executor",
  "daily-jobs-aggregator",
  "diversion-period-checker-aggregator",
  "domain-resolve-aggregator",
  "domain-resolve-poller",
  "dp-fail-over-aggregator",
  "dp-fail-over-poller",
  "dp-policy-inconsistency-aggregator",
  "dp-policy-manager",
  "file-reporter-aggregator",
  "flow-poller",
  "health-poller",
  "incident-manager",
  "netflow-manager",
  "pdf-incident-reporter-aggregator",
  "resource-utilization-aggregator",
  "sc-aggregator",
  "sc-poller",
  "site-aggregator",
  "site-poller",
  "static-route-aggregator",
  "static-routes-poller",
  "status-aggregator",
  "ts-aggregator",
  "vision-api-poller",
  "vision-connectivity-aggregator",
  "vision-control-poller",
  "vision-cpe-aggregator",
  "vision-device-policy-aggregator",
  "vision-device-policy-poller",
  "vision-policies-aggregator",
  "vision-policies-poller",
  "waf-route-poller",
  "waf-ssl-protection-aggregator",
];

const commands = {
  help,
  run,
  "run-build-only": runBuildOnly,
  "run-ui-only": runUiOnly,
  status,
  "portal-up": portalUp,
  "portal-build-only-up": portalBuildOnlyUp,
  "portal-ui-up": portalUiUp,
  "portal-restart": portalRestart,
  "portal-rebuild": portalRebuild,
  "portal-down": portalDown,
  "portal-logs": portalLogs,
  "portal-license-backends": portalLicenseBackends,
  "client-up": clientUp,
  "client-down": clientDown,
  "client-logs": clientLogs,
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
  const command = process.argv[2] || "help";
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
  make run-dp-isolate          Start legacy portal in build-only task mode, start DP Isolate client, open browser
  make run-dp-isolate-build-only Compatibility alias for run-dp-isolate
  make run-dp-isolate-ui-only  Start Mongo, portal, and DP Isolate client only
  make demo-short              Run the paused short Attack Isolation UI demo
  make demo-playwright         Run the paused Playwright demo with build-only backend workers
  make demo-short-playwright   Run the paused/resumable Playwright short demo
  make demo-short-resume       Resume the Playwright short demo from saved step
  make test-dp-isolate         Start full backend in build-only task mode, restore fixture, run all DP Isolate tests
  make test-dp-isolate-api     Start full backend in build-only task mode, restore fixture, run DP Isolate API tests
  make test-dp-isolate-api-build-only Compatibility alias for test-dp-isolate-api
  make test-dp-isolate-api-short Start portal only, restore fixture, run short API tests
  make test-dp-isolate-smoke   Start full backend in build-only task mode, restore fixture, run DP Isolate smoke tests
  make dp-isolate:start        Same as run-dp-isolate
  make dp-isolate:ui-only      Same as run-dp-isolate-ui-only
  make dp-isolate:restart      Restart existing portal stack without rebuilding; restart client
  make dp-isolate:rebuild      Rebuild/recreate portal, restart client, open browser
  make dp-isolate:stop         Stop client and portal
  make dp-isolate:status       Show portal/client status
  make dp-isolate:restore-ready Restore the ready-for-tests DP Isolate fixture
  make dp-isolate:task-snapshot Show isolation task/log summary for ASSET_ID
  make dp-isolate:device-password Decrypt a management device password field for SC/DP
  make dp-isolate:vision-password Decrypt a Vision database password for SC/VISION
  make dp-isolate:policy-capacity-min Set Attack Zone DP policy capacity to the minimum
  make dp-isolate:policy-capacity-restore Restore Attack Zone DP policy capacity defaults
  make restore-ready           Same as dp-isolate:restore-ready
  make task-snapshot           Same as dp-isolate:task-snapshot
  make device-password         Same as dp-isolate:device-password
  make vision-password         Same as dp-isolate:vision-password
  make policy-capacity-min     Same as dp-isolate:policy-capacity-min
  make policy-capacity-restore Same as dp-isolate:policy-capacity-restore
  make kafka-producer          Send one synthetic security event to Kafka
  make kafka-producer-ui       Start the Kafka security-event producer UI
  make kafka-producer-ui-up    Start the Kafka producer UI in the background
  make kafka-producer-ui-down  Stop the background Kafka producer UI
  make kafka-producer-ui-status Show Kafka producer UI background status
  make kafka-producer-ui-logs  Show recent Kafka producer UI logs
  make status                  Show portal/client status
  make portal-up               Start legacy portal Docker Compose stack (execute + minimal profiles)
  make portal-build-only-up    Start legacy portal in build-only task mode (build-only + minimal profiles)
  make portal-ui-up            Start only Mongo and portal; keep worker services stopped
  make portal-restart          Restart existing legacy portal Docker Compose stack without rebuilding
  make portal-rebuild          Rebuild/recreate legacy portal Docker Compose stack
  make portal-down             Stop legacy portal Docker Compose stack
  make portal-logs             Show recent legacy portal Docker logs
  make portal-license-backends Activate SDCC licensed modules in backend containers
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
  DP_ISOLATE_COMPOSE_PROFILE   Comma-separated Compose profiles; combine one task type (execute, build-only) and
                               one service scope (minimal, full); default execute,minimal; use none for no profiles
  SDCC_LICENSE_IFN             Container interface for license generation, default eth0
  SDCC_LICENSE_MODULES         Comma-separated module names, default all
  SDCC_LICENSE_SERVICES        Comma-separated backend services, default incident-manager,cmd-executor
  SDCC_TASK_TYPE                Task execution type, default build; set to provisioning to execute device commands
  SC                            Scrubbing center name/abbreviation for password helpers
  DP                            Device name/IP/ID for device-password
  VISION                        Vision name/host/ID for vision-password
  ARGS                          Extra password helper args, e.g. --field snmp_community
  KAFKA_BOOTSTRAP              Kafka bootstrap server, default kafkaQA:9092
  KAFKA_DOCKER_NETWORK         Docker network for producer container, default lab
  KAFKA_PRODUCER_UI_PORT       Kafka producer UI port, default 3000
  KAFKA_ARGS                   Extra args for tools/kafka-securityevent-producer/run.sh
`);
}

async function run() {
  await portalUp();
  await clientUp();
  await openClient();
}

async function runBuildOnly() {
  await run();
}

async function runUiOnly() {
  await portalUiUp();
  await clientUp();
  await openClient();
}

async function status() {
  console.log("Legacy portal Docker:");
  const ps = dockerCompose(["ps"]);
  if (ps.status === 0) {
    process.stdout.write(ps.stdout || "(no compose status output)\n");
  } else {
    console.log("not available");
    if (ps.stderr) process.stderr.write(ps.stderr);
    if (ps.error) process.stderr.write(`${ps.error.message}\n`);
  }
  console.log(
    `\nPortal HTTP ${portalUrl}: ${(await isHttpReady(portalUrl)) ? "ready" : "not ready"}`,
  );
  console.log(
    `DP Isolate client ${clientUrl}: ${(await isHttpReady(clientUrl)) ? "ready" : "not ready"}`,
  );
  const pid = readPid();
  console.log(`Client PID file: ${pid ? pid : "none"}`);
  console.log(`Client log: ${clientLogFile}`);
}

async function portalUp() {
  const profileArgs = composeProfileArgs(["execute", "minimal"]);
  const args = [...profileArgs, "up", "--build", "-d"];
  console.log(
    `Starting legacy portal Docker Compose stack (${describeComposeProfiles(profileArgs)})...`,
  );
  console.log("Checking Docker CLI...");
  ensureCommand("docker", ["--version"], "Docker CLI is required.");
  await runDockerComposeLive(args);
  await waitForUrl(portalUrl, 120000, "legacy portal");
}

async function portalBuildOnlyUp() {
  const profileArgs = composeProfileArgs(["build-only", "minimal"]);
  const args = [...profileArgs, "up", "--build", "-d"];
  console.log(
    `Starting legacy portal Docker Compose stack (${describeComposeProfiles(profileArgs)})...`,
  );
  console.log("Checking Docker CLI...");
  ensureCommand("docker", ["--version"], "Docker CLI is required.");
  await runDockerComposeLive(args);
  await waitForUrl(portalUrl, 120000, "legacy portal");
}

async function portalUiUp() {
  const profileArgs = composeProfileArgs(["execute", "minimal"]);
  const profiles = composeProfiles(["execute", "minimal"]);
  const portalService = profiles.includes("build-only")
    ? "portal-build"
    : "portal";
  const services = profileArgs.length
    ? ["mongo", portalService]
    : [portalService];
  const args = [...profileArgs, "up", "--build", "-d", ...services];
  console.log(
    `Starting legacy portal UI-only stack (${describeComposeProfiles(profileArgs)})...`,
  );
  console.log("Checking Docker CLI...");
  ensureCommand("docker", ["--version"], "Docker CLI is required.");
  await runDockerComposeLive(args);
  await stopWorkersIfPresent();
  await waitForUrl(portalUrl, 120000, "legacy portal");
}

async function stopWorkersIfPresent() {
  console.log("Ensuring backend worker services are stopped...");
  await runDockerComposeLive(["stop", ...backendServices]);
}

async function portalRestart() {
  const profileArgs = composeProfileArgs(["execute", "minimal"]);
  const args = [...profileArgs, "up", "-d"];
  console.log(
    "Restarting legacy portal Docker Compose stack without rebuilding...",
  );
  console.log("Checking Docker CLI...");
  ensureCommand("docker", ["--version"], "Docker CLI is required.");
  const ps = dockerCompose(["ps", "-q"]);
  if (ps.status !== 0 || !String(ps.stdout || "").trim()) {
    console.log(
      "No existing compose containers found; starting stack instead.",
    );
    await portalUp();
    return;
  }
  await runDockerComposeLive(args);
  await waitForUrl(portalUrl, 120000, "legacy portal");
}

async function portalDown() {
  console.log("Stopping legacy portal Docker Compose stack...");
  await runDockerComposeLive(["down"]);
}

async function portalLogs() {
  await runDockerComposeLive(["logs", "--tail", "120"]);
}

async function portalLicenseBackends() {
  console.log("Activating SDCC licensed modules in backend containers...");
  console.log("Checking Docker CLI...");
  ensureCommand("docker", ["--version"], "Docker CLI is required.");

  const services = parseListEnv("SDCC_LICENSE_SERVICES", [
    "incident-manager",
    "cmd-executor",
  ]);
  const ifn =
    process.env.SDCC_LICENSE_IFN || readEnv("SDCC_LICENSE_IFN") || "eth0";
  const modules = parseListEnv("SDCC_LICENSE_MODULES", ["all"]);
  const moduleArgs = modules.map(shellQuote).join(" ");

  for (const service of services) {
    console.log(
      `\n[${service}] Activating modules "${modules.join(", ")}" using interface ${ifn}...`,
    );
    await runDockerComposeLive([
      "exec",
      "-T",
      service,
      "sh",
      "-lc",
      [
        `sdcc-manage-module -a deactivate -m ${moduleArgs} || true`,
        `sdcc-manage-module -a activate -i ${shellQuote(ifn)} -m ${moduleArgs}`,
        "sdcc-manage-module -a list",
      ].join(" && "),
    ]);
  }
}

async function portalRebuild() {
  const profileArgs = composeProfileArgs(["execute", "minimal"]);
  const args = [...profileArgs, "up", "--build", "--force-recreate", "-d"];
  console.log(
    `Rebuilding legacy portal Docker Compose stack (${describeComposeProfiles(profileArgs)})...`,
  );
  console.log("Checking Docker CLI...");
  ensureCommand("docker", ["--version"], "Docker CLI is required.");
  await runDockerComposeLive(args);
  await waitForUrl(portalUrl, 120000, "legacy portal");
}

async function clientUp() {
  if (await isHttpReady(clientUrl)) {
    console.log(`DP Isolate client is already ready at ${clientUrl}`);
    return;
  }

  if (!fs.existsSync(viteBin)) {
    throw new Error(
      "Vite is not installed. Run npm install from sdcc-tests, then retry make run-dp-isolate.",
    );
  }
  ensureDir(stateDir);
  ensureDir(logsDir);

  console.log(`Starting DP Isolate client on ${clientUrl}...`);
  const log = fs.openSync(clientLogFile, "a");
  const child = spawn(
    process.execPath,
    [
      viteBin,
      "--host",
      "127.0.0.1",
      "--config",
      "client/dp-isolate/vite.config.js",
    ],
    {
      cwd: root,
      detached: true,
      env: {
        ...process.env,
        PORTAL_ORIGIN: process.env.PORTAL_ORIGIN || portalUrl,
        DP_ISOLATE_CLIENT_PORT: String(clientPort),
      },
      stdio: ["ignore", log, log],
      windowsHide: true,
    },
  );

  fs.writeFileSync(clientPidFile, String(child.pid));
  child.unref();
  console.log(`Started DP Isolate client on ${clientUrl} (pid ${child.pid}).`);
  console.log(`Client log: ${clientLogFile}`);
  await waitForUrl(clientUrl, 60000, "DP Isolate client");
}

async function clientDown() {
  const pid = readPid();
  if (pid && isProcessRunning(pid)) {
    killProcessTree(pid);
    console.log(`Stopped DP Isolate client process ${pid}.`);
  } else {
    console.log("No running DP Isolate client PID found.");
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
  await waitForUrl(clientUrl, 60000, "DP Isolate client");
  openUrl(clientUrl);
  console.log(`Opened ${clientUrl}`);
}

async function stop() {
  await clientDown();
  await portalDown();
}

async function restart() {
  await clientDown();
  await portalRestart();
  await clientUp();
  await openClient();
}

function ensureTaskTypeDefault() {
  process.env.SDCC_TASK_TYPE =
    process.env.SDCC_TASK_TYPE || readEnv("SDCC_TASK_TYPE") || "build";
  console.log(`Task execution type: ${process.env.SDCC_TASK_TYPE}`);
}

async function rebuild() {
  await clientDown();
  await portalRebuild();
  await clientUp();
  await openClient();
}

async function logs() {
  console.log("Recent legacy portal Docker logs:");
  await portalLogs();
  console.log("\nRecent DP Isolate client logs:");
  clientLogs();
}

function clean() {
  removeIfExists(clientPidFile);
  removeIfExists(clientLogFile);
  removeEmptyDir(stateDir);
  removeEmptyDir(logsDir);
  console.log("Removed DP Isolate launcher state where present.");
}

function readEnv(name) {
  const envFiles = [
    path.join(root, ".env"),
    path.join(root, "docker", "legacy-portal", ".env"),
    path.join(root, "client", "dp-isolate", ".env.local"),
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
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/))
      .filter(Boolean)
      .map((match) => [match[1], stripQuotes(match[2].trim())]),
  );
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseListEnv(name, defaults) {
  const raw = process.env[name] || readEnv(name);
  if (!raw) return defaults;
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? values : defaults;
}

function composeProfiles(defaults) {
  const raw = Object.hasOwn(process.env, "DP_ISOLATE_COMPOSE_PROFILE")
    ? process.env.DP_ISOLATE_COMPOSE_PROFILE
    : readEnv("DP_ISOLATE_COMPOSE_PROFILE");
  if (!raw) return defaults;
  const profiles = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (profiles.length === 1 && profiles[0] === "none") return [];
  return profiles.length ? profiles : defaults;
}

function composeProfileArgs(defaults) {
  return composeProfiles(defaults).flatMap((profile) => ["--profile", profile]);
}

function describeComposeProfiles(profileArgs) {
  const profiles = [];
  for (let index = 0; index < profileArgs.length; index += 2) {
    profiles.push(profileArgs[index + 1]);
  }
  return profiles.length ? `profiles: ${profiles.join(", ")}` : "no profile";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function dockerCompose(args) {
  return spawnSync("docker", ["compose", "-f", composeFile, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function runDockerComposeLive(args) {
  return new Promise((resolve, reject) => {
    const command = ["docker", "compose", "-f", composeFile, ...args].join(" ");
    let lastOutputAt = Date.now();
    console.log(`Running: ${command}`);
    const child = spawn("docker", ["compose", "-f", composeFile, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const heartbeat = setInterval(() => {
      if (Date.now() - lastOutputAt >= 15000) {
        console.log("docker compose is still running...");
        lastOutputAt = Date.now();
      }
    }, 5000);
    child.stdout.on("data", (chunk) => {
      lastOutputAt = Date.now();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      lastOutputAt = Date.now();
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      clearInterval(heartbeat);
      reject(error);
    });
    child.on("exit", (code) => {
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
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000 });
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
      const remainingSeconds = Math.max(
        0,
        Math.ceil((deadline - Date.now()) / 1000),
      );
      console.log(
        `${label} is not ready yet; waiting up to ${remainingSeconds}s more...`,
      );
      nextNotice = Date.now() + 10000;
    }
    await sleep(1500);
  }
  throw new Error(
    `${label} did not become ready within ${Math.round(timeoutMs / 1000)}s: ${url}`,
  );
}

function isHttpReady(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 3000 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

function readPid() {
  if (!fs.existsSync(clientPidFile)) return null;
  const pid = Number(fs.readFileSync(clientPidFile, "utf8").trim());
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
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
    }
  }
}

function openUrl(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
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
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  return lines.slice(-maxLines).join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
