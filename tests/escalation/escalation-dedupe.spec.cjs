// Dedupe by target SC (CDDOS-3302). The case that CANNOT be tested with a single mapped SC.
//
// WHY THIS EXISTS
//   Two standard SCs map to the same Escalation SC: NEW-LAB <- NEW-LAB-2, NEW_SC. An asset diverted
//   on BOTH must produce ONE escalation leg at the shared target, not two. With only one mapped SC
//   in the lab, a build that escalated per-original-leg instead of per-target would pass every other
//   escalation test we have -- and so would a hard-coded target. This is the fixture that makes the
//   SC -> Escalation SC mapping load-bearing.
//
// WHY IT IS SEPARATE FROM escalation-endpoints.spec.cjs
//   That suite's helpers assume a single SC per asset (info.scId / info.scName) and build a
//   one-entry topology. Dedupe needs a topology spanning two SCs, so the helpers here are the
//   multi-SC versions rather than a bent copy of those.
//
// SAFETY
//   Escalates for real behind ESCALATION_ALLOW_REAL_ESCALATE=1, and cleans up in a finally: roll
//   back, then deactivate. Activation is type=build, so no device is contacted. If both the rollback
//   and the deactivate fail, the asset needs a hand-written Mongo edit -- the same residual the
//   sibling suite carries.
//
// Run (on the lab VM -- needs mongosh):
//   ESCALATION_ALLOW_REAL_ESCALATE=1 SDCC_PORTAL_PUBLIC_URL=http://10.20.4.20:8000 \
//     npx playwright test tests/escalation/escalation-dedupe.spec.cjs

const { test, expect } = require('playwright/test');
const { login } = require('../dp-isolate/dp-isolate-helpers.cjs');
// Lifted out on 2026-08-30 so escalation-tail-leg.spec.cjs could use the same five
// rather than become a third copy. Moved verbatim; nothing was rewritten.
const {
  multiScAssetInfo, buildMultiScTopology, activeDiversionScs, assetStatus, settle,
} = require('./escalation-multi-sc-helpers.cjs');

const ASSET_NAME = process.env.DEDUPE_TEST_ASSET || 'asset_5';
const READY = ['off-cloud', 'activating_request'];

test.describe.configure({ mode: 'serial', timeout: 600000 });

test.describe('CDDOS-3302 -- two standard SCs, one Escalation SC', () => {
  let info;

  test.beforeAll(() => {
    info = multiScAssetInfo(ASSET_NAME);
    expect(info.scs.length,
      `${ASSET_NAME} must divert to two SCs for dedupe to mean anything; it has ${info.scs.length}`)
      .toBe(2);
    const targets = [...new Set(info.scs.map((s) => s.escalatesTo))];
    expect(targets[0], 'neither SC maps to an Escalation SC').toBeTruthy();
    expect(targets.length,
      `both SCs must map to the SAME Escalation SC or this tests nothing; they map to ${targets.join(', ')}`)
      .toBe(1);
    expect(READY, `test needs ${ASSET_NAME} undiverted, it is ${info.status}`).toContain(info.status);
  });

  test('an escalate produces ONE leg at the shared target, not one per original',
    async ({ request }) => {
      test.skip(process.env.ESCALATION_ALLOW_REAL_ESCALATE !== '1',
        'Activates and escalates for real against whatever SDCC_PORTAL_PUBLIC_URL names, then rolls '
        + 'back and deactivates. Set ESCALATION_ALLOW_REAL_ESCALATE=1 to run it.');

      const baseUrl = await login(request);
      const target = info.scs[0].escalatesTo;
      const originals = info.scs.map((s) => s.scName).sort();

      try {
        const activate = await request.post(`${baseUrl}/api/incident/`, {
          data: {
            asset: { _oid: info.id },
            extended_assets_list: [],
            action: 'activate',
            type: 'build',
            topology: buildMultiScTopology(info, 2),
            userInput: { reason: 'Diversion Test', notes: 'CDDOS-3302 dedupe' },
          },
        });
        expect(activate.status(), await activate.text()).toBe(200);
        await settle(info.id);

        expect(activeDiversionScs(info.id),
          'the asset must be live on BOTH original SCs before escalating')
          .toEqual(originals);

        const enable = await request.post(
          `${baseUrl}/api/incident/escalation/enable/${info.id}`, { data: { trigger: 'manual' } });
        expect(enable.status(), await enable.text()).toBe(200);
        await settle(info.id);

        // THE assertion. Two originals mapping to one target must yield three active legs, not
        // four: the shared Escalation SC is reached once. A build that escalated per original leg
        // would produce the target twice and still pass every single-SC test we have.
        const after = activeDiversionScs(info.id);
        const targetLegs = after.filter((n) => n === target);
        expect(targetLegs.length,
          `expected exactly one leg at ${target}, got ${targetLegs.length} (legs: ${after.join(', ')})`)
          .toBe(1);
        expect(after.filter((n) => n !== target).sort(),
          'both original legs must survive the escalate')
          .toEqual(originals);

        const disable = await request.post(
          `${baseUrl}/api/incident/escalation/disable/${info.id}`, { data: { trigger: 'manual' } });
        expect(disable.status(), await disable.text()).toBe(200);
        await settle(info.id);

        expect(activeDiversionScs(info.id),
          'the rollback must remove the shared escalation leg and leave both originals')
          .toEqual(originals);
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
            userInput: { reason: 'Diversion Test Ended', notes: 'CDDOS-3302 cleanup' },
          },
        });
        // reported, not asserted -- a cleanup failure must not mask the real result above
        // eslint-disable-next-line no-console
        console.log(`cleanup deactivate -> ${deactivate.status()}, asset now ${assetStatus(info.id)}`);
      }
    });
});
