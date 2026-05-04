const { listFixtures, parseArgs, usage } = require('./lib.cjs');

const args = parseArgs(process.argv.slice(2));
if (args._.length > 0) {
  usage([
    'Usage: npm run dp-isolate-fixtures:list',
    '',
    'Lists local DP Isolate Mongo fixtures.',
  ]);
  process.exit(1);
}

const fixtures = listFixtures();

if (fixtures.length === 0) {
  console.log('No DP Isolate fixtures found.');
  process.exit(0);
}

for (const fixture of fixtures) {
  if (!fixture.manifest) {
    console.log(`${fixture.name}  (missing manifest)`);
    continue;
  }

  const description = fixture.manifest.description ? ` - ${fixture.manifest.description}` : '';
  console.log(`${fixture.name}  ${fixture.manifest.createdAt || 'unknown time'}  db=${fixture.manifest.database || 'sdcc'}${description}`);
}
