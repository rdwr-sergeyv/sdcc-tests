#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const defaultMongoContainer = process.env.LEGACY_PORTAL_MONGO_CONTAINER || 'legacy-portal-mongo-1';
const defaultBackendContainer = process.env.SDCC_BACKEND_CONTAINER
  || process.env.LEGACY_PORTAL_BACKEND_CONTAINER
  || process.env.LEGACY_PORTAL_CONTAINER
  || 'legacy-portal-portal-1';
const defaultDbName = process.env.SDCC_MONGO_DB || 'sdcc';
const allowedFields = new Set(['password', 'password_enable', 'snmp_community']);

main();

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.scName || !options.targetName) {
    usage();
    process.exit(2);
  }
  if (options.mode === 'device' && !allowedFields.has(options.field)) {
    fail(`Unsupported field: ${options.field}. Expected one of: ${Array.from(allowedFields).join(', ')}`, 2);
  }

  const lookup = options.mode === 'vision' ? lookupVision(options) : lookupDevice(options);
  const masterKey = readMasterKeyFromContainer(options.backendContainer)
    || lookup.masterKeyFromDb;
  if (!masterKey) {
    fail(`Could not find master_key in /etc/sdcc/sdcc.conf on ${options.backendContainer} or in db.Settings.`);
  }

  const decrypted = decryptValue(options.backendContainer, lookup.encryptedValue, masterKey);
  console.log(`SC: ${lookup.sc.name} (${lookup.sc.id})`);
  console.log(`${lookup.kind}: ${lookup.target.name} (${lookup.target.id || 'no unique_id'})`);
  console.log(`Field: ${lookup.field}`);
  if (lookup.target.host) console.log(`Host: ${lookup.target.host}`);
  if (lookup.target.port) console.log(`Port: ${lookup.target.port}`);
  if (lookup.target.protocol) console.log(`Protocol: ${lookup.target.protocol}`);
  console.log(`User: ${lookup.target.user || ''}`);
  console.log(`Decrypted: ${decrypted}`);
}

function parseArgs(args) {
  const options = {
    scName: '',
    targetName: '',
    mode: 'device',
    field: 'password',
    mongoContainer: defaultMongoContainer,
    backendContainer: defaultBackendContainer,
    dbName: defaultDbName,
    help: false,
  };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--field') {
      options.field = requireValue(args, ++i, arg);
    } else if (arg.startsWith('--field=')) {
      options.field = arg.slice('--field='.length);
    } else if (arg === '--mongo-container') {
      options.mongoContainer = requireValue(args, ++i, arg);
    } else if (arg.startsWith('--mongo-container=')) {
      options.mongoContainer = arg.slice('--mongo-container='.length);
    } else if (arg === '--backend-container') {
      options.backendContainer = requireValue(args, ++i, arg);
    } else if (arg.startsWith('--backend-container=')) {
      options.backendContainer = arg.slice('--backend-container='.length);
    } else if (arg === '--db') {
      options.dbName = requireValue(args, ++i, arg);
    } else if (arg.startsWith('--db=')) {
      options.dbName = arg.slice('--db='.length);
    } else if (arg === '--vision') {
      options.mode = 'vision';
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.targetName = args[++i];
      }
    } else if (arg.startsWith('--vision=')) {
      options.mode = 'vision';
      options.targetName = arg.slice('--vision='.length);
    } else if (arg === '--device') {
      options.mode = 'device';
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        options.targetName = args[++i];
      }
    } else if (arg.startsWith('--device=')) {
      options.mode = 'device';
      options.targetName = arg.slice('--device='.length);
    } else if (arg.startsWith('-')) {
      fail(`Unknown option: ${arg}`, 2);
    } else {
      positional.push(arg);
    }
  }
  if (positional[0]) options.scName = positional[0];
  if (positional[1] && !options.targetName) options.targetName = positional[1];
  return options;
}

function requireValue(args, index, option) {
  if (index >= args.length || args[index].startsWith('-')) {
    fail(`Missing value for ${option}`, 2);
  }
  return args[index];
}

function usage() {
  console.log(`Usage:
  node tools/decrypt-sc-device-password.cjs <sc-name> <device-name> [options]
  node tools/decrypt-sc-device-password.cjs <sc-name> --vision <vision-name-or-host> [options]

Options:
  --device <name>             Decrypt a management device field. This is the default mode.
  --vision <name-or-host>     Decrypt a Vision server database password from sc.vision_servers.
  --field <name>              Device field to decrypt: password, password_enable, snmp_community
                              Default: password. Ignored for --vision.
  --mongo-container <name>    Mongo container. Default: ${defaultMongoContainer}
  --backend-container <name>  Container with /etc/sdcc/sdcc.conf and sdcc Python code.
                              Default: ${defaultBackendContainer}
  --db <name>                 Mongo database. Default: ${defaultDbName}

Master key lookup:
  Tries /etc/sdcc/sdcc.conf in the backend container first, then falls back to db.Settings.master_key.

Examples:
  node tools/decrypt-sc-device-password.cjs NEW-LAB LAB-UHT-4
  node tools/decrypt-sc-device-password.cjs NEW-LAB LAB-AR-1 --field password_enable
  node tools/decrypt-sc-device-password.cjs NEW-LAB --vision Vision_Cloud_15
  node tools/decrypt-sc-device-password.cjs NEW-LAB --vision 10.20.7.15
`);
}

