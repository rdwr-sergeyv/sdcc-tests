#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const resume = args.has('--resume');
const fresh = args.has('--fresh') || args.has('--reset');
const backend = args.has('--backend') || args.has('--backend-build-only');
const stateDir = path.join(root, '.tmp', 'dp-isolate');
const stateFile = path.join(stateDir, backend ? 'playwright-demo-backend-state.json' : 'playwright-demo-state.json');
const userDataDir = path.join(stateDir, 'playwright-profile');
const clientUrl = process.env.DP_ISOLATE_CLIENT_URL || 'http://localhost:5173';

const HAPPY_ASSET_ID = '5e5bb8fa2cbdfd02c6581656';
const INSUFFICIENT_DPS_ASSET_ID = '67f502c30f9d41266261bc50';
const NO_ACTIVE_INCIDENT_ASSET_ID = '6575808ecc009ff81b5124b2';
const PRIMARY_SC_ID = '5e08d6bc2cbdfd701f0c2936';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readState() {
  if (!resume || !fs.existsSync(stateFile)) return { nextStep: 0 };
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

function writeState(nextStep) {
  ensureDir(stateDir);
  fs.writeFileSync(stateFile, `${JSON.stringify({ nextStep }, null, 2)}\n`);
}

function clearState() {
  if (fs.existsSync(stateFile)) fs.rmSync(stateFile, { force: true });
}

function run(command, commandArgs, options = {}) {
  console.log(`\n+ ${[command, ...commandArgs].join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32' && command === 'make',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stdout || ''}${result.stderr || ''}` : '';
    throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status}${details}`);
  }
  return result.stdout || '';
}

async function pause(rl, message) {
  console.log(`\n${message}`);
  await rl.question('Press Enter to continue...');
}

async function openClient(page) {
  await page.goto(clientUrl);
  await page.locator('#enableButton').waitFor({ timeout: 60000 });
}

async function setDemoGuide(page, guide) {
  await page.evaluate((nextGuide) => {
    window.dpIsolateSetDemoGuide?.(nextGuide);
  }, guide);
}

async function setAsset(page, assetId) {
  await page.locator('#assetSearch').fill(assetId);
  await page.locator('#assetId').evaluate((input, value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, assetId);
}

async function clickAction(page, action) {
  const button = action === 'enable' ? '#enableButton' : '#disableButton';
  await page.locator(button).click();
  await page.waitForTimeout(1200);
  await printResult(page);
}

async function printResult(page) {
  const meta = await page.locator('#resultMeta').textContent().catch(() => '');
  const lastRequest = await page.locator('#lastRequest').textContent().catch(() => '');
  const body = await page.locator('#responseBox').textContent().catch(() => '');
  console.log('\nUI result:');
  console.log(lastRequest || '(no request)');
  console.log(meta || '(no result meta)');
  console.log(body || '{}');
}

function restoreReady() {
  run('make', ['restore-ready']);
}

function snapshot(assetId = HAPPY_ASSET_ID) {
  run('make', ['task-snapshot', `ASSET_ID=${assetId}`]);
}

function mongoEval(script) {
  const container = process.env.LEGACY_PORTAL_MONGO_CONTAINER || 'legacy-portal-mongo-1';
  const dbName = process.env.SDCC_MONGO_DB || 'sdcc';
  run('docker', ['exec', container, 'mongosh', dbName, '--quiet', '--eval', script], { capture: true });
}

function exhaustAttackZoneDpPolicySlots(scId = PRIMARY_SC_ID) {
  mongoEval(`(() => {
    const attackZone = db.DPZones.findOne({ name: 'attack_zone' })._id;
    const sc = db.ScrubbingCenters.findOne({ _id: ObjectId('${scId}') });
    const attackZoneDpIds = (sc.management_devices || [])
      .filter((device) => device.type === 'radware-defensepro' && String(device.zone) === String(attackZone))
      .map((device) => device.unique_id);

    db.ScrubbingCenters.updateOne(
      { _id: sc._id },
      { $set: { 'management_devices.$[dp].max_policies': 1 } },
      { arrayFilters: [{ 'dp.unique_id': { $in: attackZoneDpIds } }] }
    );
    db.ScrubbingCenterDeviceStatuses.updateMany(
      {
        '_id.scrubbing_center': sc._id,
        '_id.device_uid': { $in: attackZoneDpIds },
      },
      { $set: { op_status: 1, num_policies: 1 } }
    );
  })()`);
}

async function postEnable(page, assetId, payload) {
  const result = await page.evaluate(async ({ selectedAssetId, body }) => {
    const path = `/api/incident/isolation/enable/${selectedAssetId}`;
    const response = await fetch(`/api/incident/isolation/enable/${selectedAssetId}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    const resultBody = { status: response.status, body: parsed };
    const lastRequest = document.querySelector('#lastRequest');
    const resultMeta = document.querySelector('#resultMeta');
    const responseBox = document.querySelector('#responseBox');
    const statusBadge = document.querySelector('#statusBadge');
    if (lastRequest) lastRequest.textContent = `POST ${path}`;
    if (resultMeta) resultMeta.textContent = `HTTP ${response.status} ${response.statusText}; ok=${response.ok}`;
    if (responseBox) responseBox.textContent = JSON.stringify({
      time: new Date().toLocaleTimeString(),
      method: 'POST',
      path,
      action: 'enable',
      assetId: selectedAssetId,
      trigger: body.trigger,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      body: parsed,
    }, null, 2);
    if (statusBadge) {
      statusBadge.textContent = String(response.status);
      statusBadge.dataset.tone = response.ok ? 'good' : 'bad';
    }
    return resultBody;
  }, { selectedAssetId: assetId, body: payload });

  console.log('\nAPI result:');
  console.log(`POST /api/incident/isolation/enable/${assetId}`);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function stopAfterPromptText() {
  return [
    `Demo complete. The ${backend ? 'backend' : 'short'} demo environment is still running.`,
    'Stop it later with: make -C sdcc-tests stop',
  ].join('\n');
}

