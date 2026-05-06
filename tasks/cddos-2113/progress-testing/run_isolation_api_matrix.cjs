#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const sdccTestsRoot = path.resolve(__dirname, '../../../..');
const defaultReportPath = path.join(sdccTestsRoot, 'artifacts', 'dp-isolate-progress-testing-report.json');

const config = {
  portalOrigin: process.env.PORTAL_ORIGIN || 'http://localhost:8000',
  username: process.env.PORTAL_USER || process.env.DP_ISOLATE_USERNAME || '',
  password: process.env.PORTAL_PASSWORD || process.env.DP_ISOLATE_PASSWORD || '',
  mongoContainer: process.env.LEGACY_PORTAL_MONGO_CONTAINER || 'legacy-portal-mongo-1',
  mongoDb: process.env.SDCC_MONGO_DB || 'sdcc',
  reportPath: process.env.DP_ISOLATE_REPORT || defaultReportPath,
  defaultTimeoutSeconds: Number(process.env.DP_ISOLATE_TASK_TIMEOUT_SECONDS || 180),
  defaultPollSeconds: Number(process.env.DP_ISOLATE_TASK_POLL_SECONDS || 5),
};

function usage() {
  console.log([
    'Run DP Isolate live API matrix tests.',
    '',
    'Required:',
    '  PORTAL_USER / PORTAL_PASSWORD, or DP_ISOLATE_USERNAME / DP_ISOLATE_PASSWORD',
    '  Happy-path asset IDs, edge-case asset IDs, or DP_ISOLATE_SCENARIOS_JSON',
    '',
    'Happy path first:',
    '  DP_ISOLATE_HAPPY_PATH_ASSET_ID=<asset ObjectId>',
    '    Runs enable, waits for created work, then runs disable on the same asset.',
    '',
    'Separate happy-path assets:',
    '  DP_ISOLATE_ENABLE_VALID_ASSET_ID=<asset ObjectId>',
    '  DP_ISOLATE_DISABLE_VALID_ASSET_ID=<asset ObjectId>',
    '',
    'Opt-in edge/invalid scenarios:',
    '  DP_ISOLATE_INCLUDE_EDGE_CASES=1',
    '  DP_ISOLATE_ENABLE_INVALID_ASSET_ID=<asset ObjectId or invalid path value>',
    '  DP_ISOLATE_DISABLE_INVALID_ASSET_ID=<asset ObjectId or invalid path value>',
    '',
    'Custom scenarios:',
    '  DP_ISOLATE_SCENARIOS_JSON=\'[',
    '    {"name":"enable valid","action":"enable","assetId":"...","trigger":"manual","expectStatus":200,"expectTasks":"created"},',
    '    {"name":"disable no-op","action":"disable","assetId":"...","expectStatus":200,"expectTasks":"none"}',
    '  ]\'',
    '',
    'Optional:',
    '  PORTAL_ORIGIN=http://localhost:8000',
    '  LEGACY_PORTAL_MONGO_CONTAINER=legacy-portal-mongo-1',
    '  SDCC_MONGO_DB=sdcc',
    '  DP_ISOLATE_REPORT=artifacts/dp-isolate-progress-testing-report.json',
    '  DP_ISOLATE_TASK_TIMEOUT_SECONDS=180',
    '',
  ].join('\n'));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function objectIdLike(value) {
  return /^[a-fA-F0-9]{24}$/.test(String(value || ''));
}

function parseScenarios() {
  if (process.env.DP_ISOLATE_SCENARIOS_JSON) {
    const parsed = JSON.parse(process.env.DP_ISOLATE_SCENARIOS_JSON);
    if (!Array.isArray(parsed)) {
      fail('DP_ISOLATE_SCENARIOS_JSON must be a JSON array.');
    }
    return parsed;
  }

  const scenarios = [];
  const happyPathAssetId = process.env.DP_ISOLATE_HAPPY_PATH_ASSET_ID;
  const enableAssetId = process.env.DP_ISOLATE_ENABLE_VALID_ASSET_ID || happyPathAssetId;
  const disableAssetId = process.env.DP_ISOLATE_DISABLE_VALID_ASSET_ID || happyPathAssetId;

  if (enableAssetId) {
    scenarios.push(['happy-enable-valid', 'enable', enableAssetId, 200, 'created']);
  }
  if (disableAssetId) {
    scenarios.push(['happy-disable-valid', 'disable', disableAssetId, 200, 'created']);
  }

  if (process.env.DP_ISOLATE_INCLUDE_EDGE_CASES === '1') {
    scenarios.push(
      ['edge-enable-invalid', 'enable', process.env.DP_ISOLATE_ENABLE_INVALID_ASSET_ID, undefined, 'none'],
      ['edge-disable-invalid', 'disable', process.env.DP_ISOLATE_DISABLE_INVALID_ASSET_ID, undefined, 'none'],
    );
  }

  return scenarios
    .filter(([, , assetId]) => assetId)
    .map(([name, action, assetId, expectStatus, expectTasks]) => ({
      name,
      action,
      assetId,
      trigger: action === 'enable' ? 'manual' : undefined,
      expectStatus,
      expectTasks,
    }));
}

function normalizeScenario(scenario, index) {
  if (!['enable', 'disable'].includes(scenario.action)) {
    fail(`Scenario ${index + 1} has unsupported action: ${scenario.action}`);
  }
  if (!scenario.assetId) {
    fail(`Scenario ${index + 1} is missing assetId.`);
  }
  return {
    name: scenario.name || `${scenario.action}-${index + 1}`,
    action: scenario.action,
    assetId: String(scenario.assetId),
    trigger: scenario.trigger || 'manual',
    expectStatus: scenario.expectStatus,
    expectTasks: scenario.expectTasks || 'any',
    waitForExecution: scenario.waitForExecution !== false,
    timeoutSeconds: Number(scenario.timeoutSeconds || config.defaultTimeoutSeconds),
    pollSeconds: Number(scenario.pollSeconds || config.defaultPollSeconds),
  };
}

function shell(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: sdccTestsRoot,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ''}` : '';
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}${detail}`);
  }
  return result.stdout || '';
}