function lookupDevice(options) {
  const mongoScript = `
const scName = ${JSON.stringify(options.scName)};
const deviceName = ${JSON.stringify(options.targetName)};
const field = ${JSON.stringify(options.field)};

function regexExact(value) {
  return new RegExp('^' + String(value).replace(/[|\\\\{}()[\\]^$+*?.]/g, '\\\\$&') + '$', 'i');
}
function oid(value) {
  return value && value.valueOf ? String(value.valueOf()) : String(value || '');
}
function simpleDevice(device) {
  return {
    id: oid(device.unique_id),
    name: device.name || '',
    abbreviation: device.abbreviation || '',
    ip: device.ip || '',
    role: device.role || '',
    type: device.type || '',
    user: device.user || ''
  };
}

let scs = db.ScrubbingCenters.find({ name: scName }).toArray();
if (!scs.length) {
  scs = db.ScrubbingCenters.find({ name: regexExact(scName) }).toArray();
}
if (!scs.length) {
  scs = db.ScrubbingCenters.find({ abbreviation: scName }).toArray();
}
if (scs.length !== 1) {
  const candidates = scs.map((sc) => ({ id: oid(sc._id), name: sc.name, abbreviation: sc.abbreviation }));
  print(JSON.stringify({ ok: false, error: scs.length ? 'SC lookup is ambiguous' : 'SC not found', candidates }));
  quit(0);
}

const sc = scs[0];
const devices = sc.management_devices || [];
let matches = devices.filter((device) => device.name === deviceName);
if (!matches.length) {
  const rx = regexExact(deviceName);
  matches = devices.filter((device) => rx.test(device.name || ''));
}
if (!matches.length) {
  matches = devices.filter((device) => device.abbreviation === deviceName || device.ip === deviceName || oid(device.unique_id) === deviceName);
}
if (matches.length !== 1) {
  const candidates = matches.map(simpleDevice);
  print(JSON.stringify({
    ok: false,
    error: matches.length ? 'Device lookup is ambiguous' : 'Device not found in SC',
    sc: { id: oid(sc._id), name: sc.name, abbreviation: sc.abbreviation },
    candidates
  }));
  quit(0);
}

const device = matches[0];
const encryptedValue = device[field];
if (!encryptedValue) {
  print(JSON.stringify({
    ok: false,
    error: 'Device field is empty or missing',
    field,
    sc: { id: oid(sc._id), name: sc.name, abbreviation: sc.abbreviation },
    device: simpleDevice(device)
  }));
  quit(0);
}

const settings = db.Settings.findOne({ master_key: { $exists: true } }, { master_key: 1 }) || {};
print(JSON.stringify({
  ok: true,
  kind: 'Device',
  field,
  sc: { id: oid(sc._id), name: sc.name, abbreviation: sc.abbreviation },
  target: simpleDevice(device),
  encryptedValue,
  masterKeyFromDb: settings.master_key || ''
}));
`;

  const result = run('docker', [
    'exec',
    options.mongoContainer,
    'mongosh',
    options.dbName,
    '--quiet',
    '--eval',
    mongoScript,
  ]);
  const parsed = parseJsonOutput(result.stdout, 'Mongo lookup');
  if (!parsed.ok) {
    if (parsed.candidates && parsed.candidates.length) {
      console.error(JSON.stringify(parsed.candidates, null, 2));
    }
    fail(parsed.error || 'Mongo lookup failed', 1);
  }
  return parsed;
}

