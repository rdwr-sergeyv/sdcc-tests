const {
  fail,
  parseArgs,
  run,
  usage,
  ensureMongoContainer,
} = require('./lib.cjs');

const DEFAULT_CLEAN_SOURCE_URI = 'mongodb://10.20.4.110:27017/sdcc';

function databaseFromUri(uri) {
  try {
    const parsed = new URL(uri);
    const dbName = parsed.pathname.replace(/^\/+/, '').split('/')[0];
    return dbName || 'sdcc';
  } catch (err) {
    fail(`Invalid MongoDB source URI: ${uri}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const sourceUri = args.sourceUri || DEFAULT_CLEAN_SOURCE_URI;
const sourceDb = databaseFromUri(sourceUri);
const targetDb = args.db || 'sdcc';

if (args._.length !== 0) {
  usage([
    'Usage: npm run dp-isolate-fixtures:restore-clean -- --yes [--source-uri mongodb://host:port/sdcc] [--container name] [--db sdcc]',
    '',
    'Restores the target Mongo database from a known clean source database.',
    'This streams through a temporary archive inside the target Mongo container and does not save a fixture backup.',
    '',
    `Default source: ${DEFAULT_CLEAN_SOURCE_URI}`,
  ]);
  process.exit(1);
}

if (!args.yes) {
  fail('Restore is destructive for the target database. Re-run with --yes when the clean source and target are correct.');
}

ensureMongoContainer(args.container);

const remoteArchive = `/tmp/dp-isolate-clean-restore-${Date.now()}.archive.gz`;

run('docker', [
  'exec',
  args.container,
  'mongodump',
  '--uri',
  sourceUri,
  `--archive=${remoteArchive}`,
  '--gzip',
]);

run('docker', [
  'exec',
  args.container,
  'mongorestore',
  '--drop',
  `--nsFrom=${sourceDb}.*`,
  `--nsTo=${targetDb}.*`,
  `--archive=${remoteArchive}`,
  '--gzip',
]);

run('docker', ['exec', args.container, 'rm', '-f', remoteArchive]);

console.log(`Restored clean database from "${sourceUri}" into "${targetDb}" on container "${args.container}".`);
