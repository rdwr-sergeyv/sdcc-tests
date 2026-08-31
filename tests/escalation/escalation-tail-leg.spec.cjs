// Escalating a TAIL diversion -- the additional-SC leg (E-29, CDDOS-3302).
//
// WHY THIS EXISTS, AND WHY IT IS NOT A RE-RUN OF THE DEDUPE SUITE
//   E-29 -- "escalating an additional-SC (tail) diversion" -- is recorded in the register as MOOT,
//   on the argument that all announcers stop and one appears, so a tail is not a special case. That
//   is reasoning. Nothing has ever observed it, because the lab could not produce the shape.
//
//   escalation-dedupe.spec.cjs comes close and stops short: it submits BOTH topology entries as
//   heads, with no `sc_connections`, so it proves one-leg-per-target and says nothing about anycast
//   shape. The difference is one key in the payload.
//
// WHAT MAKES A TAIL A TAIL
//   _get_diversion_automatic_topology emits `topology['sc_connections'] = [str(head_sc_id)]` for an
//   additional SC (sdcc/common/util/diversion.py:728). activate_incident splits heads from tails on
//   exactly that key (:2556), and _parse_action_args reads it into action_arguments['sc_connected']
//   (:495), which is where diversion.state.sc_connected comes from. Set it and the fixture stops
//   being two co-equal heads and becomes a head with a tail.
//
// WHAT IS ASSERTED AND WHAT IS ONLY RECORDED
//   Asserted, because the behaviour is decided: one leg per TARGET even when an original is a tail;
//   both originals survive; the tail keeps its sc_connected across the escalate (:1485 preserves
//   it); and every announcer demotes -- 19894:911 on the ARs of BOTH regular SCs and none at the
//   Escalation SC.
//
//   RECORDED, NOT ASSERTED: whether the new escalation leg comes out as a head. E-29 lists three
//   plausible answers -- the tail does not escalate at all, its escalation leg stays connected to
//   the original head, or the whole anycast group escalates together -- and picking one is a
//   product decision, not this suite's. Asserting today's behaviour would pin it as intended.
//   The console.log of the leg shape IS the deliverable here.
//
// SAFETY
//   Escalates for real behind ESCALATION_ALLOW_REAL_ESCALATE=1, and cleans up in a finally: roll
//   back, then deactivate. Activation is type=build, so no device is contacted. If both the rollback
//   and the deactivate fail, the asset needs a hand-written Mongo edit -- the same residual the
//   sibling suites carry.
//
// Run (on the lab VM -- needs mongosh):
//   ESCALATION_ALLOW_REAL_ESCALATE=1 SDCC_PORTAL_PUBLIC_URL=http://10.20.4.20:8000 \
//     npx playwright test tests/escalation/escalation-tail-leg.spec.cjs

const { test, expect } = require('playwright/test');
const { login } = require('../dp-isolate/dp-isolate-helpers.cjs');
const {
  multiScAssetInfo, buildMultiScTopology, assetStatus, settle,
  divertingLegs, announcementTasks, expectDemoted, waitUntilReady,
} = require('./escalation-multi-sc-helpers.cjs');

const ASSET_NAME = process.env.TAIL_LEG_TEST_ASSET || 'asset_8';
const READY = ['off-cloud', 'activating_request'];

test.describe.configure({ mode: 'serial', timeout: 600000 });

/** The head is the asset's own SITE's SC; every additional SC is a tail of it.
 *
 * multiScAssetInfo returns them in exactly that order -- `[site.sc_id].concat(additional sc ids)` --
 * so scs[0] is the head by construction, not by luck. It is asserted below rather than assumed,
 * because an ordering that is true by construction today is a silent trap the day it changes.
 */
function withTailConnections(topology, info) {
  const headScId = info.scs[0].scId;
  return topology.map((entry) => (entry.sc._oid === headScId
    ? entry
    : { ...entry, sc_connections: [headScId] }));
}