function mongoEval(script) {
  const evalScript = script.replace(/\s+/g, ' ').trim();
  const wrapped = [
    'set -e',
    'if command -v mongosh >/dev/null 2>&1; then',
    `  mongosh ${shQuote(config.mongoDb)} --quiet --eval ${shQuote(evalScript)}`,
    'else',
    `  mongo ${shQuote(config.mongoDb)} --quiet --eval ${shQuote(evalScript)}`,
    'fi',
  ].join('\n');
  const stdout = shell('docker', ['exec', config.mongoContainer, 'sh', '-lc', wrapped], { capture: true });
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed.split(/\r?\n/).pop());
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function mongoProbe() {
  return mongoEval('print(JSON.stringify({ ok: db.runCommand({ ping: 1 }).ok, db: db.getName() }))');
}

function activeIncidentByAsset(assetId) {
  if (!objectIdLike(assetId)) {
    return null;
  }
  const script = `
    const incident = db.Incidents.findOne({ asset: ObjectId(${JSON.stringify(assetId)}), endedAt: null });
    print(EJSON.stringify(incident || null));
  `;
  return mongoEval(script);
}

function compactIncident(incident) {
  if (!incident) return null;
  const diversions = incident.diversion || [];
  return {
    id: oid(incident._id),
    status: incident.status,
    inQueue: Boolean(incident.in_queue),
    isolated: Boolean(incident.isolation_state && incident.isolation_state.isolated),
    isolatedAt: incident.isolation_state && incident.isolation_state.isolated_at,
    rollbackAt: incident.isolation_state && incident.isolation_state.rollback_at,
    trigger: incident.isolation_state && incident.isolation_state.trigger,
    diversionCount: diversions.length,
    diversionZones: diversions.map((diversion) => oid(diversion.zone)),
    currentTaskIds: unique(diversions.flatMap((diversion) => (diversion.state && diversion.state.curr_tasks) || [])),
    storedTaskIds: unique(diversions.flatMap((diversion) => diversion.tasks || [])),
    originalSelectedDpIds: diversions.map((diversion) => (diversion.original_selected_dp_ids || []).map(oid)),
  };
}

function oid(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value.$oid) return value.$oid;
  if (value._id) return oid(value._id);
  return String(value);
}

function unique(values) {
  return Array.from(new Set(values.map(oid).filter(Boolean)));
}

