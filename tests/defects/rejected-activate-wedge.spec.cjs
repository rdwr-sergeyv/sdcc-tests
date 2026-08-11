// Reproduction tests for: a rejected activate strands the asset.
// See docs/kb/troubleshooting/rejected-activate-wedges-asset.md
//
// WHAT THESE ASSERT
//   The DESIRED behaviour. They were written against the defect and marked `test.fail()`; the fix
//   in sdcc `fix/reject-activate-before-writing-state` (plus its sdcc-portal counterpart) makes
//   them pass, so the annotations are gone and these are now plain regression tests.
//   THEY REQUIRE THAT FIX -- on an unpatched dev they will fail, which is the point.
//
// THE DEFECT, briefly
//   _start_incident creates the tasks, flips the asset to `activating`, and only then calls
//   incident.save() -- which is where the `activate_reason` choices validator finally runs
//   (sdcc/sdcc/common/util/diversion.py:2112-2116, sdcc/sdcc/common/model/documents.py:5686).
//   The except block reverts neither the status nor the records (diversion.py:2141-2150), and
//   `activating` is accepted by no action at all (diversion.py:1988), so the asset can no longer be
//   activated, updated or deactivated. There is no incident, so there is nothing to clean up through
//   the product -- only a Mongo edit gets it back.
//
//   A bad enum is merely the trigger that is easy to send. Any throw in that window does the same,
//   including a Mongo hiccup during that one save() -- which needs no misuse by anyone.
//
// SAFETY
//   Everything runs with type=build, so no device is contacted. Each test repairs the asset
//   afterwards -- and the fact that repair means writing to Mongo directly IS the defect.
//
// Run:  npx playwright test tests/defects

const { test, expect } = require('playwright/test');
const { login, mongoEval, mongoJson, waitFor } = require('../dp-isolate/dp-isolate-helpers.cjs');

const ASSET_NAME = process.env.DEFECT_TEST_ASSET || 'asset_1';
const INVALID_REASON = 'not-a-valid-reason';   // outside ACTIVATE_REASON (constants.py:112)

test.describe.configure({ mode: 'serial', timeout: 180000 });

// ---------------------------------------------------------------- helpers

function assetInfo(name) {
  return mongoJson(`(() => {
    const a = db.Assets.findOne({ name: '${name}', type: 'network' });
    if (!a) throw new Error('asset not found: ${name}');
    const siteIds = (a.asset_site_data || []).map((s) => s.account_site);
    const sites = db.AccountSites.find({ _id: { $in: siteIds } }).toArray();
    const sc = db.ScrubbingCenters.findOne({ _id: sites[0].sc_id });
    const account = db.Accounts.findOne({ _id: a.account });
    // zone closure, so we can pick DPs the account zone actually admits. Picking an out-of-zone DP
    // is rejected EARLIER, cleanly, with "One of the Dps does not match the account zone: <name>" --
    // which would make this test pass for the wrong reason and never reach the defect.
    const zones = {};
    db.DPZones.find({}).forEach((z) => { zones[String(z._id)] = z; });
    const closure = [];
    let cur = zones[String(account.zone)];
    while (cur) { closure.push(String(cur._id)); cur = cur.fail_over ? zones[String(cur.fail_over)] : null; }
    return {
      id: String(a._id),
      status: a.status,
      address: String(a.address),
      mask: Number(a.mask) || 24,
      zoneId: String(account.zone),
      scId: String(sc._id),
      devices: (sc.management_devices || [])
        .filter((d) => ['radware-defensepro', 'router-out', 'router-in'].includes(d.role))
        .map((d) => ({
          id: String(d.unique_id),
          role: d.role,
          inZone: d.role !== 'radware-defensepro' || closure.includes(String(d.zone)),
        })),
    };
  })()`);
}

function assetStatus(assetId) {
  return mongoJson(`(() => {
    const a = db.Assets.findOne({ _id: ObjectId('${assetId}') }, { status: 1 });
    return a ? a.status : null;
  })()`);
}

function openIncidentId(assetId) {
  return mongoJson(`(() => {
    const i = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    return i ? String(i._id) : null;
  })()`);
}

function unfinishedTaskCount() {
  return mongoJson(`(() => db.Tasks.countDocuments({ status: { $in: ['pending', 'in_progress', 'in_queue'] } }))()`);
}

/**
 * Put the asset back in a usable state. This exists only because the product cannot: there is no
 * incident to deactivate, so no API call can undo a wedged activate. If this helper ever becomes
 * unnecessary, the defect is fixed.
 */
