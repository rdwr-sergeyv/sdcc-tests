const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { expect } = require('playwright/test');

const root = path.resolve(__dirname, '../..');

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

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

function env() {
  return {
    ...loadEnvFile(path.join(root, '.env')),
    ...loadEnvFile(path.join(root, 'docker', 'legacy-portal', '.env')),
    ...process.env,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stdout || ''}${result.stderr || ''}` : '';
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}${details}`);
  }
  return result.stdout || '';
}

function restoreReadyForTests() {
  const config = env();
  run(process.execPath, [
    'tools/dp-isolate-fixtures/restore.cjs',
    'ready-for-tests',
    '--yes',
    '--container',
    config.LEGACY_PORTAL_MONGO_CONTAINER || 'legacy-portal-mongo-1',
    '--db',
    config.SDCC_MONGO_DB || 'sdcc',
  ]);
}

function docker(args, options = {}) {
  return run('docker', args, options);
}

function mongoEval(script) {
  const config = env();
  return run('docker', [
    'exec',
    config.LEGACY_PORTAL_MONGO_CONTAINER || 'legacy-portal-mongo-1',
    'mongosh',
    config.SDCC_MONGO_DB || 'sdcc',
    '--quiet',
    '--eval',
    script,
  ], { capture: true });
}

function mongoJson(expression) {
  const output = mongoEval(`const result = (${expression}); print(EJSON.stringify(result));`).trim();
  return JSON.parse(output);
}

async function login(request) {
  const config = env();
  const baseUrl = config.SDCC_PORTAL_PUBLIC_URL || `http://localhost:${config.LEGACY_PORTAL_PORT || 8000}`;
  const response = await request.post(`${baseUrl}/api/auth/`, {
    data: {
      u: config.PORTAL_USER || 'twister@example.com',
      p: config.PORTAL_PASSWORD || 'd0sattack',
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  return baseUrl;
}

async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const intervalMs = options.intervalMs || 500;
  const started = Date.now();
  let lastValue;
  let lastError;

  while (Date.now() - started < timeoutMs) {
    try {
      lastValue = predicate();
      if (lastValue) {
        return lastValue;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition. Last value: ${JSON.stringify(lastValue)}`);
}

module.exports = {
  docker,
  env,
  login,
  mongoEval,
  mongoJson,
  restoreReadyForTests,
  root,
  waitFor,
};
