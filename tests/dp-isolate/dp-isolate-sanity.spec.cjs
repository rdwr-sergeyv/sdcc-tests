const { test, expect } = require('playwright/test');
const {
  docker,
  env,
  mongoJson,
} = require('./dp-isolate-helpers.cjs');

const REQUIRED_EXECUTOR_MODULE = 'sdcc_cmd_executor';

function readCmdExecutorBackendName() {
  const config = env();
  const container = config.LEGACY_PORTAL_CMD_EXECUTOR_CONTAINER || 'legacy-portal-cmd-executor-1';
  const confPath = config.SDCC_CONF_PATH || '/etc/sdcc/sdcc.conf';

  return docker([
    'exec',
    container,
    'python',
    '-c',
    `
import sys
from pathlib import Path

conf_path = sys.argv[1]
conf = Path(conf_path).read_text()
in_backend = False
for raw_line in conf.splitlines():
    line = raw_line.rstrip()
    if line and not line.startswith(' '):
        in_backend = line == 'backend:'
        continue
    if in_backend:
        stripped = line.strip()
        if stripped.startswith('name:'):
            print(stripped.split(':', 1)[1].strip())
            break
else:
    raise SystemExit(f'backend.name not found in {conf_path}')
`,
    confPath,
  ], { capture: true }).trim();
}

function backendSnapshot() {
  return mongoJson(`(() => {
    const backends = db.Backends.find({}, { name: 1, role: 1, active: 1, ip_addr: 1 }).sort({ name: 1 }).toArray();
    return backends.map((backend) => ({
      id: String(backend._id),
      name: backend.name,
      role: backend.role || null,
      active: backend.active === undefined ? null : Boolean(backend.active),
      ip_addr: backend.ip_addr || null,
    }));
  })()`);
}

function localBackendSnapshot(backendName) {
  return mongoJson(`(() => {
    const backend = db.Backends.findOne(
      { name: ${JSON.stringify(backendName)} },
      { name: 1, role: 1, active: 1, ip_addr: 1, licensed_modules: 1 },
    );
    if (!backend) return null;
    return {
      id: String(backend._id),
      name: backend.name,
      role: backend.role || null,
      active: backend.active === undefined ? null : Boolean(backend.active),
      ip_addr: backend.ip_addr || null,
      licensed_modules: backend.licensed_modules || {},
    };
  })()`);
}

function validateCmdExecutorModuleLicense(moduleName) {
  const config = env();
  const container = config.LEGACY_PORTAL_CMD_EXECUTOR_CONTAINER || 'legacy-portal-cmd-executor-1';

  return docker([
    'exec',
    container,
    'sdcc-manage-module',
    '-a',
    'validate',
    '-m',
    moduleName,
  ], { capture: true });
}

test.describe('DP Isolate environment sanity', () => {
  test('local backend name is declared in db.Backends', () => {
    const expectedBackendName = readCmdExecutorBackendName();
    const declaredBackends = backendSnapshot();
    const declaredNames = declaredBackends.map((backend) => backend.name).filter(Boolean);

    expect(
      declaredNames,
      `local /etc/sdcc/sdcc.conf backend.name=${expectedBackendName}; db.Backends names=${declaredNames.join(', ')}`,
    ).toContain(expectedBackendName);
  });

  test('local backend has a working cmd-executor license', () => {
    const expectedBackendName = readCmdExecutorBackendName();
    const backend = localBackendSnapshot(expectedBackendName);

    expect(backend, `db.Backends does not declare local backend ${expectedBackendName}`).toBeTruthy();

    const licensedModules = Object.keys(backend.licensed_modules);
    expect(
      licensedModules,
      `db.Backends.${expectedBackendName}.licensed_modules names=${licensedModules.join(', ') || '(none)'}`,
    ).toContain(REQUIRED_EXECUTOR_MODULE);

    const output = validateCmdExecutorModuleLicense(REQUIRED_EXECUTOR_MODULE);

    expect(output).toContain('SDCC license is valid');
  });
});
