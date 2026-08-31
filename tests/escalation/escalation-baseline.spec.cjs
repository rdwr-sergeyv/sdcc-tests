// The BASELINE escalation: one asset, one SC, one Escalation SC. Does it announce?
//
// WHY THIS EXISTS
//   Everything else in this folder tests a variation -- two SCs, a tail, a guard, a refusal. The
//   plainest case had no suite of its own, and the plainest case is the one that has to work.
//
//   It was written to answer a review comment on the escalation PR: that `_create_tasks` "is not
//   handling community_action tasks", i.e. that the escalation community templates exist but nothing
//   creates tasks against them. That is a claim about the simplest path, so this asserts the simplest
//   path end to end, with no additional SC and no second site anywhere near it.
//
// WHAT IT ASSERTS, AND WHY EACH ONE
//   * ONE leg before, TWO after, ONE again after rollback -- the escalate/rollback round trip.
//   * `add_community` tasks exist on the ORIGINAL SC's wired access routers, and CARRY METRICS.
//     Presence alone is not enough: the community statements are rendered one per interface-derived
//     metric, so a task with `metrics: []` reports success and writes nothing. That exact shape was
//     measured at NEW_SC on 2026-08-30 (3 rendered bytes against 561) and it passed every
//     presence-only assertion anyone had written. expectDemoted checks both halves.
//   * ZERO community tasks at the Escalation SC. It is where traffic goes, not an announcer that
//     stops, and `escalating_sc_ids` deliberately returns only the regular SCs.
//   * `remove_community` on rollback, same standard.
//
// THE CHAIN THIS COVERS, so a failure can be placed without re-deriving it
//   escalate_incident sets data['reason'] = {escalation_add: [regular sc ids]} (E-31)
//     -> _parse_action_args forwards it as action_arguments['reason'] (diversion.py:475)
//       -> execute_command_update emits ADD_COMMUNITY for each sc_id in that list
//          (execution_tree_builder.py:1661)
//         -> _create_tasks resolves conf['templates']['router-out'][action] (:385)
//   Any break in it shows up here as "no task" or "task with no metrics", and the two are different
//   faults: the first is the reason/marker chain, the second is DP selection feeding the metrics.
//
// SAFETY
//   Escalates for real behind ESCALATION_ALLOW_REAL_ESCALATE=1, cleans up in a finally. type=build,
//   so no device is contacted.
//
// Run (on the lab VM -- needs mongosh):
//   ESCALATION_ALLOW_REAL_ESCALATE=1 SDCC_PORTAL_PUBLIC_URL=http://10.20.4.20:8000 \
//     npx playwright test tests/escalation/escalation-baseline.spec.cjs

const { test, expect } = require('playwright/test');
const { login } = require('../dp-isolate/dp-isolate-helpers.cjs');
const {
  multiScAssetInfo, buildMultiScTopology, assetStatus, settle,
  divertingLegs, announcementTasks, expectDemoted, waitUntilReady,
} = require('./escalation-multi-sc-helpers.cjs');

// Test12345, not asset_3 `[moved 2026-08-31]`. escalation-endpoints.spec.cjs asserts asset_3 is
// undiverted, and this suite's cleanup leaves it 'deactivating' for a few seconds -- so the two
// collided in a folder run and endpoints failed on a fixture, not a behaviour.
//
// The replacement has to be SHAPE-IDENTICAL or this stops being the baseline case: account_1,
// account zone `default`, one site, on NEW-LAB-2, no additional SC. Measured before choosing --
// asset_3_1 looked free but its account (account_3) sits in `attack_zone`, whose fallback closure is
// itself, so it would have selected different DPs and quietly changed what this asserts.
const ASSET_NAME = process.env.BASELINE_TEST_ASSET || 'Test12345';
const READY = ['off-cloud', 'activating_request'];

test.describe.configure({ mode: 'serial', timeout: 600000 });