async function main() {
  if (fresh) clearState();
  const state = readState();
  const rl = readline.createInterface({ input, output });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1440, height: 1000 },
  });
  const page = context.pages()[0] || await context.newPage();

  const steps = [
    {
      name: backend ? 'Start backend environment' : 'Start short environment',
      run: async () => {
        await pause(
          rl,
          backend
            ? 'Starting Mongo, portal/API, backend workers, and UI client. Backend task execution defaults to build-only.'
            : 'Starting Mongo, portal/API, and UI client only. Workers stay stopped.',
        );
        if (backend) {
          run('make', ['portal-up']);
          run('make', ['portal-license-backends']);
        } else {
          run('make', ['portal-ui-up']);
        }
        restoreReady();
        run('make', ['client-up']);
        await openClient(page);
        await setDemoGuide(page, {
          title: backend ? 'Backend build-only demo startup' : 'Short UI-only demo startup',
          auto: [
            backend ? 'Starts Mongo, portal, incident-manager, and cmd-executor.' : 'Starts Mongo and portal while backend workers stay stopped.',
            'Restores the ready-for-tests fixture.',
            'Starts the Vite DP Isolate client and opens this page.',
          ],
          user: [
            'Confirm the login badge and asset list are visible.',
            'Press Enter in the console after checking the page is loaded.',
          ],
          expected: [
            backend ? 'Backend containers run with SDCC_TASK_TYPE=build.' : 'API calls can create task records, but workers do not execute them.',
            'The client is ready for the first scenario.',
          ],
        });
        await pause(rl, 'UI is open. Confirm login/session and asset list, then continue.');
      },
    },
    {
      name: 'Enable isolation',
      run: async () => {
        restoreReady();
        await openClient(page);
        await setDemoGuide(page, {
          title: 'Enable isolation',
          auto: [
            'Restores the fixture before the scenario.',
            `Selects asset ${HAPPY_ASSET_ID}.`,
            'Clicks Enable Isolation after the console checkpoint.',
            'Prints a task snapshot after the response.',
          ],
          user: [
            'Explain that the incident starts in the account zone.',
            'Press Enter to let the script send the enable request.',
            'Review the response and task snapshot.',
          ],
          expected: [
            'The API returns HTTP 200.',
            'The incident becomes isolated in attack_zone.',
            backend ? 'Build-only workers complete generated task work without touching devices.' : 'Task/log records are created but workers are stopped.',
          ],
        });
        await setAsset(page, HAPPY_ASSET_ID);
        await pause(rl, `Scenario: asset ${HAPPY_ASSET_ID} is selected. Click is automated next; explain the pre-isolation state now.`);
        await clickAction(page, 'enable');
        snapshot(HAPPY_ASSET_ID);
        await pause(
          rl,
          backend
            ? 'Explain: isolated=true, zone=attack_zone, per-diversion original_selected_dp_ids saved, and backend workers complete build-only tasks without device execution.'
            : 'Explain: isolated=true, zone=attack_zone, per-diversion original_selected_dp_ids saved, tasks/logs created but not executed.',
        );
      },
    },
    {
      name: 'Disable isolation',
      run: async () => {
        await openClient(page);
        await setDemoGuide(page, {
          title: 'Disable isolation',
          auto: [
            `Keeps asset ${HAPPY_ASSET_ID} selected after the enable scenario.`,
            'Clicks Disable Isolation after the console checkpoint.',
            'Prints a task snapshot after rollback.',
          ],
          user: [
            'Explain that rollback should use the saved original DP selection.',
            'Press Enter to let the script send the disable request.',
            'Review the cleared isolation state.',
          ],
          expected: [
            'The API returns HTTP 200.',
            'The incident leaves isolation.',
            'Saved original_selected_dp_ids are consumed and cleared.',
          ],
        });
        await setAsset(page, HAPPY_ASSET_ID);
        await pause(rl, 'Scenario: disable the same isolated incident. Click is automated next.');
        await clickAction(page, 'disable');
        snapshot(HAPPY_ASSET_ID);
        await pause(rl, 'Explain: isolated=false, rollback used saved per-diversion DP IDs and cleared them.');
      },
    },
    {
      name: 'Not enough Attack Zone DPs',
      run: async () => {
        restoreReady();
        await openClient(page);
        await setDemoGuide(page, {
          title: 'Not enough Attack Zone DPs',
          auto: [
            'Restores the fixture before the scenario.',
            `Selects asset ${INSUFFICIENT_DPS_ASSET_ID}.`,
            'Clicks Enable Isolation after the console checkpoint.',
            'Prints a task snapshot for the rejected asset.',
          ],
          user: [
            'Point out the blocked readiness in the asset picker.',
            'Press Enter to let the script send the enable request.',
            'Review the backend error.',
          ],
          expected: [
            'The API returns HTTP 422.',
            'The error says the scrubbing center does not have enough Attack Zone DefensePro devices.',
            'No isolation task/log work is created.',
          ],
        });
        await setAsset(page, INSUFFICIENT_DPS_ASSET_ID);
        await pause(rl, `Scenario: asset ${INSUFFICIENT_DPS_ASSET_ID}. Show the not-applicable row/client validation, then continue.`);
        await clickAction(page, 'enable');
        snapshot(INSUFFICIENT_DPS_ASSET_ID);
        await pause(rl, 'Explain: backend rejects with HTTP 422; no isolation tasks/logs should be created.');
      },
    },
    ...(backend ? [
      {
        name: 'Invalid isolation trigger',
        run: async () => {
          restoreReady();
          await openClient(page);
          await setDemoGuide(page, {
            title: 'Invalid isolation trigger',
            auto: [
              'Restores the fixture before the scenario.',
              `Selects asset ${HAPPY_ASSET_ID}.`,
              'Sends a direct enable request with trigger=invalid-value through the browser session.',
              'Prints a task snapshot after the rejected request.',
            ],
            user: [
              'Explain that valid trigger values are manual and auto.',
              'Press Enter to let the script send the invalid request.',
              'Review the HTTP 400 response.',
            ],
            expected: [
              'The API returns HTTP 400.',
              'The response says: Invalid trigger. Expected one of: manual, auto.',
              'The incident remains not isolated and no task/log work is created.',
            ],
          });
          await setAsset(page, HAPPY_ASSET_ID);
          await pause(rl, `Scenario: invalid ISOLATION_TRIGGER for asset ${HAPPY_ASSET_ID}. The request is sent through the logged-in browser session next.`);
          await postEnable(page, HAPPY_ASSET_ID, { trigger: 'invalid-value' });
          snapshot(HAPPY_ASSET_ID);
          await pause(rl, 'Explain: backend rejects with HTTP 400 and "Invalid trigger. Expected one of: manual, auto"; no isolation tasks/logs are created.');
        },
      },
      {
        name: 'No free Attack Zone DP policy slots',
        run: async () => {
          restoreReady();
          exhaustAttackZoneDpPolicySlots();
          await openClient(page);
          await setDemoGuide(page, {
            title: 'No free Attack Zone DP policy slots',
            auto: [
              'Restores the fixture before the scenario.',
              'Sets Attack Zone DPs to max_policies=1 and num_policies=1.',
              `Selects asset ${HAPPY_ASSET_ID}.`,
              'Clicks Enable Isolation after the console checkpoint.',
            ],
            user: [
              'Explain that Attack Zone DPs exist but have no unallocated policy slots.',
              'Press Enter to let the script send the enable request.',
              'Compare the error with the existing incident create/update behavior.',
            ],
            expected: [
              'The API returns HTTP 422.',
              'The error is the same not-enough Attack Zone DefensePro message.',
              'No isolation task/log work is created.',
            ],
          });
          await setAsset(page, HAPPY_ASSET_ID);
          await pause(rl, 'Scenario: Attack Zone DPs exist, but their policy capacity is exhausted by setting max_policies=1 and num_policies=1. Click is automated next.');
          await clickAction(page, 'enable');
          snapshot(HAPPY_ASSET_ID);
          await pause(rl, 'Explain: backend rejects with the same not-enough Attack Zone DefensePro error used by incident create/update; no isolation tasks/logs are created.');
        },
      },
    ] : []),
    {
      name: 'Already isolated no-op',
      run: async () => {
        restoreReady();
        await openClient(page);
        await setDemoGuide(page, {
          title: 'Already isolated no-op',
          auto: [
            'Restores the fixture before the scenario.',
            `Selects asset ${HAPPY_ASSET_ID}.`,
            'Sends one enable request, then sends a second enable request for the already isolated incident.',
            'Prints task snapshots after both requests.',
          ],
          user: [
            'Press Enter to create the isolated state.',
            'Press Enter again to repeat the enable request.',
            'Confirm the second request does not duplicate work.',
          ],
          expected: [
            'Both requests return HTTP 200.',
            'The second enable is a successful no-op.',
            'No duplicate isolation task work is created.',
          ],
        });
        await setAsset(page, HAPPY_ASSET_ID);
        await pause(rl, 'Scenario: first enable creates isolation state and tasks. Click is automated next.');
        await clickAction(page, 'enable');
        snapshot(HAPPY_ASSET_ID);
        await pause(rl, 'Now repeat enable for the already-isolated incident. Click is automated next.');
        await clickAction(page, 'enable');
        snapshot(HAPPY_ASSET_ID);
        await pause(rl, 'Explain: second enable is HTTP 200 no-op and should not create duplicate task work.');
      },
    },
    {
      name: 'Missing active incident no-op',
      run: async () => {
        restoreReady();
        await openClient(page);
        await setDemoGuide(page, {
          title: 'Missing active incident no-op',
          auto: [
            'Restores the fixture before the scenario.',
            `Selects asset ${NO_ACTIVE_INCIDENT_ASSET_ID}.`,
            'Clicks Enable Isolation and Disable Isolation.',
            'Prints a task snapshot for the asset.',
          ],
          user: [
            'Explain that this asset has no active incident.',
            'Press Enter to let the script send both no-op requests.',
            'Review that no incident or task state is created.',
          ],
          expected: [
            'Enable and disable both return HTTP 200.',
            'No active incident is created.',
            'No isolation task/log work is created.',
          ],
        });
        await setAsset(page, NO_ACTIVE_INCIDENT_ASSET_ID);
        await pause(rl, `Scenario: asset ${NO_ACTIVE_INCIDENT_ASSET_ID} has no active incident. Enable/disable clicks are automated next.`);
        await clickAction(page, 'enable');
        await clickAction(page, 'disable');
        snapshot(NO_ACTIVE_INCIDENT_ASSET_ID);
        await pause(rl, 'Explain: both calls return HTTP 200 no-op; no incident/task/log is created.');
      },
    },
  ];

  try {
    for (let index = state.nextStep || 0; index < steps.length; index += 1) {
      console.log(`\n\n=== Step ${index + 1}/${steps.length}: ${steps[index].name} ===`);
      writeState(index);
      await steps[index].run();
      writeState(index + 1);
    }
    clearState();
    console.log(`\n${stopAfterPromptText()}`);
  } finally {
    await rl.close();
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
