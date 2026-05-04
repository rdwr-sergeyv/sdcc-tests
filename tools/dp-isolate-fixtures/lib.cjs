const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const sdccTestsRoot = path.resolve(__dirname, '../..');
const fixturesRoot = path.join(sdccTestsRoot, 'fixtures', 'dp-isolate');
const defaultContainer = process.env.LEGACY_PORTAL_MONGO_CONTAINER || 'legacy-portal-mongo-1';
const defaultDatabase = process.env.SDCC_MONGO_DB || 'sdcc';

function usage(lines) {
  console.log(lines.join('\n'));
}

function parseArgs(argv) {
  const args = {
    _: [],
    yes: false,
    force: false,
    description: '',
    container: defaultContainer,
    db: defaultDatabase,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--yes') {
      args.yes = true;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--description') {
      args.description = argv[++i] || '';
    } else if (arg === '--container') {
      args.container = argv[++i] || '';
    } else if (arg === '--db') {
      args.db = argv[++i] || '';
    } else if (arg.startsWith('--')) {
      fail(`Unknown option: ${arg}`);
    } else {
      args._.push(arg);
    }
  }

  return args;
}

function validateFixtureName(name) {
  if (!name) {
    fail('Fixture name is required.');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    fail('Fixture name may contain only letters, numbers, dots, underscores, and hyphens.');
  }
  return name;
}

function fixtureDir(name) {
  return path.join(fixturesRoot, validateFixtureName(name));
}

function archivePath(name) {
  return path.join(fixtureDir(name), 'sdcc.archive.gz');
}

function manifestPath(name) {
  return path.join(fixtureDir(name), 'manifest.json');
}

function readManifest(name) {
  const file = manifestPath(name);
  if (!fs.existsSync(file)) {
    fail(`Fixture "${name}" does not have a manifest at ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: sdccTestsRoot,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (result.error) {
    fail(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (options.capture && result.stderr) {
      process.stderr.write(result.stderr);
    }
    fail(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
  return result.stdout || '';
}

function ensureMongoContainer(container) {
  const running = run('docker', ['inspect', '-f', '{{.State.Running}}', container], { capture: true }).trim();
  if (running !== 'true') {
    fail(`Docker container "${container}" is not running.`);
  }
}

function listFixtures() {
  if (!fs.existsSync(fixturesRoot)) {
    return [];
  }

  return fs.readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const name = entry.name;
      const manifestFile = manifestPath(name);
      if (!fs.existsSync(manifestFile)) {
        return { name, manifest: null };
      }
      return { name, manifest: JSON.parse(fs.readFileSync(manifestFile, 'utf8')) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

module.exports = {
  archivePath,
  fail,
  fixtureDir,
  fixturesRoot,
  listFixtures,
  manifestPath,
  parseArgs,
  readManifest,
  run,
  usage,
  validateFixtureName,
  writeJson,
  ensureMongoContainer,
};
