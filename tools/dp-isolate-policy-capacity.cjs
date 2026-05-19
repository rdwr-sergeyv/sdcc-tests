#!/usr/bin/env node
const { spawnSync } = require('child_process');

const mode = process.argv[2];
const scId = process.env.DP_ISOLATE_POLICY_CAPACITY_SC_ID || '5e08d6bc2cbdfd701f0c2936';
const container = process.env.LEGACY_PORTAL_MONGO_CONTAINER || 'legacy-portal-mongo-1';
const dbName = process.env.SDCC_MONGO_DB || 'sdcc';
const restoreMaxPolicies = Number(process.env.DP_ISOLATE_POLICY_CAPACITY_RESTORE_MAX || 200);
const restoreNumPolicies = Number(process.env.DP_ISOLATE_POLICY_CAPACITY_RESTORE_USED || 1);

if (!['min', 'restore'].includes(mode)) {
  console.error([
    'Usage: node tools/dp-isolate-policy-capacity.cjs <min|restore>',
    '',
    'min      Set primary SC Attack Zone DefensePros to max_policies=1 and num_policies=1.',
    'restore  Restore primary SC Attack Zone DefensePros to fixture defaults: max_policies=200 and num_policies=1.',
    '',
    'Environment:',
    '  DP_ISOLATE_POLICY_CAPACITY_SC_ID       ScrubbingCenter ObjectId, default 5e08d6bc2cbdfd701f0c2936',
    '  DP_ISOLATE_POLICY_CAPACITY_RESTORE_MAX Restore max_policies, default 200',
    '  DP_ISOLATE_POLICY_CAPACITY_RESTORE_USED Restore num_policies, default 1',
    '  LEGACY_PORTAL_MONGO_CONTAINER          Mongo container, default legacy-portal-mongo-1',
    '  SDCC_MONGO_DB                          Mongo database, default sdcc',
  ].join('\n'));
  process.exit(1);
}

const targetMaxPolicies = mode === 'min' ? 1 : restoreMaxPolicies;
const targetNumPolicies = mode === 'min' ? 1 : restoreNumPolicies;

const script = `
const attackZone = db.DPZones.findOne({ name: 'attack_zone' });
if (!attackZone) {
  throw new Error('attack_zone DP zone was not found');
}

const sc = db.ScrubbingCenters.findOne({ _id: ObjectId('${scId}') });
if (!sc) {
  throw new Error('ScrubbingCenter ${scId} was not found');
}

const attackZoneDpIds = (sc.management_devices || [])
  .filter((device) => device.type === 'radware-defensepro' && String(device.zone) === String(attackZone._id))
  .map((device) => device.unique_id);

if (!attackZoneDpIds.length) {
  throw new Error('No Attack Zone DefensePros found on ScrubbingCenter ${scId}');
}

db.ScrubbingCenters.updateOne(
  { _id: sc._id },
  { $set: { 'management_devices.$[dp].max_policies': ${targetMaxPolicies} } },
  { arrayFilters: [{ 'dp.unique_id': { $in: attackZoneDpIds } }] }
);

db.ScrubbingCenterDeviceStatuses.updateMany(
  {
    '_id.scrubbing_center': sc._id,
    '_id.device_uid': { $in: attackZoneDpIds },
  },
  { $set: { op_status: 1, num_policies: ${targetNumPolicies} } }
);

JSON.stringify({
  mode: '${mode}',
  scrubbingCenter: String(sc._id),
  attackZoneDefensePros: attackZoneDpIds.map(String),
  max_policies: ${targetMaxPolicies},
  num_policies: ${targetNumPolicies},
});
`;

const result = spawnSync(
  'docker',
  ['exec', container, 'mongosh', dbName, '--quiet', '--eval', script],
  { encoding: 'utf8' },
);

if (result.error) {
  console.error(`docker failed: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.stderr.write(result.stderr || '');
  process.exit(result.status || 1);
}

process.stdout.write(result.stdout || '');
