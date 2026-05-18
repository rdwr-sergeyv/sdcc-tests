const { test, expect } = require('playwright/test');
const {
  login,
  mongoEval,
  mongoJson,
  restoreReadyForTests,
} = require('./dp-isolate-helpers.cjs');

const HAPPY_ASSET_ID = '5e5bb8fa2cbdfd02c6581656';
const INSUFFICIENT_ATTACK_ZONE_DPS_ASSET_ID = '67f502c30f9d41266261bc50';
const NO_ACTIVE_INCIDENT_ASSET_ID = '6575808ecc009ff81b5124b2';

function incidentSnapshot(assetId) {
  return mongoJson(`(() => {
    const incident = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    const attackZone = db.DPZones.findOne({ name: 'attack_zone' });
    const asset = db.Assets.findOne({ _id: ObjectId('${assetId}') });
    const account = asset && db.Accounts.findOne({ _id: asset.account });
    if (!incident) {
      return {
        asset: '${assetId}',
        hasIncident: false,
        accountZoneId: account && account.zone && String(account.zone),
        attackZoneId: attackZone && String(attackZone._id),
        taskCount: db.Tasks.countDocuments({}),
        assetTaskLogCount: db.AssetTasksLogs.countDocuments({}),
        backupIncidentCount: db.BackupIncidents.countDocuments({}),
      };
    }
    const activeDiversions = (incident.diversion || []).filter((diversion) => !(diversion.state || {}).deactivated);
    const selectedDpIds = activeDiversions.flatMap((diversion) => Object.entries((diversion.state || {}).topology || {})
      .filter((entry) => entry[1] && entry[1].selected)
      .map((entry) => entry[0]));
    return {
      id: String(incident._id),
      asset: String(incident.asset),
      hasIncident: true,
      inQueue: Boolean(incident.in_queue),
      isolated: Boolean(incident.isolation_state && incident.isolation_state.isolated),
      isolationTrigger: incident.isolation_state && incident.isolation_state.trigger || null,
      rollbackAt: incident.isolation_state && incident.isolation_state.rollback_at || null,
      accountZoneId: account && account.zone && String(account.zone),
      activeDiversionZones: activeDiversions.map((diversion) => diversion.zone && String(diversion.zone)),
      attackZoneId: attackZone && String(attackZone._id),
      originalSelectedDpIds: activeDiversions.flatMap((diversion) => (diversion.original_selected_dp_ids || []).map(String)),
      selectedDpIds,
      taskCount: db.Tasks.countDocuments({}),
      taskActions: db.Tasks.distinct('command.action'),
      assetTaskLogCount: db.AssetTasksLogs.countDocuments({ incident_id: incident._id }),
      backupIncidentCount: db.BackupIncidents.countDocuments({}),
    };
  })()`);
}

