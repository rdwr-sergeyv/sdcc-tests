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

function incidentSnapshot(assetId) {
  return mongoJson(`(() => {
    const incident = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    if (!incident) return null;
    const attackZone = db.DPZones.findOne({ name: 'attack_zone' });
    const activeDiversions = (incident.diversion || []).filter((diversion) => !(diversion.state || {}).deactivated);
    const selectedDpIds = activeDiversions.flatMap((diversion) => Object.entries((diversion.state || {}).topology || {})
      .filter((entry) => entry[1] && entry[1].selected)
      .map((entry) => entry[0]));
    return {
      id: String(incident._id),
      asset: String(incident.asset),
      inQueue: Boolean(incident.in_queue),
      isolated: Boolean(incident.isolation_state && incident.isolation_state.isolated),
      isolationTrigger: incident.isolation_state && incident.isolation_state.trigger || null,
      activeDiversionZones: activeDiversions.map((diversion) => diversion.zone && String(diversion.zone)),
      attackZoneId: String(attackZone._id),
      originalSelectedDpIds: activeDiversions.flatMap((diversion) => (diversion.original_selected_dp_ids || []).map(String)),
      selectedDpIds,
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

test.describe.serial('DP Isolate API', () => {
  let cmdExecutorWasStopped = false;

  test.beforeEach(() => {
    restoreReadyForTests();
  });

  test.afterAll(() => {
    if (cmdExecutorWasStopped) {
      docker(['start', 'legacy-portal-cmd-executor-1']);
      cmdExecutorWasStopped = false;
    }
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

  test('incident-manager promotes queued isolation tasks to pending', async ({ request }) => {
    docker(['stop', 'legacy-portal-cmd-executor-1']);
    cmdExecutorWasStopped = true;

    const baseUrl = await login(request);
    const response = await request.post(`${baseUrl}/api/incident/isolation/enable/${HAPPY_ASSET_ID}`, {
      data: { trigger: 'manual' },
    });
    expect(response.status(), await response.text()).toBe(200);

    const promoted = await waitFor(() => {
      const snapshot = taskExecutionSnapshot(HAPPY_ASSET_ID);
      if (!snapshot.incidentInQueue && snapshot.taskCount > 0 && snapshot.uniqueStatuses.length === 1
        && snapshot.uniqueStatuses[0] === 'pending') {
        return snapshot;
      }
      return null;
    }, { timeoutMs: 20000, intervalMs: 500 });

    expect(promoted.taskIds.length).toBe(promoted.taskCount);
    expect(promoted.pendingModifiedCount).toBe(promoted.taskCount);
    expect(promoted.actions).toEqual(expect.arrayContaining(['activate', 'deactivate']));

    docker(['start', 'legacy-portal-cmd-executor-1']);
    cmdExecutorWasStopped = false;
  });
});
