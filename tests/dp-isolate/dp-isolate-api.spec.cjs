const { test, expect } = require('playwright/test');
const {
  docker,
  login,
  mongoEval,
  mongoJson,
  restoreReadyForTests,
  waitFor,
} = require('./dp-isolate-helpers.cjs');

const HAPPY_ASSET_ID = '5e5bb8fa2cbdfd02c6581656';
const INSUFFICIENT_ATTACK_ZONE_DPS_ASSET_ID = '67f502c30f9d41266261bc50';
const NO_ACTIVE_INCIDENT_ASSET_ID = '6575808ecc009ff81b5124b2';
const PRIMARY_SC_ID = '5e08d6bc2cbdfd701f0c2936';
const ADDITIONAL_SC_ID = '5c403cc32cbdfd2595be54b7';

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
        attackZoneId: String(attackZone._id),
        taskCount: db.Tasks.countDocuments({}),
        backupIncidentCount: db.BackupIncidents.countDocuments({}),
      };
    }
    const activeDiversions = (incident.diversion || []).filter((diversion) => !(diversion.state || {}).deactivated);
    const selectedDpIds = activeDiversions.flatMap((diversion) => Object.entries((diversion.state || {}).topology || {})
      .filter((entry) => entry[1] && entry[1].selected)
      .map((entry) => entry[0]));
    const selectedDpZones = activeDiversions.flatMap((diversion) => {
      const sc = db.ScrubbingCenters.findOne({ _id: diversion.sc_id });
      const dpZonesById = Object.fromEntries((sc.management_devices || [])
        .filter((device) => device.type === 'radware-defensepro')
        .map((device) => [String(device.unique_id), device.zone && String(device.zone)]));
      return Object.entries((diversion.state || {}).topology || {})
        .filter((entry) => entry[1] && entry[1].selected && dpZonesById[entry[0]])
        .map((entry) => dpZonesById[entry[0]]);
    });
    return {
      id: String(incident._id),
      asset: String(incident.asset),
      hasIncident: true,
      inQueue: Boolean(incident.in_queue),
      isolated: Boolean(incident.isolation_state && incident.isolation_state.isolated),
      isolationTrigger: incident.isolation_state && incident.isolation_state.trigger || null,
      isolatedAt: incident.isolation_state && incident.isolation_state.isolated_at || null,
      rollbackAt: incident.isolation_state && incident.isolation_state.rollback_at || null,
      accountZoneId: account && account.zone && String(account.zone),
      activeDiversionZones: activeDiversions.map((diversion) => diversion.zone && String(diversion.zone)),
      activeScrubbingCenterIds: activeDiversions.map((diversion) => diversion.sc_id && String(diversion.sc_id)),
      attackZoneId: String(attackZone._id),
      originalSelectedDpIds: activeDiversions.flatMap((diversion) => (diversion.original_selected_dp_ids || []).map(String)),
      selectedDpIds,
      selectedDpZones,
      taskCount: db.Tasks.countDocuments({}),
      taskStatuses: db.Tasks.distinct('status'),
      taskActions: db.Tasks.distinct('command.action'),
      backupIncidentCount: db.BackupIncidents.countDocuments({}),
    };
  })()`);
}

function taskExecutionSnapshot(assetId) {
  return mongoJson(`(() => {
    const incident = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    const taskIds = (incident.diversion || []).flatMap((diversion) => (diversion.state || {}).curr_tasks || []);
    const tasks = db.Tasks.find({ _id: { $in: taskIds } }, {
      status: 1,
      command: 1,
      modifiedAt: 1,
      startedAt: 1,
    }).toArray();
    return {
      incidentInQueue: Boolean(incident.in_queue),
      taskIds: taskIds.map(String),
      taskCount: tasks.length,
      statuses: tasks.map((task) => task.status),
      uniqueStatuses: Array.from(new Set(tasks.map((task) => task.status))).sort(),
      actions: Array.from(new Set(tasks.map((task) => task.command && task.command.action))).sort(),
      pendingModifiedCount: tasks.filter((task) => task.status === 'pending' && task.modifiedAt).length,
    };
  })()`);
}

function lockIsolation(assetId, owner = 'IncidentIsolation') {
  mongoEval(`db.getSiblingDB('mongolock').lock.updateOne(
    { _id: '${assetId}' },
    { $set: {
      locked: true,
      owner: '${owner}',
      created: new Date(),
      expire: new Date(Date.now() + 120000)
    } },
    { upsert: true }
  )`);
}

async function enableIsolation(request, baseUrl, assetId = HAPPY_ASSET_ID, trigger = 'manual') {
  const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${assetId}`, {
    data: { trigger },
  });
  expect(response.status(), await response.text()).toBe(200);
  return waitFor(() => {
    const snapshot = incidentSnapshot(assetId);
    return snapshot.isolated && !snapshot.inQueue ? snapshot : null;
  }, { timeoutMs: 20000, intervalMs: 500 });
}

