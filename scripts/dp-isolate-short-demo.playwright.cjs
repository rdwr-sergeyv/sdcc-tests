#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const stateDir = path.join(root, '.tmp', 'dp-isolate');
const stateFile = path.join(stateDir, 'playwright-demo-state.json');
const userDataDir = path.join(stateDir, 'playwright-profile');
const clientUrl = process.env.DP_ISOLATE_CLIENT_URL || 'http://localhost:5173';

const HAPPY_ASSET_ID = '5e5bb8fa2cbdfd02c6581656';
const INSUFFICIENT_DPS_ASSET_ID = '67f502c30f9d41266261bc50';
const NO_ACTIVE_INCIDENT_ASSET_ID = '6575808ecc009ff81b5124b2';

const args = new Set(process.argv.slice(2));
const resume = args.has('--resume');
const fresh = args.has('--fresh') || args.has('--reset');

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
    shell: process.platform === 'win32',
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

function stopAfterPromptText() {
  return [
    'Demo complete. The short demo environment is still running.',
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
      name: 'Start short environment',
      run: async () => {
        await pause(rl, 'Starting Mongo, portal/API, and UI client only. Workers stay stopped.');
        run('make', ['portal-ui-up']);
        restoreReady();
        run('make', ['client-up']);
        await openClient(page);
        await pause(rl, 'UI is open. Confirm login/session and asset list, then continue.');
      },
    },
    {
      name: 'Enable isolation',
      run: async () => {
        restoreReady();
        await openClient(page);
        await setAsset(page, HAPPY_ASSET_ID);
        await pause(rl, `Scenario 1: asset ${HAPPY_ASSET_ID} is selected. Click is automated next; explain the pre-isolation state now.`);
        await clickAction(page, 'enable');
        snapshot(HAPPY_ASSET_ID);
        await pause(rl, 'Explain: isolated=true, zone=attack_zone, per-diversion original_selected_dp_ids saved, tasks/logs created but not executed.');
      },
    },
    {
      name: 'Disable isolation',
      run: async () => {
        await openClient(page);
        await setAsset(page, HAPPY_ASSET_ID);
        await pause(rl, 'Scenario 2: disable the same isolated incident. Click is automated next.');
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
        await setAsset(page, INSUFFICIENT_DPS_ASSET_ID);
        await pause(rl, `Scenario 3: asset ${INSUFFICIENT_DPS_ASSET_ID}. Show the not-applicable row/client validation, then continue.`);
        await clickAction(page, 'enable');
        snapshot(INSUFFICIENT_DPS_ASSET_ID);
        await pause(rl, 'Explain: backend rejects with HTTP 422; no isolation tasks/logs should be created.');
      },
    },
    {
      name: 'Already isolated no-op',
      run: async () => {
        restoreReady();
        await openClient(page);
        await setAsset(page, HAPPY_ASSET_ID);
        await pause(rl, 'Scenario 4: first enable creates isolation state and tasks. Click is automated next.');
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
        await setAsset(page, NO_ACTIVE_INCIDENT_ASSET_ID);
        await pause(rl, `Scenario 5: asset ${NO_ACTIVE_INCIDENT_ASSET_ID} has no active incident. Enable/disable clicks are automated next.`);
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
