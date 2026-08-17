// Contract test for the legacy escalation endpoints (CDDOS-3006, design section 7b).
//
//   POST /api/incident/escalation/enable/<asset_id>    body {"trigger": "manual"|"auto"}
//   POST /api/incident/escalation/disable/<asset_id>   body {"trigger": "manual"|"auto"}
//
// WHY THIS EXISTS -- both endpoints
//   Enable submits the real action as of CDDOS-3009, disable as of CDDOS-3010. The guards, the
//   status codes and the shape of a refusal are what integration is written against, so they are
//   pinned here.
//
// SAFETY -- WHY THE ROUND TRIP IS STILL OPT-IN
//   CDDOS-3010 made the escalate undoable, so the round trip below cleans up after itself. What it
//   cannot recover from is a rollback that FAILS mid-way: deactivating an escalated diversion is
//   CDDOS-3015 and does not exist, so a stranded escalation still needs a hand-written Mongo edit.
//   Until the round trip has been exercised against the lab a few times, it stays behind
//   ESCALATION_ALLOW_REAL_ESCALATE=1. Everything else -- every guard, and the 409 for rolling back
//   an asset that never escalated -- runs unconditionally.
//
//   The rest of the suite activates with type=build, so no device is contacted, and deactivates in
//   the same way afterwards.
//
// Run:  npx playwright test tests/escalation

const { test, expect } = require('playwright/test');
const { login, mongoJson, waitFor } = require('../dp-isolate/dp-isolate-helpers.cjs');

// asset_1 is NOT used here: it is reserved for a person (Amit) driving the Unified-side
// integration against the lab. These suites activate and deactivate their asset, so they
// need one nobody is holding. Override with the env var if that ever changes.
const ASSET_NAME = process.env.ESCALATION_TEST_ASSET || 'asset_3';
const ABSENT_ID = '000000000000000000000000';
const READY = ['off-cloud', 'activating_request'];
const DIVERTED = ['on-cloud', 'pending', 'on-cloud-bGP-pending', 'deactivating-request'];

test.describe.configure({ mode: 'serial', timeout: 300000 });

// ---------------------------------------------------------------- helpers