test.describe('CDDOS-3302 -- escalating an additional-SC (tail) diversion', () => {
  let info;

  test.beforeAll(async () => {
    await waitUntilReady(ASSET_NAME, READY);
    info = multiScAssetInfo(ASSET_NAME);
    expect(info.scs.length,
      `${ASSET_NAME} must divert to two SCs for a head/tail pair to exist; it has ${info.scs.length}`)
      .toBe(2);
    const targets = [...new Set(info.scs.map((s) => s.escalatesTo))];
    expect(targets[0], 'neither SC maps to an Escalation SC').toBeTruthy();
    expect(targets.length,
      `both SCs must map to the SAME Escalation SC or the dedupe half tests nothing; `
      + `they map to ${targets.join(', ')}`)
      .toBe(1);
    expect(READY, `test needs ${ASSET_NAME} undiverted, it is ${info.status}`).toContain(info.status);
  });

  test('a tail escalates to the shared target, and every announcer demotes',
    async ({ request }) => {
      test.skip(process.env.ESCALATION_ALLOW_REAL_ESCALATE !== '1',
        'Activates and escalates for real against whatever SDCC_PORTAL_PUBLIC_URL names, then rolls '
        + 'back and deactivates. Set ESCALATION_ALLOW_REAL_ESCALATE=1 to run it.');

      const baseUrl = await login(request);
      const since = new Date().toISOString();
      const target = info.scs[0].escalatesTo;
      const head = info.scs[0];
      const tail = info.scs[1];
      const originals = info.scs.map((s) => s.scName).sort();

      try {
        const activate = await request.post(`${baseUrl}/api/incident/`, {
          data: {
            asset: { _oid: info.id },
            extended_assets_list: [],
            action: 'activate',
            type: 'build',
            topology: withTailConnections(buildMultiScTopology(info, 2), info),
            userInput: { reason: 'Diversion Test', notes: 'E-29 tail leg' },
          },
        });
        expect(activate.status(), await activate.text()).toBe(200);
        await settle(info.id);

        // THE PRECONDITION, and it is not a nicety. If the API ignored `sc_connections` this run
        // would look exactly like the dedupe suite's and pass every assertion below while testing
        // nothing at all. The head/tail relation has to be visible in the stored state first.
        const before = divertingLegs(info.id);
        // eslint-disable-next-line no-console
        console.log(`legs after activate: ${JSON.stringify(before)}`);
        expect(before.map((l) => l.scName).sort(),
          'the asset must be live on both SCs before escalating').toEqual(originals);
        expect(before.find((l) => l.scName === tail.scName).connectedTo,
          `${tail.scName} must be stored as a TAIL of ${head.scName}`).toEqual([head.scId]);
        expect(before.find((l) => l.scName === head.scName).connectedTo,
          `${head.scName} must be stored as a HEAD -- no sc_connected`).toEqual([]);

        const enable = await request.post(
          `${baseUrl}/api/incident/escalation/enable/${info.id}`, { data: { trigger: 'manual' } });
        expect(enable.status(), await enable.text()).toBe(200);
        await settle(info.id);

        const after = divertingLegs(info.id);
        // The E-29 deliverable: what shape the anycast group is actually left in. Read this log
        // before deciding which of E-29's three answers the product should give.
        // eslint-disable-next-line no-console
        console.log(`legs after escalate: ${JSON.stringify(after)}`);

        const targetLegs = after.filter((l) => l.scName === target);
        expect(targetLegs.length,
          `expected exactly one leg at ${target}, got ${targetLegs.length} `
          + `(legs: ${after.map((l) => l.scName).join(', ')})`).toBe(1);
        expect(after.filter((l) => l.scName !== target).map((l) => l.scName).sort(),
          'both original legs must survive the escalate').toEqual(originals);
        expect(after.find((l) => l.scName === tail.scName).connectedTo,
          `${tail.scName} must still be a tail of ${head.scName} -- the unchanged leg preserves `
          + 'sc_connected (diversion.py:1485)').toEqual([head.scId]);

        const announced = announcementTasks(info.id, since);
        // eslint-disable-next-line no-console
        console.log(`announcement tasks after escalate: ${JSON.stringify(announced, null, 1)}`);
        expectDemoted(announced, head.scName, 'add_community');
        // The tail is NOT exempt: escalating_sc_ids returns every eligible diversion regardless of
        // head/tail, so it is told to demote exactly as the head is. "Every announcer demotes" is
        // the requirement, and an assertion on one SC cannot tell it from "this SC demotes".
        expectDemoted(announced, tail.scName, 'add_community');
        expect(announced[`${target}|add_community`],
          `the Escalation SC ${target} must get NO community task -- it is where traffic goes, not `
          + 'an announcer that stops').toBeUndefined();

        const disable = await request.post(
          `${baseUrl}/api/incident/escalation/disable/${info.id}`, { data: { trigger: 'manual' } });
        expect(disable.status(), await disable.text()).toBe(200);
        await settle(info.id);

        const rolledBack = divertingLegs(info.id);
        // eslint-disable-next-line no-console
        console.log(`legs after rollback: ${JSON.stringify(rolledBack)}`);
        expect(rolledBack.map((l) => l.scName).sort(),
          'the rollback must remove the escalation leg and leave both originals').toEqual(originals);
        expect(rolledBack.find((l) => l.scName === tail.scName).connectedTo,
          'the tail must come back a tail').toEqual([head.scId]);

        const withdrawn = announcementTasks(info.id, since);
        // eslint-disable-next-line no-console
        console.log(`announcement tasks after rollback: ${JSON.stringify(withdrawn, null, 1)}`);
        expectDemoted(withdrawn, head.scName, 'remove_community');
        expectDemoted(withdrawn, tail.scName, 'remove_community');
      } finally {
        const deactivate = await request.post(`${baseUrl}/api/incident/`, {
          data: {
            asset: { _oid: info.id },
            extended_assets_list: [],
            action: 'deactivate',
            type: 'build',
            topology: [],
            // deactivate takes its reason from a DIFFERENT enum than activate: "Diversion Test" is
            // rejected here with "Reason field is not valid, use one of: [...]".
            userInput: { reason: 'Diversion Test Ended', notes: 'E-29 cleanup' },
          },
        });
        // reported, not asserted -- a cleanup failure must not mask the real result above
        // eslint-disable-next-line no-console
        console.log(`cleanup deactivate -> ${deactivate.status()}, asset now ${assetStatus(info.id)}`);
      }
    });
});
