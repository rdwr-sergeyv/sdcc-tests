// After a rollback, can the Escalation SC's leg be brought back by an ORDINARY update?
//
// WHY THIS EXISTS
//   It was argued from code that it could, and the argument was wrong. The reasoning went: rollback
//   keeps the leg with `state.deactivated = true` AND its devices; the incident API returns a
//   deactivated leg for ~10 minutes after its teardown tasks finalise; the UI echoes back every leg it
//   is handed; and `update_incident` reads "deactivated + devices present" as ACTIVATE, because
//   `deactivate_required_sc_ids` is only legs with NO devices. Every one of those four is true.
//
//   The conclusion still did not hold, because an operator request never reaches that resolution:
//   `validate_user_request_topology` (sdcc diversion.py:3290) refuses ANY topology naming an
//   Escalation SC, and the handler calls it for both actions (incident.py:858,
//   `if action in [ACTIVATE, UPDATE]`). That was established by simulating update_incident in
//   isolation instead of posting a complete payload -- so this spec exists to do the thing that
//   should have been done first, and to keep doing it.
//
//   It therefore pins an INVARIANT, not a mechanism: a rolled-back escalation leg cannot be revived
//   through the ordinary update path. Whichever layer enforces that -- today the topology validator --
//   is free to change; the invariant is not. If someone narrows the validator, relaxes the action list,
//   or "simplifies" the deactivated-leg handling in update_incident, this fails.
//
// WHAT IT DOES
//   activate -> escalate -> rollback, then takes the incident EXACTLY as the API returns it, maps it
//   to a save payload the way sdcc-diversionsCtrl.js does (sc_id -> sc, state.topology -> devices),
//   and posts it as an ordinary update. It asserts the request is refused AND that no task was created
//   at the Escalation SC afterwards -- because "refused" with tasks created would be the worst of both.
//
//   The API's 10-minute window is OBSERVED, not asserted: whether a deactivated leg is still returned
//   is a display decision that may legitimately change. What must not change is that echoing it back
//   cannot raise the leg. Both branches are logged so a future reader can see which case ran.
//
// SAFETY
//   Escalates for real behind ESCALATION_ALLOW_REAL_ESCALATE=1, cleans up in a finally, type=build so
//   no device is contacted.
//
// Run (on the lab VM -- needs mongosh):
//   ESCALATION_ALLOW_REAL_ESCALATE=1 SDCC_PORTAL_PUBLIC_URL=http://10.20.4.20:8000 \
//     npx playwright test tests/escalation/escalation-rollback-revival.spec.cjs

const { test, expect } = require('playwright/test');
const { login, mongoJson } = require('../dp-isolate/dp-isolate-helpers.cjs');
const {
  multiScAssetInfo, buildMultiScTopology, assetStatus, settle,
  divertingLegs, taskCountsBySc, openIncidentId, waitUntilReady,
} = require('./escalation-multi-sc-helpers.cjs');

const ASSET_NAME = process.env.REVIVAL_TEST_ASSET || 'Test12345';
const READY = ['off-cloud', 'activating_request'];

/** The incident's STORED legs -- what the DB holds, not what the API chooses to show. */
function storedLegs(incidentId) {
  return mongoJson(`(() => {
    const scName = {};
    db.ScrubbingCenters.find({}, { name: 1, sc_type: 1 }).forEach((s) => {
      scName[String(s._id)] = { name: s.name, escalation: s.sc_type === 'escalation' };
    });
    const inc = db.Incidents.findOne({ _id: ObjectId('${incidentId}') });
    return (inc.diversion || []).map((d) => ({
      sc: (scName[String(d.sc_id)] || {}).name || String(d.sc_id),
      isEscalationSc: !!(scName[String(d.sc_id)] || {}).escalation,
      deactivated: !!(d.state || {}).deactivated,
      devices: Object.keys((d.state || {}).topology || {}).length,
    }));
  })()`);
}

/** Map an incident API response to a save payload, the way the legacy UI does.
 *
 * sdcc-diversionsCtrl.js ~220: every leg the response carries becomes a topology entry, with devices
 * taken from `state.topology` and its key written back as `_oid`. Reproduced rather than hand-built,
 * because the question is what a real client would send back.
 */
