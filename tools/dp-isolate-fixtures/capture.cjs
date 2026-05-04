const fs = require('fs');
const path = require('path');
const {
  archivePath,
  fail,
  fixtureDir,
  manifestPath,
  parseArgs,
  run,
  usage,
  validateFixtureName,
  writeJson,
  ensureMongoContainer,
} = require('./lib.cjs');

const args = parseArgs(process.argv.slice(2));
const name = validateFixtureName(args._[0]);

if (args._.length !== 1) {
  usage([
    'Usage: npm run dp-isolate-fixtures:capture -- <name> [--description "..."] [--force] [--container name] [--db sdcc]',
    '',
    'Creates fixtures/dp-isolate/<name>/sdcc.archive.gz from the running Mongo container.',
  ]);
  process.exit(1);
}

ensureMongoContainer(args.container);

const dir = fixtureDir(name);
const archive = archivePath(name);
const manifest = manifestPath(name);

if (fs.existsSync(archive) && !args.force) {
  fail(`Fixture "${name}" already exists. Use --force to replace it.`);
}

fs.mkdirSync(dir, { recursive: true });

const remoteArchive = `/tmp/dp-isolate-${name}-${Date.now()}.archive.gz`;
run('docker', [
  'exec',
  args.container,
  'mongodump',
  '--db',
  args.db,
  `--archive=${remoteArchive}`,
  '--gzip',
]);
run('docker', ['cp', `${args.container}:${remoteArchive}`, archive]);
run('docker', ['exec', args.container, 'rm', '-f', remoteArchive]);

writeJson(manifest, {
  name,
  description: args.description,
  createdAt: new Date().toISOString(),
  database: args.db,
  container: args.container,
  archive: path.basename(archive),
});

console.log(`Captured fixture "${name}" at ${archive}`);
