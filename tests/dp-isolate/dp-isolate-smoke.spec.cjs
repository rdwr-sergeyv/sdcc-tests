const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, expect } = require('playwright/test');

const root = path.resolve(__dirname, '../..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
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

function env() {
  return {
    ...loadEnvFile(path.join(root, '.env')),
    ...loadEnvFile(path.join(root, 'docker', 'legacy-portal', '.env')),
    ...process.env,
  };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

function restoreReadyForTests() {
  const config = env();
  const args = [
    'tools/dp-isolate-fixtures/restore.cjs',
    'ready-for-tests',
    '--yes',
    '--container',
    config.LEGACY_PORTAL_MONGO_CONTAINER || 'legacy-portal-mongo-1',
    '--db',
    config.SDCC_MONGO_DB || 'sdcc',
  ];
  run(process.execPath, args);
}

test.describe('DP Isolate API smoke', () => {
  test.beforeAll(() => {
    restoreReadyForTests();
  });

  test.afterAll(() => {
    restoreReadyForTests();
  });

  test('logs in and probes assets and active incidents', async ({ request }) => {
    const config = env();
    const baseUrl = config.SDCC_PORTAL_PUBLIC_URL || `http://localhost:${config.LEGACY_PORTAL_PORT || 8000}`;
    const username = config.PORTAL_USER || 'twister@example.com';
    const password = config.PORTAL_PASSWORD || 'd0sattack';

    const login = await request.post(`${baseUrl}/api/auth/`, {
      data: { u: username, p: password },
    });
    expect(login.status(), await login.text()).toBe(200);
    const loginBody = await login.json();
    expect(loginBody.username).toBeTruthy();

    const assets = await request.get(`${baseUrl}/api/assets/?size=500&sort=name`);
    expect(assets.status(), await assets.text()).toBe(200);
    const assetsBody = await assets.json();
    const assetRows = assetsBody.reply || assetsBody.objects || assetsBody.results || [];
    expect(Array.isArray(assetRows)).toBe(true);
    expect(assetRows.length).toBeGreaterThan(0);

    const incidents = await request.get(`${baseUrl}/api/incident/active-and-queue`);
    expect(incidents.status(), await incidents.text()).toBe(200);
    const incidentsBody = await incidents.json();
    expect(Array.isArray(incidentsBody.reply)).toBe(true);
    expect(incidentsBody.reply.length).toBeGreaterThan(0);
  });
});