function taskSnapshot(incident) {
  if (!incident) {
    return { tasks: [], assetTaskLogs: [] };
  }
  const incidentId = oid(incident._id);
  const knownTaskIds = unique((incident.diversion || []).flatMap((diversion) => [
    ...(diversion.tasks || []),
    ...((diversion.state && diversion.state.curr_tasks) || []),
  ]));
  const script = `
    const incidentId = ObjectId(${JSON.stringify(incidentId)});
    const taskIds = ${JSON.stringify(knownTaskIds)}.map((id) => ObjectId(id));
    const taskQuery = taskIds.length ? { _id: { $in: taskIds } } : { _id: { $in: [] } };
    const tasks = db.Tasks.find(taskQuery).sort({ createdAt: 1 }).toArray();
    const logs = db.AssetTasksLogs.find({ incident_id: incidentId }).sort({ createdAt: 1 }).toArray();
    print(EJSON.stringify({ tasks, assetTaskLogs: logs }));
  `;
  return mongoEval(script) || { tasks: [], assetTaskLogs: [] };
}

function compactTasks(snapshot) {
  return {
    tasks: (snapshot.tasks || []).map((task) => ({
      id: oid(task._id),
      status: task.status,
      action: task.command && task.command.action,
      subAction: task.command && task.command.sub_action,
      device: task.command && oid(task.command.device),
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      message: task.message,
    })),
    assetTaskLogs: (snapshot.assetTaskLogs || []).map((log) => ({
      id: oid(log._id),
      status: log.status,
      action: log.action,
      scId: oid(log.sc_id),
      deviceId: oid(log.device_id),
      createdAt: log.createdAt,
      startedAt: log.startedAt,
      endedAt: log.endedAt,
      message: log.message,
    })),
  };
}

