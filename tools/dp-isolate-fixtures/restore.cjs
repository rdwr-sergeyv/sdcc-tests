const fs = require('fs');
const {
  archivePath,
  fail,
  parseArgs,
  readManifest,
  run,
  usage,
  validateFixtureName,
  ensureMongoContainer,
} = require('./lib.cjs');

const args = parseArgs(process.argv.slice(2));
const name = validateFixtureName(args._[0]);

if (args._.length !== 1) {
  usage([
    'Usage: npm run dp-isolate-fixtures:restore -- <name> --yes [--container name] [--db sdcc]',
    '',
    'Restores fixtures/dp-isolate/<name>/sdcc.archive.gz into Mongo with mongorestore --drop.',
  ]);
  process.exit(1);
}

if (!args.yes) {
  fail('Restore is destructive for the target database. Re-run with --yes when the target fixture name is correct.');
}

ensureMongoContainer(args.container);

const manifest = readManifest(name);
const archive = archivePath(name);
const db = args.db || manifest.database || 'sdcc';

if (!fs.existsSync(archive)) {
  fail(`Fixture archive not found: ${archive}`);
}

const remoteArchive = `/tmp/dp-isolate-restore-${name}-${Date.now()}.archive.gz`;
run('docker', ['cp', archive, `${args.container}:${remoteArchive}`]);
run('docker', [
  'exec',
  args.container,
  'mongorestore',
  '--drop',
  '--db',
  db,
  `--archive=${remoteArchive}`,
  '--gzip',
]);
run('docker', ['exec', args.container, 'rm', '-f', remoteArchive]);

console.log(`Restored fixture "${name}" into database "${db}" on container "${args.container}".`);