function echoTopology(apiLegs) {
  return apiLegs.map((leg) => ({
    sc: leg.sc_id,
    line_type: leg.line_type || 'DDOS',
    sc_prepend: leg.sc_prepend || 0,
    deactivated: (leg.state || {}).deactivated,
    devices: Object.entries((leg.state || {}).topology || {})
      .map(([oid, dev]) => ({ ...dev, _oid: oid })),
  }));
}

function scIdByName(name) {
  return mongoJson(`(() => {
    const sc = db.ScrubbingCenters.findOne({ name: '${name}' });
    return sc ? String(sc._id) : null;
  })()`);
}

test.describe.configure({ mode: 'serial', timeout: 600000 });

test.describe('a rolled-back escalation leg cannot be revived by an ordinary update', () => {
  let info;
  let original;
  let target;

  test.beforeAll(async () => {
    await waitUntilReady(ASSET_NAME, READY);
    info = multiScAssetInfo(ASSET_NAME);
    expect(info.scs.length,
      `${ASSET_NAME} must divert to exactly ONE SC for this probe; it has ${info.scs.length}`).toBe(1);
    [original] = info.scs;
    target = original.escalatesTo;
    expect(target, `${original.scName} does not map to an Escalation SC`).toBeTruthy();
    expect(READY, `test needs ${ASSET_NAME} undiverted, it is ${info.status}`).toContain(info.status);
  });

  test('echoing the dead leg back into an update neither revives it nor creates tasks', async ({ request }) => {
    test.skip(process.env.ESCALATION_ALLOW_REAL_ESCALATE !== '1',
      'activates, escalates, rolls back and deactivates for real. '
      + 'Set ESCALATION_ALLOW_REAL_ESCALATE=1 to run it.');

    const baseUrl = await login(request);

    try {
      const activate = await request.post(`${baseUrl}/api/incident/`, {
        data: {
          asset: { _oid: info.id },
          extended_assets_list: [],
          action: 'activate',
          type: 'build',
          topology: buildMultiScTopology(info, 2),
          userInput: { reason: 'Diversion Test', notes: 'rollback revival probe' },
        },
      });
      expect(activate.status(), await activate.text()).toBe(200);
      await settle(info.id);

      const enable = await request.post(
        `${baseUrl}/api/incident/escalation/enable/${info.id}`, { data: { trigger: 'manual' } });
      expect(enable.status(), await enable.text()).toBe(200);
      await settle(info.id);
      expect(divertingLegs(info.id).map((l) => l.scName).sort(), 'escalated: two active legs')
        .toEqual([original.scName, target].sort());

      const disable = await request.post(
        `${baseUrl}/api/incident/escalation/disable/${info.id}`, { data: { trigger: 'manual' } });
      expect(disable.status(), await disable.text()).toBe(200);
      await settle(info.id);
      expect(divertingLegs(info.id).map((l) => l.scName), 'rolled back: the original leg alone')
        .toEqual([original.scName]);

      // The leg is RETAINED, deactivated, with its devices -- the precondition the whole argument
      // rested on. Asserted, because if retention ever stops the rest of this spec is moot and the
      // reader should be told why.
      const incidentId = openIncidentId(info.id);
      const stored = storedLegs(incidentId);
      // eslint-disable-next-line no-console
      console.log(`stored legs after rollback: ${JSON.stringify(stored)}`);
      const deadLeg = stored.find((l) => l.isEscalationSc && l.deactivated);
      expect(deadLeg, 'the escalation leg is kept, deactivated, for the diversion log').toBeTruthy();
      expect(deadLeg.devices, 'and it keeps its devices -- that is what makes revival conceivable')
        .toBeGreaterThan(0);

      // What the API is willing to hand a client, right now, inside the 10-minute window. Observed.
      const shown = await request.get(`${baseUrl}/api/incident/${incidentId}`);
      expect(shown.status(), await shown.text()).toBe(200);
      const apiLegs = (await shown.json()).reply.diversion || [];
      const deadShown = apiLegs.filter((l) => (l.state || {}).deactivated);
      // eslint-disable-next-line no-console
      console.log(`API returned ${apiLegs.length} leg(s), ${deadShown.length} of them deactivated`
        + `${deadShown.length ? ' -- inside the 10-minute window, so a client CAN echo it' : ' -- filtered, nothing to echo'}`);

      // THE ATTEMPT. Echo the response back verbatim, as an ordinary update.
      const sinceRevival = new Date().toISOString();
      const revive = await request.post(`${baseUrl}/api/incident/${incidentId}`, {
        data: {
          asset: { _oid: info.id },
          extended_assets_list: [],
          action: 'update',
          type: 'build',
          topology: echoTopology(apiLegs),
        },
      });
      const body = await revive.text();
      // eslint-disable-next-line no-console
      console.log(`revival attempt -> ${revive.status()} ${body.slice(0, 300)}`);

      if (deadShown.length) {
        // The payload names the Escalation SC, so it must be refused outright.
        expect(revive.status(), `echoing a dead escalation leg must be refused: ${body}`)
          .toBeGreaterThanOrEqual(400);
        expect(revive.status(), body).toBeLessThan(500);
      }

      await settle(info.id);

      // The invariant, whichever way the request went: the leg is still down, and nothing was
      // configured at the Escalation SC.
      const afterLegs = divertingLegs(info.id).map((l) => l.scName);
      // eslint-disable-next-line no-console
      console.log(`active legs after the attempt: ${JSON.stringify(afterLegs)}`);
      expect(afterLegs, 'the Escalation SC leg must still be down').toEqual([original.scName]);

      const created = taskCountsBySc(info.id, sinceRevival);
      // eslint-disable-next-line no-console
      console.log(`tasks created by the attempt: ${JSON.stringify(created)}`);
      expect(created[target], `no task may be created at the Escalation SC ${target}`).toBeUndefined();

      const afterStored = storedLegs(incidentId);
      expect(afterStored.find((l) => l.isEscalationSc).deactivated,
        'and the stored leg is still marked deactivated').toBe(true);

      // SECOND CHECK, and it is a different question. The echo above is refused, but with an EMPTY
      // message -- the payload dies on some earlier validation, so "refused" there does not prove the
      // escalation rule is what refused it. A WELL-FORMED topology naming the Escalation SC isolates
      // that rule: it must be refused with a message that names the SC, or an operator is told
      // nothing actionable. (The device id is deliberately bogus: the escalation check sits before
      // the device loop, so if the rule ever stops firing this fails on the device instead -- loudly,
      // and still without diverting anything.)
      const wellFormed = await request.post(`${baseUrl}/api/incident/${incidentId}`, {
        data: {
          asset: { _oid: info.id },
          extended_assets_list: [],
          action: 'update',
          type: 'build',
          topology: [{
            sc: { _oid: scIdByName(target) },
            sc_prepend: 0,
            line_type: 'DDOS',
            devices: [{ _oid: '000000000000000000000000', type: 'dp', selected: true }],
          }],
        },
      });
      const wellFormedBody = await wellFormed.text();
      // eslint-disable-next-line no-console
      console.log(`well-formed update naming ${target} -> ${wellFormed.status()} `
        + `${wellFormedBody.slice(0, 300)}`);
      expect(wellFormed.status(), wellFormedBody).toBeGreaterThanOrEqual(400);
      expect(wellFormed.status(), wellFormedBody).toBeLessThan(500);
      expect(wellFormedBody, 'the refusal must name the Escalation SC, so it is actionable')
        .toContain(target);
      expect(taskCountsBySc(info.id, sinceRevival)[target],
        'and still no task at the Escalation SC').toBeUndefined();
    } finally {
      const deactivate = await request.post(`${baseUrl}/api/incident/`, {
        data: {
          asset: { _oid: info.id },
          extended_assets_list: [],
          action: 'deactivate',
          type: 'build',
          topology: [],
          userInput: { reason: 'Diversion Test Ended', notes: 'revival probe cleanup' },
        },
      });
      // eslint-disable-next-line no-console
      console.log(`cleanup deactivate -> ${deactivate.status()}, asset now ${assetStatus(info.id)}`);
    }
  });
});