function clearOriginalDpSnapshot(assetId) {
  mongoEval(`db.Incidents.updateOne(
    { asset: ObjectId('${assetId}'), endedAt: null },
    { $set: { 'diversion.$[].original_selected_dp_ids': [] } }
  )`);
}

function prepareAdditionalScAttackZoneDps(scId = ADDITIONAL_SC_ID) {
  mongoEval(`(() => {
    const attackZone = db.DPZones.findOne({ name: 'attack_zone' })._id;
    db.ScrubbingCenters.updateOne(
      { _id: ObjectId('${scId}') },
      { $set: { 'management_devices.$[dp].zone': attackZone } },
      { arrayFilters: [{ 'dp.type': 'radware-defensepro' }] }
    );
    db.ScrubbingCenterDeviceStatuses.updateMany(
      {
        '_id.scrubbing_center': ObjectId('${scId}'),
        '_id.device_uid': {
          $in: db.ScrubbingCenters.findOne({ _id: ObjectId('${scId}') }).management_devices
            .filter((device) => device.type === 'radware-defensepro')
            .map((device) => device.unique_id)
        }
      },
      { $set: { op_status: 0, num_policies: 0 } }
    );
  })()`);
}

function staleZoneUpdatePayload(assetId, options = {}) {
  const optionsJson = JSON.stringify(options);
  return mongoJson(`(() => {
    const options = ${optionsJson};
    const incident = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    const asset = db.Assets.findOne({ _id: ObjectId('${assetId}') });
    const account = db.Accounts.findOne({ _id: asset.account });
    const activeDiversions = (incident.diversion || []).filter((diversion) => !(diversion.state || {}).deactivated);

    function topologyForDiversion(diversion) {
      const sc = db.ScrubbingCenters.findOne({ _id: diversion.sc_id });
      const deviceTypes = Object.fromEntries((sc.management_devices || []).map((device) => [
        String(device.unique_id),
        device.type === 'radware-defensepro' ? 'dp' : device.role,
      ]));
      const devices = Object.entries((diversion.state || {}).topology || {}).map(([deviceId, state]) => {
        const device = {
          _oid: deviceId,
          type: deviceTypes[deviceId],
          selected: Boolean(state.selected),
          implicit: Boolean(state.implicit),
        };
        if (state['dp-subnet']) device['dp-subnet'] = state['dp-subnet'];
        if (state['dp-mask']) device['dp-mask'] = state['dp-mask'];
        if (state.static_route !== undefined) device.static_route = state.static_route;
        if (state.ri_static_route !== undefined) device.ri_static_route = state.ri_static_route;
        return device;
      }).filter((device) => ['router-out', 'router-in', 'dp'].includes(device.type));

      if (options.replacePrimaryDp) {
        for (const device of devices) {
          if (device.type === 'dp') {
            device.selected = device._oid === options.replacePrimaryDp;
          }
        }
      }

      return {
        sc: { _oid: String(diversion.sc_id) },
        line_type: diversion.line_type,
        sc_prepend: diversion.sc_prepend,
        zone: { _oid: String(account.zone) },
        devices,
      };
    }

    const topology = activeDiversions.map(topologyForDiversion);

    if (options.addAdditionalSc) {
      const sc = db.ScrubbingCenters.findOne({ _id: ObjectId('${ADDITIONAL_SC_ID}') });
      topology.push({
        sc: { _oid: '${ADDITIONAL_SC_ID}' },
        sc_connections: ['${PRIMARY_SC_ID}'],
        line_type: 'DDOS',
        sc_prepend: 0,
        zone: { _oid: String(account.zone) },
        devices: (sc.management_devices || [])
          .filter((device) => [
            'router-out',
            'router-in',
            'radware-defensepro',
          ].includes(device.role))
          .map((device) => ({
            _oid: String(device.unique_id),
            type: device.type === 'radware-defensepro' ? 'dp' : device.role,
            selected: true,
            implicit: false,
            ...(device.type === 'radware-defensepro' ? { 'dp-subnet': String(asset.address), 'dp-mask': Number(asset.mask) || 24 } : {}),
          })),
      });
    }

    return {
      incidentId: String(incident._id),
      data: {
        asset: { _oid: String(asset._id) },
        extended_assets_list: [],
        action: 'update',
        type: 'provisioning',
        topology,
        userInput: {},
      },
    };
  })()`);
}