/** Asset, plus the in-zone devices needed to build a topology the zone validator will accept. */
function assetInfo(name) {
  return mongoJson(`(() => {
    const a = db.Assets.findOne({ name: '${name}', type: 'network' });
    if (!a) throw new Error('asset not found: ${name}');
    const site = db.AccountSites.findOne({ _id: (a.asset_site_data || [])[0].account_site });
    const sc = db.ScrubbingCenters.findOne({ _id: site.sc_id });
    const account = db.Accounts.findOne({ _id: a.account });
    // zone closure -- an out-of-zone DP is refused earlier, with a different message, which would
    // make the final guarded-response assertion below pass for the wrong reason
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
      scName: sc.name,
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

/** Wait until the incident is out of the scheduler's queue.
 *
 * Every action leaves `in_queue: true` and the Incident Aggregator releases it. Firing the next
 * action before that gets "The previous action is in queue" -- a 500 from POST /api/incident/, and a
 * 409 from the escalation endpoints. Measured on the lab 2026-08-16: the escalate's queue flag was
 * still set 230ms later, so back-to-back calls are a race, not a valid sequence.
 */
async function waitForQueueToClear(assetId) {
  await waitFor(() => (mongoJson(`(() => {
    const i = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    return !i || i.in_queue !== true;
  })()`) ? true : null), { timeoutMs: 120000 });
}

/** The SCs this asset's open incident holds active (non-deactivated) diversions on. */
function activeDiversionScs(assetId) {
  return mongoJson(`(() => {
    const i = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    if (!i) return [];
    return (i.diversion || [])
      .filter((d) => !(d.state || {}).deactivated)
      .map((d) => (db.ScrubbingCenters.findOne({ _id: d.sc_id }) || {}).name);
  })()`);
}

function buildTopology(info, dpCount) {
  let picked = 0;
  const devices = info.devices.map((d) => {
    if (d.role === 'radware-defensepro') {
      const selected = d.inZone && picked < dpCount;
      if (selected) picked += 1;
      return { _oid: d.id, type: 'dp', selected, implicit: false, 'dp-subnet': info.address, 'dp-mask': info.mask };
    }
    return { _oid: d.id, type: d.role, selected: d.role === 'router-in', implicit: false };
  });
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

function escalate(request, baseUrl, which, assetId, body) {
  return request.post(`${baseUrl}/api/incident/escalation/${which}/${assetId}`, { data: body });
}

// ---------------------------------------------------------------- guard contract

test.describe('legacy escalation endpoints -- guard contract', () => {
  for (const which of ['enable', 'disable']) {
    test(`${which}: unknown asset is 404`, async ({ request }) => {
      const baseUrl = await login(request);
      const res = await escalate(request, baseUrl, which, ABSENT_ID, { trigger: 'manual' });
      expect(res.status(), await res.text()).toBe(404);
      expect(await res.text()).toMatch(/was not found/i);
    });

    if (which === 'enable') {
      test('enable: a trigger outside the enum is 400', async ({ request }) => {
        const baseUrl = await login(request);
        const info = assetInfo(ASSET_NAME);
        for (const body of [{ trigger: 'whatever' }, {}]) {
          const res = await escalate(request, baseUrl, which, info.id, body);
          expect(res.status(), await res.text()).toBe(400);
          // the message must enumerate the accepted values -- the client shows it to an operator
          expect(await res.text()).toMatch(/manual.*auto|auto.*manual/);
        }
      });
    } else {
      test('disable: the trigger is accepted without being validated, as isolation does', async ({ request }) => {
        // Deliberate asymmetry, copied from isolation: only the enable side of each pair checks
        // the trigger. Pinned so nobody "fixes" it into a 400 without deciding to diverge.
        //
        // CDDOS-3010 now READS the trigger for the audit entry, which is the moment this comment
        // used to point at. The decision taken [2026-08-16] was to keep accepting anything and
        // record an unrecognised value as NO trigger, rather than reject it -- rejecting would
        // break the alignment, and storing it would fail the model's own `choices` check and reach
        // the operator as a 500. Still open: whether to validate here after all.
        const baseUrl = await login(request);
        const info = assetInfo(ASSET_NAME);
        for (const body of [{ trigger: 'whatever' }, {}]) {
          const res = await escalate(request, baseUrl, which, info.id, body);
          const text = await res.text();
          expect(res.status(), text).not.toBe(400);
          expect(text, 'a bad trigger must fall through to the next guard, not be reported').not.toMatch(/invalid trigger/i);
        }
      });
    }

    test(`${which}: an off-cloud asset is 404, for both triggers`, async ({ request }) => {
      const baseUrl = await login(request);
      const info = assetInfo(ASSET_NAME);
      expect(READY, `test needs ${ASSET_NAME} undiverted, it is ${info.status}`).toContain(info.status);
      for (const trigger of ['manual', 'auto']) {
        const res = await escalate(request, baseUrl, which, info.id, { trigger });
        expect(res.status(), await res.text()).toBe(404);
        expect(await res.text()).toMatch(/no active incident/i);
      }
    });

    test(`${which}: GET is rejected, the endpoint is POST-only`, async ({ request }) => {
      const baseUrl = await login(request);
      const info = assetInfo(ASSET_NAME);
      const res = await request.get(`${baseUrl}/api/incident/escalation/${which}/${info.id}`);
      expect(res.status()).toBe(405);
    });

    test(`${which}: no session is refused`, async ({ request }) => {
      // deliberately no login() -- a fresh request context carries no cookie
      const base = process.env.SDCC_PORTAL_PUBLIC_URL || 'http://localhost:8000';
      const res = await request.post(`${base}/api/incident/escalation/${which}/${ABSENT_ID}`,
        { data: { trigger: 'manual' } });
      expect([401, 403]).toContain(res.status());
    });
  }
});

// ---------------------------------------------------------------- the guard chain end to end

test.describe('legacy escalation endpoints -- a diverted asset reaches the action', () => {
  let info;

  test.beforeAll(() => {
    info = assetInfo(ASSET_NAME);
    expect(READY, `test needs ${ASSET_NAME} undiverted, it is ${info.status}`).toContain(info.status);
  });

  test('every guard passes on an on-cloud asset, and escalate/rollback round-trips',
    async ({ request }) => {
      test.skip(process.env.ESCALATION_ALLOW_REAL_ESCALATE !== '1',
        'The escalate/rollback round trip has not been exercised against the lab yet, and a '
        + 'rollback that fails mid-way leaves an escalation only a Mongo edit can clear '
        + '(CDDOS-3015 does not exist). Set ESCALATION_ALLOW_REAL_ESCALATE=1 to run it.');
      const baseUrl = await login(request);

      // --- divert it, build-only so no device is touched
      const activate = await request.post(`${baseUrl}/api/incident/`, {
        data: {
          asset: { _oid: info.id },
          extended_assets_list: [],
          action: 'activate',
          type: 'build',
          topology: buildTopology(info, 2),
          userInput: { reason: 'Diversion Test', notes: 'escalation endpoint contract test' },
        },
      });
      expect(activate.status(), await activate.text()).toBe(200);
      await waitFor(() => (DIVERTED.includes(assetStatus(info.id)) ? true : null), { timeoutMs: 120000 });
      expect(openIncidentId(info.id), 'an incident must be open for the escalate guards to pass').not.toBeNull();

      try {
        // A diverted asset that has NOT escalated cannot roll back. 409, not 422: nothing
        // disqualifies the asset, the caller asked to undo something that never happened. This
        // runs before the escalate, so it is the one rollback assertion that changes no state.
        const notEscalated = await escalate(request, baseUrl, 'disable', info.id, { trigger: 'manual' });
        const notEscalatedBody = await notEscalated.text();
        expect(notEscalated.status(), notEscalatedBody).toBe(409);
        expect(notEscalatedBody).toMatch(/not escalated/i);

        // --- escalate. Success carries NO detail about SCs, sites, diversions or incidents
        // [decided 2026-08-16], and means the tasks were SUBMITTED: the call returns before they
        // run, exactly as isolate does.
        const enable = await escalate(request, baseUrl, 'enable', info.id, { trigger: 'manual' });
        const enableBody = await enable.text();
        expect(enable.status(), enableBody).toBe(200);
        expect(JSON.parse(enableBody)).toMatchObject({ reply: 'OK' });
        expect(JSON.parse(enableBody).simulated,
          'the integration stub is gone; a 200 is now a real submission').toBeUndefined();

        // The escalate's tasks have to leave the queue before anything else may act on this
        // incident, and asserting the leg appeared proves the escalate did more than answer 200.
        await waitForQueueToClear(info.id);
        expect(activeDiversionScs(info.id).length,
          'the escalate returned 200 but produced no leg at an Escalation SC')
          .toBeGreaterThanOrEqual(2);

        // --- and back. This is what makes the round trip self-cleaning; before CDDOS-3010 the
        // escalate above could only be undone by hand.
        const disable = await escalate(request, baseUrl, 'disable', info.id, { trigger: 'manual' });
        const disableBody = await disable.text();
        expect(disable.status(), disableBody).toBe(200);
        expect(JSON.parse(disableBody)).toMatchObject({ reply: 'OK' });

        // Same again, and the assertion that matters: a 200 from the rollback must mean the
        // Escalation SC's leg is gone, not merely that the call returned.
        await waitForQueueToClear(info.id);
        expect(activeDiversionScs(info.id),
          'the rollback returned 200 but left the Escalation SC leg active')
          .toEqual([info.scName]);
      } finally {
        // --- put it back, whatever happened above
        const deactivate = await request.post(`${baseUrl}/api/incident/`, {
          data: {
            asset: { _oid: info.id },
            extended_assets_list: [],
            action: 'deactivate',
            type: 'build',
            topology: buildTopology(info, 2),
            userInput: { reason: 'Diversion Test Ended', notes: 'escalation endpoint contract test' },
          },
        });
        expect(deactivate.status(), await deactivate.text()).toBe(200);
        await waitFor(() => (READY.includes(assetStatus(info.id)) ? true : null), { timeoutMs: 120000 });
      }
    });
});

// ---------------------------------------------------------------- CDDOS-3015

test.describe('deactivating an escalated asset tears down both SCs', () => {
  let info;

  test.beforeAll(() => {
    info = assetInfo(ASSET_NAME);
    expect(READY, `test needs ${ASSET_NAME} undiverted, it is ${info.status}`).toContain(info.status);
  });

  test('an escalated asset can still go off-cloud, and leaves no active leg behind',
    async ({ request }) => {
      test.skip(process.env.ESCALATION_ALLOW_REAL_ESCALATE !== '1',
        'Escalates for real. Deactivate is the fallback cleanup here, so if it works the asset '
        + 'ends off-cloud; if it does not, that IS the CDDOS-3015 defect and the asset needs a '
        + 'hand-written Mongo edit. Set ESCALATION_ALLOW_REAL_ESCALATE=1 to run it.');
      const baseUrl = await login(request);

      const activate = await request.post(`${baseUrl}/api/incident/`, {
        data: {
          asset: { _oid: info.id },
          extended_assets_list: [],
          action: 'activate',
          type: 'build',
          topology: buildTopology(info, 2),
          userInput: { reason: 'Diversion Test', notes: 'CDDOS-3015 deactivate-while-escalated' },
        },
      });
      expect(activate.status(), await activate.text()).toBe(200);
      await waitFor(() => (DIVERTED.includes(assetStatus(info.id)) ? true : null), { timeoutMs: 120000 });

      const enable = await escalate(request, baseUrl, 'enable', info.id, { trigger: 'manual' });
      expect(enable.status(), await enable.text()).toBe(200);

      // The escalate must have produced a SECOND active leg. Without this the rest of the test
      // would pass on an asset that never escalated at all.
      await waitFor(() => (activeDiversionScs(info.id).length >= 2 ? true : null), { timeoutMs: 120000 });
      const escalated = activeDiversionScs(info.id);
      expect(escalated.length,
        `expected legs on the Original and the Escalation SC, got ${escalated.join(', ')}`)
        .toBeGreaterThanOrEqual(2);
      await waitForQueueToClear(info.id);

      // --- off-cloud WITHOUT rolling back first. This is the CDDOS-3015 case: the teardown has to
      // cover the Escalation SC's leg as well, and its DPs are in the Attack Zone -- the zone whose
      // fallback closure is itself, which is what E-20 was about.
      const deactivate = await request.post(`${baseUrl}/api/incident/`, {
        data: {
          asset: { _oid: info.id },
          extended_assets_list: [],
          action: 'deactivate',
          type: 'build',
          topology: buildTopology(info, 2),
          userInput: { reason: 'Diversion Test Ended', notes: 'CDDOS-3015 deactivate-while-escalated' },
        },
      });
      expect(deactivate.status(), await deactivate.text()).toBe(200);
      await waitFor(() => (READY.includes(assetStatus(info.id)) ? true : null), { timeoutMs: 120000 });

      // No leg may survive -- neither the Original SC's nor the Escalation SC's. A leftover leg is
      // exactly the "asset cannot be activated normally afterwards" failure the story names.
      expect(activeDiversionScs(info.id),
        'an active diversion survived the deactivate').toEqual([]);
    });
});
