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

// A restore with no --collections is `mongorestore --drop` of the WHOLE database. That discards
// everything the lab holds which the fixture predates -- as of 2026-08-16 the Escalation SC config
// (sc_type / escalates_to), the site moves, and any live diversion someone is working with. The
// failure mode is silent: you notice hours later when unrelated suites fail on data that used to
// be there.
//
// --yes cannot gate this, because the automated callers pass it too. So a whole-database restore
// additionally needs DP_ISOLATE_ALLOW_DB_RESTORE=1, which a test run will not have by accident.
// Scoping the restore with --collections stays unguarded: that is the surgical, reviewable form.
if (!resolveCollections(args).length && String(process.env.DP_ISOLATE_ALLOW_DB_RESTORE || '') !== '1') {
  fail([
    'Refusing a WHOLE-DATABASE restore of "' + name + '": it would drop the current lab state',
    '(Escalation SC config, site moves, any live diversion).',
    'Restore only what you need with --collections DPZones,Incidents,Tasks;',
    'or refresh the fixture with: npm run dp-isolate-fixtures:capture;',
    'or accept the loss with: DP_ISOLATE_ALLOW_DB_RESTORE=1',
  ].join(' '));
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
run('docker', ['exec', '-u', 'root', args.container, 'rm', '-f', remoteArchive]);

const excludedCollections = Array.isArray(manifest.excludedCollections) ? manifest.excludedCollections : [];
if (!collections.length && excludedCollections.length) {
  run('docker', [
    'exec',
    args.container,
    'mongosh',
    db,
    '--quiet',
    '--eval',
    `void ${JSON.stringify(excludedCollections)}.forEach((collection) => db.getCollection(collection).drop())`,
  ]);
}

if (collections.length) {
  console.log(`Restored fixture "${name}" collections into database "${db}" on container "${args.container}":`);
  for (const collection of collections) {
    console.log(`- ${collection}`);
  }
} else {
  console.log(`Restored fixture "${name}" into database "${db}" on container "${args.container}".`);
  if (excludedCollections.length) {
    console.log(`Dropped excluded collection(s): ${excludedCollections.join(', ')}`);
  }
}
