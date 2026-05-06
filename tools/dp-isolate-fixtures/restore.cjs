const fs = require('fs');
const {
  archivePath,
  fail,
  parseArgs,
  readManifest,
  resolveCollections,
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
    '       npm run dp-isolate-fixtures:restore -- <name> --yes --preset dp-isolate',
    '       npm run dp-isolate-fixtures:restore -- <name> --yes --collections DPZones,Incidents,Tasks',
    '',
    'Restores fixtures/dp-isolate/<name>/sdcc.archive.gz into Mongo with mongorestore --drop.',
    'When --collections or --preset is used, only those collections are dropped/restored.',
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
const sourceDb = manifest.database || db;
const collections = resolveCollections(args);

if (!fs.existsSync(archive)) {
  fail(`Fixture archive not found: ${archive}`);
}

const remoteArchive = `/tmp/dp-isolate-restore-${name}-${Date.now()}.archive.gz`;
run('docker', ['cp', archive, `${args.container}:${remoteArchive}`]);
const restoreArgs = [
  'exec',
  args.container,
  'mongorestore',
  '--drop',
  `--archive=${remoteArchive}`,
  '--gzip',
];

if (collections.length) {
  restoreArgs.push(`--nsFrom=${sourceDb}.*`, `--nsTo=${db}.*`);
  for (const collection of collections) {
    restoreArgs.push(`--nsInclude=${sourceDb}.${collection}`);
  }
} else {
  restoreArgs.push('--db', db);
}

run('docker', restoreArgs);
run('docker', ['exec', args.container, 'rm', '-f', remoteArchive]);

if (collections.length) {
  console.log(`Restored fixture "${name}" collections into database "${db}" on container "${args.container}":`);
  for (const collection of collections) {
    console.log(`- ${collection}`);
  }
} else {
  console.log(`Restored fixture "${name}" into database "${db}" on container "${args.container}".`);
}