test.describe.serial('DP Isolate API', () => {
  let cmdExecutorWasStopped = false;

  test.beforeEach(() => {
    restoreReadyForTests();
    mongoEval("db.getSiblingDB('mongolock').lock.deleteMany({})");
  });

  test.afterAll(() => {
    if (cmdExecutorWasStopped) {
      docker(['start', 'legacy-portal-cmd-executor-1']);
      cmdExecutorWasStopped = false;
    }
    mongoEval("db.getSiblingDB('mongolock').lock.deleteMany({})");
    restoreReadyForTests();
  });

  test('enables isolation for an active incident with Attack Zone DefensePros', async ({ request }) => {
    const baseUrl = await login(request);

    const before = incidentSnapshot(HAPPY_ASSET_ID);
    expect(before).toMatchObject({
      inQueue: false,
      isolated: false,
      taskCount: 0,
    });
    expect(before.activeDiversionZones).not.toContain(before.attackZoneId);

    const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${HAPPY_ASSET_ID}`, {
      data: { trigger: 'manual' },
    });
    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toEqual({ reply: 'OK' });

    const after = incidentSnapshot(HAPPY_ASSET_ID);
    expect(after).toMatchObject({
      isolated: true,
      isolationTrigger: 'manual',
    });
    expect(after.activeDiversionZones).toEqual([after.attackZoneId]);
    expect(after.originalSelectedDpIds.length).toBeGreaterThan(0);
    expect(after.selectedDpIds).toEqual(expect.arrayContaining([
      '647f4881a4ceb56ee84228c0',
      '5e08d6bc2cbdfd701f0c2938',
    ]));
    expect(after.taskCount).toBeGreaterThan(0);
    expect(after.taskActions).toEqual(expect.arrayContaining(['activate', 'deactivate']));
    expect(after.taskStatuses).not.toContain('failed');
  });

  test('uses auto trigger when requested', async ({ request }) => {
    const baseUrl = await login(request);

    const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${HAPPY_ASSET_ID}`, {
      data: { trigger: 'auto' },
    });
    expect(response.status(), await response.text()).toBe(200);

    const after = incidentSnapshot(HAPPY_ASSET_ID);
    expect(after).toMatchObject({
      isolated: true,
      isolationTrigger: 'auto',
    });
    expect(after.activeDiversionZones).toEqual([after.attackZoneId]);
  });

  test('rejects enable with an invalid trigger', async ({ request }) => {
    const baseUrl = await login(request);

    const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${HAPPY_ASSET_ID}`, {
      data: { trigger: 'invalid-value' },
    });
    expect(response.status(), await response.text()).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'Invalid trigger. Expected one of: manual, auto' },
    });
    expect(incidentSnapshot(HAPPY_ASSET_ID)).toMatchObject({
      isolated: false,
      taskCount: 0,
      backupIncidentCount: 0,
    });
  });

  test('rejects enable with a missing trigger', async ({ request }) => {
    const baseUrl = await login(request);

    const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${HAPPY_ASSET_ID}`, {
      data: {},
    });
    expect(response.status(), await response.text()).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'Invalid trigger. Expected one of: manual, auto' },
    });
    expect(incidentSnapshot(HAPPY_ASSET_ID)).toMatchObject({
      isolated: false,
      taskCount: 0,
      backupIncidentCount: 0,
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

    const after = incidentSnapshot(INSUFFICIENT_ATTACK_ZONE_DPS_ASSET_ID);
    expect(after).toMatchObject({
      inQueue: false,
      isolated: false,
      taskCount: 0,
      backupIncidentCount: 0,
    });
  });

  test('treats missing active incident as a successful enable no-op', async ({ request }) => {
    const baseUrl = await login(request);

    const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${NO_ACTIVE_INCIDENT_ASSET_ID}`, {
      data: { trigger: 'manual' },
    });
    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toEqual({ reply: 'OK' });

    expect(incidentSnapshot(NO_ACTIVE_INCIDENT_ASSET_ID)).toMatchObject({
      hasIncident: false,
      taskCount: 0,
      backupIncidentCount: 0,
    });
  });

  test('treats Attack Zone account as a successful enable no-op', async ({ request }) => {
    const before = incidentSnapshot(HAPPY_ASSET_ID);
    mongoEval(`db.Accounts.updateOne(
      { _id: db.Assets.findOne({ _id: ObjectId('${HAPPY_ASSET_ID}') }).account },
      { $set: { zone: ObjectId('${before.attackZoneId}') } }
    )`);
    const baseUrl = await login(request);

    const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${HAPPY_ASSET_ID}`, {
      data: { trigger: 'manual' },
    });
    expect(response.status(), await response.text()).toBe(200);

    const after = incidentSnapshot(HAPPY_ASSET_ID);
    expect(after).toMatchObject({
      isolated: false,
      taskCount: 0,
      backupIncidentCount: 0,
    });
    expect(after.activeDiversionZones).not.toContain(after.attackZoneId);
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

    const after = incidentSnapshot(HAPPY_ASSET_ID);
    expect(after).toMatchObject({
      isolated: true,
      taskCount: 0,
      backupIncidentCount: 0,
    });
    expect(after.activeDiversionZones).not.toContain(after.attackZoneId);
  });

  test('rejects enable when the incident is already queued', async ({ request }) => {
    mongoEval(`db.Incidents.updateOne(
      { asset: ObjectId('${HAPPY_ASSET_ID}'), endedAt: null },
      { $set: { in_queue: true } }
    )`);
    const baseUrl = await login(request);

    const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${HAPPY_ASSET_ID}`, {
      data: { trigger: 'manual' },
    });
    expect(response.status(), await response.text()).toBe(409);
    expect(await response.json()).toEqual({
      error: { message: 'Incident action is already in queue' },
    });

    const after = incidentSnapshot(HAPPY_ASSET_ID);
    expect(after).toMatchObject({
      isolated: false,
      taskCount: 0,
      backupIncidentCount: 0,
    });
  });

  test('rejects enable while another isolation request holds the asset lock', async ({ request }) => {
    lockIsolation(HAPPY_ASSET_ID);
    const baseUrl = await login(request);

    const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${HAPPY_ASSET_ID}`, {
      data: { trigger: 'manual' },
    });
    expect(response.status(), await response.text()).toBe(409);
    expect(await response.json()).toEqual({
      error: { message: 'Incident isolation is already in progress' },
    });

    const after = incidentSnapshot(HAPPY_ASSET_ID);
    expect(after).toMatchObject({
      isolated: false,
      taskCount: 0,
      backupIncidentCount: 0,
    });
  });

  test('requires operator role for enable', async ({ request }) => {
    const baseUrl = await login(request);
    mongoEval(`db.Users.updateOne(
      { email: 'twister@example.com' },
      { $set: {
        role: 'user',
        roles: { currentAccount: ['basicUser'], childAccount: ['basicUser'] }
      } }
    )`);

    const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${HAPPY_ASSET_ID}`, {
      data: { trigger: 'manual' },
    });
    expect(response.status(), await response.text()).toBe(403);
    expect(incidentSnapshot(HAPPY_ASSET_ID)).toMatchObject({
      isolated: false,
      taskCount: 0,
      backupIncidentCount: 0,
    });
  });

  // CDDOS-2275: rollback API coverage for success, best-effort DP refill, no-op guards, queue conflicts,
  // rollback lock conflicts, and operator-role authorization.
  test('rolls isolated incident back to the account zone', async ({ request }) => {
    const baseUrl = await login(request);

    const isolated = await enableIsolation(request, baseUrl);

    const disable = await request.post(`${baseUrl}/api/incident/isolation/disable/${HAPPY_ASSET_ID}`);
    expect(disable.status(), await disable.text()).toBe(200);
    expect(await disable.json()).toEqual({ reply: 'OK' });

    const rolledBack = incidentSnapshot(HAPPY_ASSET_ID);
    expect(rolledBack.isolated).toBe(false);
    expect(rolledBack.rollbackAt).toBeTruthy();
    expect(rolledBack.isolatedAt).toBeTruthy();
    expect(rolledBack.isolationTrigger).toBe('manual');
    expect(rolledBack.activeDiversionZones.length).toBeGreaterThan(0);
    expect(rolledBack.activeDiversionZones.every((zoneId) => zoneId === rolledBack.accountZoneId)).toBe(true);
    expect(rolledBack.originalSelectedDpIds).toEqual([]);
    expect(rolledBack.selectedDpIds).toEqual(expect.arrayContaining(isolated.originalSelectedDpIds));
  });

  test('rolls back with best-effort account-zone DPs when the original DP snapshot is empty', async ({ request }) => {
    const baseUrl = await login(request);
    await enableIsolation(request, baseUrl);
    clearOriginalDpSnapshot(HAPPY_ASSET_ID);

    const disable = await request.post(`${baseUrl}/api/incident/isolation/disable/${HAPPY_ASSET_ID}`);
    expect(disable.status(), await disable.text()).toBe(200);

    const rolledBack = incidentSnapshot(HAPPY_ASSET_ID);
    expect(rolledBack.isolated).toBe(false);
    expect(rolledBack.activeDiversionZones.every((zoneId) => zoneId === rolledBack.accountZoneId)).toBe(true);
    expect(rolledBack.selectedDpIds.length).toBeGreaterThan(0);
    expect(rolledBack.selectedDpZones.every((zoneId) => zoneId === rolledBack.accountZoneId)).toBe(true);
  });

  test('treats non-isolated incident as a successful disable no-op', async ({ request }) => {
    const baseUrl = await login(request);

    const response = await request.post(`${baseUrl}/api/incident/isolation/disable/${HAPPY_ASSET_ID}`);
    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toEqual({ reply: 'OK' });

    const after = incidentSnapshot(HAPPY_ASSET_ID);
    expect(after).toMatchObject({
      isolated: false,
      taskCount: 0,
      backupIncidentCount: 0,
    });
    expect(after.activeDiversionZones).toEqual([after.accountZoneId]);
  });

  test('treats missing active incident as a successful disable no-op', async ({ request }) => {
    const baseUrl = await login(request);

    const response = await request.post(`${baseUrl}/api/incident/isolation/disable/${NO_ACTIVE_INCIDENT_ASSET_ID}`);
    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toEqual({ reply: 'OK' });

    expect(incidentSnapshot(NO_ACTIVE_INCIDENT_ASSET_ID)).toMatchObject({
      hasIncident: false,
      taskCount: 0,
      backupIncidentCount: 0,
    });
  });

  test('treats Attack Zone account as a successful disable no-op', async ({ request }) => {
    const before = incidentSnapshot(HAPPY_ASSET_ID);
    mongoEval(`db.Accounts.updateOne(
      { _id: db.Assets.findOne({ _id: ObjectId('${HAPPY_ASSET_ID}') }).account },
      { $set: { zone: ObjectId('${before.attackZoneId}') } }
    )`);
    mongoEval(`db.Incidents.updateOne(
      { asset: ObjectId('${HAPPY_ASSET_ID}'), endedAt: null },
      { $set: { isolation_state: { isolated: true, isolated_at: new Date(), trigger: 'manual' } } }
    )`);
    const baseUrl = await login(request);

    const response = await request.post(`${baseUrl}/api/incident/isolation/disable/${HAPPY_ASSET_ID}`);
    expect(response.status(), await response.text()).toBe(200);

    const after = incidentSnapshot(HAPPY_ASSET_ID);
    expect(after).toMatchObject({
      isolated: true,
      taskCount: 0,
      backupIncidentCount: 0,
    });
  });

  test('rejects disable when the incident is already queued', async ({ request }) => {
    mongoEval(`db.Incidents.updateOne(
      { asset: ObjectId('${HAPPY_ASSET_ID}'), endedAt: null },
      { $set: {
        in_queue: true,
        isolation_state: { isolated: true, isolated_at: new Date(), trigger: 'manual' }
      } }
    )`);
    const baseUrl = await login(request);

    const response = await request.post(`${baseUrl}/api/incident/isolation/disable/${HAPPY_ASSET_ID}`);
    expect(response.status(), await response.text()).toBe(409);
    expect(await response.json()).toEqual({
      error: { message: 'Incident action is already in queue' },
    });
  });

  test('rejects disable while another rollback request holds the asset lock', async ({ request }) => {
    const baseUrl = await login(request);
    await enableIsolation(request, baseUrl);
    lockIsolation(HAPPY_ASSET_ID, 'IncidentIsolationRollback');

    const response = await request.post(`${baseUrl}/api/incident/isolation/disable/${HAPPY_ASSET_ID}`);
    expect(response.status(), await response.text()).toBe(409);
    expect(await response.json()).toEqual({
      error: { message: 'Incident isolation rollback is already in progress' },
    });

    const after = incidentSnapshot(HAPPY_ASSET_ID);
    expect(after).toMatchObject({
      isolated: true,
    });
    expect(after.activeDiversionZones).toEqual([after.attackZoneId]);
  });

  test('requires operator role for disable', async ({ request }) => {
    const baseUrl = await login(request);
    await enableIsolation(request, baseUrl);
    mongoEval(`db.Users.updateOne(
      { email: 'twister@example.com' },
      { $set: {
        role: 'user',
        roles: { currentAccount: ['basicUser'], childAccount: ['basicUser'] }
      } }
    )`);

    const response = await request.post(`${baseUrl}/api/incident/isolation/disable/${HAPPY_ASSET_ID}`);
    expect(response.status(), await response.text()).toBe(403);
    expect(incidentSnapshot(HAPPY_ASSET_ID)).toMatchObject({
      isolated: true,
    });
  });

  // CDDOS-2277: update-during-isolation coverage. These tests prove stale account-zone payloads,
  // selected-DP replacements, and newly added SC legs are forced to Attack Zone.
  test('keeps isolated incident updates in Attack Zone when the request carries a stale account zone', async ({ request }) => {
    const baseUrl = await login(request);
    await enableIsolation(request, baseUrl);
    const update = staleZoneUpdatePayload(HAPPY_ASSET_ID);

    const response = await request.post(`${baseUrl}/api/incident/${update.incidentId}`, {
      data: update.data,
    });
    expect(response.status(), await response.text()).toBe(200);

    const after = incidentSnapshot(HAPPY_ASSET_ID);
    expect(after.isolated).toBe(true);
    expect(after.activeDiversionZones).toEqual([after.attackZoneId]);
  });

  test('forces Attack Zone when replacing selected DPs on an isolated incident', async ({ request }) => {
    const baseUrl = await login(request);
    await enableIsolation(request, baseUrl);
    const update = staleZoneUpdatePayload(HAPPY_ASSET_ID, {
      replacePrimaryDp: '647f4881a4ceb56ee84228c0',
    });

    const response = await request.post(`${baseUrl}/api/incident/${update.incidentId}`, {
      data: update.data,
    });
    expect(response.status(), await response.text()).toBe(200);

    const after = incidentSnapshot(HAPPY_ASSET_ID);
    expect(after.isolated).toBe(true);
    expect(after.activeDiversionZones).toEqual([after.attackZoneId]);
    expect(after.selectedDpIds).toContain('647f4881a4ceb56ee84228c0');
  });

  test('forces Attack Zone when adding an additional scrubbing center to an isolated incident', async ({ request }) => {
    const baseUrl = await login(request);
    await enableIsolation(request, baseUrl);
    prepareAdditionalScAttackZoneDps();
    const update = staleZoneUpdatePayload(HAPPY_ASSET_ID, { addAdditionalSc: true });

    const response = await request.post(`${baseUrl}/api/incident/${update.incidentId}`, {
      data: update.data,
    });
    expect(response.status(), await response.text()).toBe(200);

    const after = incidentSnapshot(HAPPY_ASSET_ID);
    expect(after.isolated).toBe(true);
    expect(after.activeScrubbingCenterIds).toEqual(expect.arrayContaining([PRIMARY_SC_ID, ADDITIONAL_SC_ID]));
    expect(after.activeDiversionZones.every((zoneId) => zoneId === after.attackZoneId)).toBe(true);
  });

  test('incident-manager moves queued isolation tasks into execution states', async ({ request }) => {
    const baseUrl = await login(request);
    const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${HAPPY_ASSET_ID}`, {
      data: { trigger: 'manual' },
    });
    expect(response.status(), await response.text()).toBe(200);

    const promoted = await waitFor(() => {
      const snapshot = taskExecutionSnapshot(HAPPY_ASSET_ID);
      const allowedExecutionStates = ['pending', 'in_progress', 'failed', 'done'];
      if (!snapshot.incidentInQueue && snapshot.taskCount > 0
        && snapshot.uniqueStatuses.every((status) => allowedExecutionStates.includes(status))) {
        return snapshot;
      }
      return null;
    }, { timeoutMs: 20000, intervalMs: 500 });

    expect(promoted.taskIds.length).toBe(promoted.taskCount);
    expect(promoted.actions).toEqual(expect.arrayContaining(['activate', 'deactivate']));
  });
});