function diffIds(beforeItems, afterItems) {
  const before = new Set((beforeItems || []).map((item) => item.id));
  return (afterItems || []).filter((item) => !before.has(item.id));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login() {
  const jar = new Map();
  const response = await request('/api/auth/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u: config.username, p: config.password }),
  }, jar);
  if (!response.ok) {
    fail(`Login failed with HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return jar;
}

function cookieHeader(jar) {
  return Array.from(jar.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
}

function storeCookies(jar, headers) {
  const setCookie = headers.getSetCookie ? headers.getSetCookie() : splitSetCookie(headers.get('set-cookie'));
  for (const cookie of setCookie || []) {
    const [pair] = cookie.split(';');
    const separator = pair.indexOf('=');
    if (separator > 0) {
      jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,\s]+=)/);
}

async function request(route, options, jar) {
  const headers = new Headers(options.headers || {});
  if (jar && jar.size) {
    headers.set('Cookie', cookieHeader(jar));
  }
  const response = await fetch(new URL(route, config.portalOrigin), {
    ...options,
    headers,
    redirect: 'manual',
  });
  if (jar) {
    storeCookies(jar, response.headers);
  }
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

async function waitForTaskExecution(scenario, incidentId, baselineIds) {
  const deadline = Date.now() + scenario.timeoutSeconds * 1000;
  let latest = null;
  let pollCount = 0;
  while (Date.now() <= deadline) {
    pollCount += 1;
    const incident = activeIncidentByAsset(scenario.assetId);
    if (!incident || oid(incident._id) !== incidentId) {
      return { timedOut: false, incident: compactIncident(incident), tasks: compactTasks({ tasks: [], assetTaskLogs: [] }) };
    }
    latest = compactTasks(taskSnapshot(incident));
    const newTasks = diffIds(baselineIds.tasks, latest.tasks);
    const newLogs = diffIds(baselineIds.assetTaskLogs, latest.assetTaskLogs);
    const executableItems = newTasks.length ? newTasks : newLogs;
    const statuses = executableItems.map((task) => task.status || 'unknown');
    console.log(
      `poll ${pollCount}: ${newTasks.length} task(s), ${newLogs.length} log(s), statuses: ${statuses.join(', ') || 'none'}`,
    );
    if (executableItems.length && executableItems.every((task) => ['done', 'failed'].includes(task.status))) {
      return { timedOut: false, incident: compactIncident(incident), tasks: latest };
    }
    await sleep(scenario.pollSeconds * 1000);
  }
  return { timedOut: true, incident: compactIncident(activeIncidentByAsset(scenario.assetId)), tasks: latest };
}

function checkExpectations(scenario, observation) {
  const failures = [];
  if (scenario.expectStatus !== undefined && observation.response.status !== scenario.expectStatus) {
    failures.push(`expected HTTP ${scenario.expectStatus}, got ${observation.response.status}`);
  }
  const createdCount = observation.tasks.created.tasks.length + observation.tasks.created.assetTaskLogs.length;
  if (scenario.expectTasks === 'created' && createdCount === 0) {
    failures.push('expected at least one task/log to be created');
  }
  if (scenario.expectTasks === 'none' && createdCount !== 0) {
    failures.push(`expected no created tasks/logs, got ${createdCount}`);
  }
  if (observation.execution && observation.execution.timedOut) {
    failures.push(`task execution did not reach DONE/FAILED within ${scenario.timeoutSeconds}s`);
  }
  return failures;
}

async function runScenario(scenario, jar) {
  console.log(`\n== ${scenario.name} (${scenario.action}) ==`);
  console.log('reading pre-request incident and task state...');
  const beforeIncident = activeIncidentByAsset(scenario.assetId);
  const beforeTasks = compactTasks(taskSnapshot(beforeIncident));
  const route = `/api/incident/isolation/${scenario.action}/${scenario.assetId}`;
  const body = scenario.action === 'enable' ? { trigger: scenario.trigger } : {};

  console.log(`sending POST ${route}...`);
  const response = await request(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, jar);

  console.log('reading immediate incident and task state...');
  const immediateIncident = activeIncidentByAsset(scenario.assetId);
  const immediateTasks = compactTasks(taskSnapshot(immediateIncident));
  const created = {
    tasks: diffIds(beforeTasks.tasks, immediateTasks.tasks),
    assetTaskLogs: diffIds(beforeTasks.assetTaskLogs, immediateTasks.assetTaskLogs),
  };

  let execution = null;
  if (scenario.waitForExecution && objectIdLike(scenario.assetId) && immediateIncident && (
    created.tasks.length || created.assetTaskLogs.length
  )) {
    console.log(`polling task execution for up to ${scenario.timeoutSeconds}s...`);
    execution = await waitForTaskExecution(scenario, oid(immediateIncident._id), beforeTasks);
  }

  const observation = {
    scenario,
    request: { method: 'POST', route, body },
    response,
    incident: {
      before: compactIncident(beforeIncident),
      immediate: compactIncident(immediateIncident),
      afterExecution: execution && execution.incident,
    },
    tasks: {
      before: beforeTasks,
      immediate: immediateTasks,
      created,
      afterExecution: execution && execution.tasks,
    },
    execution,
  };
  observation.failures = checkExpectations(scenario, observation);

  console.log(`response: HTTP ${response.status}`);
  console.log(`incident: ${JSON.stringify(observation.incident.immediate)}`);
  console.log(`created tasks/logs: ${created.tasks.length}/${created.assetTaskLogs.length}`);
  if (execution) {
    console.log(`execution: ${execution.timedOut ? 'timed out' : 'terminal status observed'}`);
  }
  if (observation.failures.length) {
    console.log(`failures: ${observation.failures.join('; ')}`);
  }
  return observation;
}

function writeReport(results) {
  const report = {
    createdAt: new Date().toISOString(),
    portalOrigin: config.portalOrigin,
    mongoContainer: config.mongoContainer,
    mongoDb: config.mongoDb,
    results,
  };
  fs.mkdirSync(path.dirname(config.reportPath), { recursive: true });
  fs.writeFileSync(config.reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return;
  }
  if (!config.username || !config.password) {
    usage();
    fail('Portal credentials are required.');
  }
  const scenarios = parseScenarios().map(normalizeScenario);
  if (!scenarios.length) {
    usage();
    fail('No scenarios configured.');
  }

  mongoProbe();
  const jar = await login();
  const results = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, jar));
    writeReport(results);
    console.log(`partial report written to ${config.reportPath}`);
  }

  const failures = results.flatMap((result) => result.failures.map((failure) => `${result.scenario.name}: ${failure}`));
  console.log(`\nReport written to ${config.reportPath}`);
  if (failures.length) {
    fail(`${failures.length} matrix expectation(s) failed:\n${failures.join('\n')}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