function lookupVision(options) {
  const mongoScript = `
const scName = ${JSON.stringify(options.scName)};
const visionName = ${JSON.stringify(options.targetName)};

function regexExact(value) {
  return new RegExp('^' + String(value).replace(/[|\\\\{}()[\\]^$+*?.]/g, '\\\\$&') + '$', 'i');
}
function oid(value) {
  return value && value.valueOf ? String(value.valueOf()) : String(value || '');
}
function simpleVision(vision) {
  const database = vision.database || {};
  return {
    id: oid(vision.unique_id),
    name: vision.name || '',
    type: vision.type || '',
    host: database.host || vision.hostIp || '',
    port: database.port || '',
    protocol: database.protocol || '',
    user: database.user || ''
  };
}

let scs = db.ScrubbingCenters.find({ name: scName }).toArray();
if (!scs.length) {
  scs = db.ScrubbingCenters.find({ name: regexExact(scName) }).toArray();
}
if (!scs.length) {
  scs = db.ScrubbingCenters.find({ abbreviation: scName }).toArray();
}
if (scs.length !== 1) {
  const candidates = scs.map((sc) => ({ id: oid(sc._id), name: sc.name, abbreviation: sc.abbreviation }));
  print(JSON.stringify({ ok: false, error: scs.length ? 'SC lookup is ambiguous' : 'SC not found', candidates }));
  quit(0);
}

const sc = scs[0];
const visions = sc.vision_servers || [];
let matches = visions.filter((vision) => vision.name === visionName);
if (!matches.length) {
  const rx = regexExact(visionName);
  matches = visions.filter((vision) => rx.test(vision.name || ''));
}
if (!matches.length) {
  matches = visions.filter((vision) => {
    const database = vision.database || {};
    return oid(vision.unique_id) === visionName
      || database.host === visionName
      || vision.hostIp === visionName;
  });
}
if (matches.length !== 1) {
  const candidates = matches.length ? matches.map(simpleVision) : visions.map(simpleVision);
  print(JSON.stringify({
    ok: false,
    error: matches.length ? 'Vision lookup is ambiguous' : 'Vision not found in SC',
    sc: { id: oid(sc._id), name: sc.name, abbreviation: sc.abbreviation },
    candidates
  }));
  quit(0);
}

const vision = matches[0];
const encryptedValue = vision.database && vision.database.password;
if (!encryptedValue) {
  print(JSON.stringify({
    ok: false,
    error: 'Vision database.password is empty or missing',
    sc: { id: oid(sc._id), name: sc.name, abbreviation: sc.abbreviation },
    vision: simpleVision(vision)
  }));
  quit(0);
}

const settings = db.Settings.findOne({ master_key: { $exists: true } }, { master_key: 1 }) || {};
print(JSON.stringify({
  ok: true,
  kind: 'Vision',
  field: 'database.password',
  sc: { id: oid(sc._id), name: sc.name, abbreviation: sc.abbreviation },
  target: simpleVision(vision),
  encryptedValue,
  masterKeyFromDb: settings.master_key || ''
}));
`;

  const result = run('docker', [
    'exec',
    options.mongoContainer,
    'mongosh',
    options.dbName,
    '--quiet',
    '--eval',
    mongoScript,
  ]);
  const parsed = parseJsonOutput(result.stdout, 'Mongo Vision lookup');
  if (!parsed.ok) {
    if (parsed.candidates && parsed.candidates.length) {
      console.error(JSON.stringify(parsed.candidates, null, 2));
    }
    fail(parsed.error || 'Mongo Vision lookup failed', 1);
  }
  return parsed;
}

function readMasterKeyFromContainer(container) {
  const script = String.raw`
import json
import sys

try:
    import yaml
except Exception:
    yaml = None

path = "/etc/sdcc/sdcc.conf"
try:
    raw = open(path, "r", encoding="utf-8").read()
except OSError:
    sys.exit(0)

data = None
try:
    data = json.loads(raw)
except Exception:
    if yaml is not None:
        try:
            data = yaml.safe_load(raw)
        except Exception:
            data = None

if isinstance(data, dict) and data.get("master_key"):
    print(data["master_key"])
`;
  const result = spawnSync('docker', [
    'exec',
    '-i',
    container,
    'python3.10',
    '-c',
    script,
  ], {
    encoding: 'utf8',
    input: '',
  });
  if (result.error || result.status !== 0) {
    return '';
  }
  return String(result.stdout || '').trim();
}

function decryptValue(container, encryptedValue, masterKey) {
  const shell = `
set -eu
sdcc_dir=""
for candidate in /work/sdcc /opt/cddos-legacy/sdcc; do
  if [ -d "$candidate/sdcc" ]; then
    sdcc_dir="$candidate"
    break
  fi
done
if [ -z "$sdcc_dir" ]; then
  echo "Could not find sdcc Python package in /work/sdcc or /opt/cddos-legacy/sdcc" >&2
  exit 1
fi
cd "$sdcc_dir"
PYTHONPATH="$PWD" python3.10 -m sdcc.common.util.decrypt_encrypt -o decrypt -s "$ENC" -k "$MASTER_KEY"
`;
  const result = run('docker', [
    'exec',
    '-e',
    `ENC=${encryptedValue}`,
    '-e',
    `MASTER_KEY=${masterKey}`,
    container,
    'bash',
    '-lc',
    shell,
  ]);
  return String(result.stdout || '').trim().split(/\r?\n/).at(-1);
}

function parseJsonOutput(output, label) {
  const lines = String(output || '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Keep scanning; mongosh can print warnings before JSON.
    }
  }
  fail(`${label} did not return JSON. Output:\n${output}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
  });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  return result;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}