test.describe('the baseline escalate -- one SC, one Escalation SC', () => {
  let info;
  let original;
  let target;

  test.beforeAll(async () => {
    // Wait out a neighbouring suite's teardown rather than failing on it -- a cleanup deactivate
    // returns 200 while the asset is still `deactivating`.
    await waitUntilReady(ASSET_NAME, READY);
    info = multiScAssetInfo(ASSET_NAME);
    // Exactly one: an additional SC would make this a different scenario and quietly move the
    // question being asked.
    expect(info.scs.length,
      `${ASSET_NAME} must divert to exactly ONE SC for this to be the baseline case; it has `
      + `${info.scs.length}`).toBe(1);
    [original] = info.scs;
    target = original.escalatesTo;
    expect(target, `${original.scName} does not map to an Escalation SC`).toBeTruthy();
    expect(READY, `test needs ${ASSET_NAME} undiverted, it is ${info.status}`).toContain(info.status);
  });

  test('escalating announces: the original SC gets a community task that renders',
    async ({ request }) => {
      test.skip(process.env.ESCALATION_ALLOW_REAL_ESCALATE !== '1',
        'Activates and escalates for real against whatever SDCC_PORTAL_PUBLIC_URL names, then rolls '
        + 'back and deactivates. Set ESCALATION_ALLOW_REAL_ESCALATE=1 to run it.');

      const baseUrl = await login(request);
      const since = new Date().toISOString();

      try {
        const activate = await request.post(`${baseUrl}/api/incident/`, {
          data: {
            asset: { _oid: info.id },
            extended_assets_list: [],
            action: 'activate',
            type: 'build',
            topology: buildMultiScTopology(info, 2),
            userInput: { reason: 'Diversion Test', notes: 'baseline escalate' },
          },
        });
        expect(activate.status(), await activate.text()).toBe(200);
        await settle(info.id);

        const before = divertingLegs(info.id);
        // eslint-disable-next-line no-console
        console.log(`legs after activate: ${JSON.stringify(before)}`);
        expect(before.map((l) => l.scName), 'exactly one leg, at the original SC')
          .toEqual([original.scName]);

        const enable = await request.post(
          `${baseUrl}/api/incident/escalation/enable/${info.id}`, { data: { trigger: 'manual' } });
        expect(enable.status(), await enable.text()).toBe(200);
        await settle(info.id);

        const after = divertingLegs(info.id);
        // eslint-disable-next-line no-console
        console.log(`legs after escalate: ${JSON.stringify(after)}`);
        expect(after.map((l) => l.scName).sort(), 'the original leg plus one at the Escalation SC')
          .toEqual([original.scName, target].sort());

        const announced = announcementTasks(info.id, since);
        // eslint-disable-next-line no-console
        console.log(`announcement tasks after escalate: ${JSON.stringify(announced, null, 1)}`);
        expectDemoted(announced, original.scName, 'add_community');
        expect(announced[`${target}|add_community`],
          `the Escalation SC ${target} must get NO community task`).toBeUndefined();

        const disable = await request.post(
          `${baseUrl}/api/incident/escalation/disable/${info.id}`, { data: { trigger: 'manual' } });
        expect(disable.status(), await disable.text()).toBe(200);
        await settle(info.id);

        expect(divertingLegs(info.id).map((l) => l.scName),
          'the rollback leaves the original leg alone').toEqual([original.scName]);

        const withdrawn = announcementTasks(info.id, since);
        // eslint-disable-next-line no-console
        console.log(`announcement tasks after rollback: ${JSON.stringify(withdrawn, null, 1)}`);
        expectDemoted(withdrawn, original.scName, 'remove_community');
      } finally {
        const deactivate = await request.post(`${baseUrl}/api/incident/`, {
          data: {
            asset: { _oid: info.id },
            extended_assets_list: [],
            action: 'deactivate',
            type: 'build',
            topology: [],
            userInput: { reason: 'Diversion Test Ended', notes: 'baseline cleanup' },
          },
        });
        // eslint-disable-next-line no-console
        console.log(`cleanup deactivate -> ${deactivate.status()}, asset now ${assetStatus(info.id)}`);
      }
    });
});