async function enableIsolation(request, baseUrl, assetId = HAPPY_ASSET_ID, trigger = 'manual') {
  const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${assetId}`, {
    data: { trigger },
  });
  expect(response.status(), await response.text()).toBe(200);
  expect(await response.json()).toEqual({ reply: 'OK' });
  return incidentSnapshot(assetId);
}

function clearQueue(assetId = HAPPY_ASSET_ID) {
  mongoEval(`db.Incidents.updateOne(
    { asset: ObjectId('${assetId}'), endedAt: null },
    { $set: { in_queue: false } }
  )`);
}

function exhaustAttackZoneDpPolicySlots(scId) {
  mongoEval(`(() => {
    const attackZone = db.DPZones.findOne({ name: 'attack_zone' })._id;
    const sc = db.ScrubbingCenters.findOne({ _id: ObjectId('${scId}') });
    const attackZoneDpIds = (sc.management_devices || [])
      .filter((device) => device.type === 'radware-defensepro' && String(device.zone) === String(attackZone))
      .map((device) => device.unique_id);

    db.ScrubbingCenters.updateOne(
      { _id: sc._id },
      { $set: { 'management_devices.$[dp].max_policies': 1 } },
      { arrayFilters: [{ 'dp.unique_id': { $in: attackZoneDpIds } }] }
    );
    db.ScrubbingCenterDeviceStatuses.updateMany(
      {
        '_id.scrubbing_center': sc._id,
        '_id.device_uid': { $in: attackZoneDpIds },
      },
      { $set: { op_status: 1, num_policies: 1 } }
    );
  })()`);
}

test.describe.serial('DP Isolate API short mode', () => {
  test.beforeEach(() => {
    restoreReadyForTests();
    mongoEval("db.getSiblingDB('mongolock').lock.deleteMany({})");
  });

  test.afterAll(() => {
    mongoEval("db.getSiblingDB('mongolock').lock.deleteMany({})");
    restoreReadyForTests();
  });

  test('enables isolation and creates queued work without backend workers', async ({ request }) => {
    const baseUrl = await login(request);

    const before = incidentSnapshot(HAPPY_ASSET_ID);
    expect(before).toMatchObject({
      inQueue: false,
      isolated: false,
      taskCount: 0,
      assetTaskLogCount: 0,
    });

    const after = await enableIsolation(request, baseUrl, HAPPY_ASSET_ID, 'manual');
    expect(after).toMatchObject({
      inQueue: true,
      isolated: true,
      isolationTrigger: 'manual',
    });
    expect(after.activeDiversionZones).toEqual([after.attackZoneId]);
    expect(after.originalSelectedDpIds.length).toBeGreaterThan(0);
    expect(after.taskCount).toBeGreaterThan(0);
    expect(after.assetTaskLogCount).toBeGreaterThan(0);
    expect(after.taskActions).toEqual(expect.arrayContaining(['activate', 'deactivate']));
  });

  test('uses auto trigger without waiting for queued work execution', async ({ request }) => {
    const baseUrl = await login(request);

    const after = await enableIsolation(request, baseUrl, HAPPY_ASSET_ID, 'auto');
    expect(after).toMatchObject({
      inQueue: true,
      isolated: true,
      isolationTrigger: 'auto',
    });
  });

  test('rejects invalid or missing trigger without backend workers', async ({ request }) => {
    const baseUrl = await login(request);

    for (const data of [{ trigger: 'invalid-value' }, {}]) {
      const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${HAPPY_ASSET_ID}`, { data });
      expect(response.status(), await response.text()).toBe(400);
      expect(await response.json()).toEqual({
        error: { message: 'Invalid trigger. Expected one of: manual, auto' },
      });
    }

    expect(incidentSnapshot(HAPPY_ASSET_ID)).toMatchObject({
      inQueue: false,
      isolated: false,
      taskCount: 0,
      assetTaskLogCount: 0,
    });
  });

  test('rejects enable when the active scrubbing center lacks enough Attack Zone DefensePros', async ({ request }) => {
    const baseUrl = await login(request);

    const response = await request.post(
      `${baseUrl}/api/incident/isolation/enable/${INSUFFICIENT_ATTACK_ZONE_DPS_ASSET_ID}`,
      { data: { trigger: 'manual' } },
    );
    expect(response.status(), await response.text()).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        message: 'Scrubbing Center 5c403cc32cbdfd2595be54b7 does not have enough Attack Zone DefensePro devices',
      },
    });

    expect(incidentSnapshot(INSUFFICIENT_ATTACK_ZONE_DPS_ASSET_ID)).toMatchObject({
      inQueue: false,
      isolated: false,
      taskCount: 0,
      assetTaskLogCount: 0,
      backupIncidentCount: 0,
    });
  });

  test('rejects enable when Attack Zone DefensePros have no free policy slots', async ({ request }) => {
    exhaustAttackZoneDpPolicySlots('5e08d6bc2cbdfd701f0c2936');
    const baseUrl = await login(request);

    const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${HAPPY_ASSET_ID}`, {
      data: { trigger: 'manual' },
    });
    expect(response.status(), await response.text()).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        message: 'Scrubbing Center 5e08d6bc2cbdfd701f0c2936 does not have enough Attack Zone DefensePro devices',
      },
    });

    expect(incidentSnapshot(HAPPY_ASSET_ID)).toMatchObject({
      inQueue: false,
      isolated: false,
      taskCount: 0,
      assetTaskLogCount: 0,
      backupIncidentCount: 0,
    });
  });

  test('rejects disable while isolation work remains queued', async ({ request }) => {
    const baseUrl = await login(request);
    await enableIsolation(request, baseUrl);

    const response = await request.post(`${baseUrl}/api/incident/isolation/disable/${HAPPY_ASSET_ID}`);
    expect(response.status(), await response.text()).toBe(409);
    expect(await response.json()).toEqual({
      error: { message: 'Incident action is already in queue' },
    });

    expect(incidentSnapshot(HAPPY_ASSET_ID)).toMatchObject({
      inQueue: true,
      isolated: true,
    });
  });

  test('rolls back without backend workers when queued state is cleared explicitly', async ({ request }) => {
    const baseUrl = await login(request);
    const isolated = await enableIsolation(request, baseUrl);
    clearQueue(HAPPY_ASSET_ID);

    const disable = await request.post(`${baseUrl}/api/incident/isolation/disable/${HAPPY_ASSET_ID}`);
    expect(disable.status(), await disable.text()).toBe(200);
    expect(await disable.json()).toEqual({ reply: 'OK' });

    const rolledBack = incidentSnapshot(HAPPY_ASSET_ID);
    expect(rolledBack.isolated).toBe(false);
    expect(rolledBack.inQueue).toBe(true);
    expect(rolledBack.rollbackAt).toBeTruthy();
    expect(rolledBack.activeDiversionZones.every((zoneId) => zoneId === rolledBack.accountZoneId)).toBe(true);
    expect(rolledBack.originalSelectedDpIds).toEqual([]);
    expect(rolledBack.selectedDpIds).toEqual(expect.arrayContaining(isolated.originalSelectedDpIds));
    expect(rolledBack.taskCount).toBeGreaterThan(isolated.taskCount);
  });

  test('treats already isolated incident as a successful enable no-op', async ({ request }) => {
    mongoEval(`db.Incidents.updateOne(
      { asset: ObjectId('${HAPPY_ASSET_ID}'), endedAt: null },
      { $set: { isolation_state: { isolated: true, isolated_at: new Date(), trigger: 'manual' } } }
    )`);
    const baseUrl = await login(request);

    const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${HAPPY_ASSET_ID}`, {
      data: { trigger: 'manual' },
    });
    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toEqual({ reply: 'OK' });

    expect(incidentSnapshot(HAPPY_ASSET_ID)).toMatchObject({
      isolated: true,
      taskCount: 0,
      assetTaskLogCount: 0,
      backupIncidentCount: 0,
    });
  });

  test('treats missing active incident as a successful no-op', async ({ request }) => {
    const baseUrl = await login(request);

    const enable = await request.post(`${baseUrl}/api/incident/isolation/enable/${NO_ACTIVE_INCIDENT_ASSET_ID}`, {
      data: { trigger: 'manual' },
    });
    expect(enable.status(), await enable.text()).toBe(200);
    expect(await enable.json()).toEqual({ reply: 'OK' });

    const disable = await request.post(`${baseUrl}/api/incident/isolation/disable/${NO_ACTIVE_INCIDENT_ASSET_ID}`);
    expect(disable.status(), await disable.text()).toBe(200);
    expect(await disable.json()).toEqual({ reply: 'OK' });

    expect(incidentSnapshot(NO_ACTIVE_INCIDENT_ASSET_ID)).toMatchObject({
      hasIncident: false,
      taskCount: 0,
      assetTaskLogCount: 0,
      backupIncidentCount: 0,
    });
  });
});