function repair(assetId) {
  mongoEval(`
    db.Tasks.updateMany(
      { status: { $in: ['pending', 'in_progress', 'in_queue'] }, type: 'build' },
      { $set: { status: 'failed', error: 'orphaned by the rejected-activate reproduction test' } });
    db.Assets.updateOne(
      { _id: ObjectId('${assetId}'), status: { $in: ['activating', 'pending'] } },
      { $set: { status: 'off-cloud' } });
  `);
}

function buildTopology(info, selectedDpCount) {
  let picked = 0;
  const devices = info.devices.map((d) => {
    if (d.role === 'radware-defensepro') {
      const selected = d.inZone && picked < selectedDpCount;
      if (selected) picked += 1;
      return {
        _oid: d.id, type: 'dp', selected, implicit: false,
        'dp-subnet': info.address, 'dp-mask': info.mask,
      };
    }
    return { _oid: d.id, type: d.role, selected: d.role === 'router-in', implicit: false };
  });
  // select exactly one router-out so the payload is a realistic activation
  const firstAr = devices.find((d) => d.type === 'router-out');
  if (firstAr) firstAr.selected = true;
  return [{
    sc: { _oid: info.scId },
    line_type: 'DDOS',
    sc_prepend: 0,
    zone: { _oid: info.zoneId },
    devices,
  }];
}

/** Fire an activate whose `reason` the server will reject, and hand back the raw response. */
async function activateWithInvalidReason(request, baseUrl, info) {
  return request.post(`${baseUrl}/api/incident/`, {
    data: {
      asset: { _oid: info.id },
      extended_assets_list: [],
      action: 'activate',
      type: 'build', // never provisioning: no device may be contacted by a defect test
      topology: buildTopology(info, 2),
      userInput: { reason: INVALID_REASON, notes: 'defect reproduction' },
    },
  });
}

// ---------------------------------------------------------------- tests

test.describe('a rejected activate must not damage the asset', () => {
  let info;

  test.beforeEach(async () => {
    info = assetInfo(ASSET_NAME);
    // start clean; if a previous run wedged it, repair rather than skip -- otherwise the first
    // failure hides every later one
    if (info.status !== 'off-cloud') {
      const open = openIncidentId(info.id);
      expect(open, `asset ${ASSET_NAME} is ${info.status} with an open incident; deactivate it first`).toBeNull();
      repair(info.id);
      info = assetInfo(ASSET_NAME);
    }
    expect(info.status, 'test needs the asset off-cloud to begin').toBe('off-cloud');
  });

  test.afterEach(async () => {
    repair(info.id);
    await waitFor(() => (assetStatus(info.id) === 'off-cloud' ? true : null), { timeoutMs: 30000 });
  });

  test('is refused with a 4xx before anything is written', async ({ request }) => {
    const baseUrl = await login(request);
    const response = await activateWithInvalidReason(request, baseUrl, info);

    // A bad field value is a client error. Today it is a 500 carrying a mongoengine
    // ValidationError, because the value is only checked when the document is saved.
    const body = await response.text();
    // must be rejected FOR THE REASON FIELD. Without this the test passes vacuously on any other
    // 400 -- an out-of-zone DP, say -- and never exercises the defect at all.
    expect(body, 'rejection must be about the reason field').toMatch(/reason/i);
    expect(response.status(), body).toBeGreaterThanOrEqual(400);
    expect(response.status(), body).toBeLessThan(500);
  });

  test('leaves the asset usable, not stranded in "activating"', async ({ request }) => {
    const baseUrl = await login(request);
    await activateWithInvalidReason(request, baseUrl, info);

    // The wedge: `activating` is in neither STATUS_READY_LIST nor STATUS_DIVERTED_LIST
    // (constants.py:1059-1061), so every subsequent action is refused and no incident exists to
    // deactivate. The asset is unusable until someone edits Mongo.
    expect(assetStatus(info.id), 'a refused request must not change the asset status').toBe('off-cloud');
  });

  test('leaves no orphaned tasks behind', async ({ request }) => {
    const baseUrl = await login(request);
    const before = unfinishedTaskCount();
    await activateWithInvalidReason(request, baseUrl, info);

    // Tasks are built before the save that validates, so a rejected activate leaves them queued
    // against an incident that was never persisted. They are inert today only by coincidence --
    // the executor selects on `{status, dependencies: []}` and never checks the incident
    // (task_executor.py:83-85); what keeps them still is that releasing `in_queue` is keyed on the
    // incident (diversion.py:2589). If that ever changes, these become runnable.
    expect(unfinishedTaskCount(), 'a refused request must not queue tasks').toBe(before);
  });

  test('and the asset really is recoverable afterwards (guards the repair helper)', async () => {
    // Not a defect assertion -- this proves afterEach actually restores the lab, so a failing run
    // above cannot silently leave the asset wedged for whatever runs next.
    expect(assetStatus(info.id)).toBe('off-cloud');
    expect(openIncidentId(info.id)).toBeNull();
  });
});
