#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const defaultAssetId = '5e5bb8fa2cbdfd02c6581656';
const assetId = process.argv[2] || process.env.DP_ISOLATE_ASSET_ID || defaultAssetId;
const container = process.env.LEGACY_PORTAL_MONGO_CONTAINER || 'legacy-portal-mongo-1';
const dbName = process.env.SDCC_MONGO_DB || 'sdcc';
const scriptPath = path.join(root, 'tools', 'dp-isolate-mongo', 'task-snapshot.js');

if (!/^[a-fA-F0-9]{24}$/.test(assetId)) {
  console.error(`Invalid asset id: ${assetId}`);
  process.exit(2);
}

const script = [
  `const DP_ISOLATE_ASSET_ID = ${JSON.stringify(assetId)};`,
  fs.readFileSync(scriptPath, 'utf8'),
].join('\n');

const result = spawnSync('docker', [
  'exec',
  container,
  'mongosh',
  dbName,
  '--quiet',
  '--eval',
  script,
], {
  cwd: root,
  encoding: 'utf8',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status || 1);
}

process.stdout.write(result.stdout);
