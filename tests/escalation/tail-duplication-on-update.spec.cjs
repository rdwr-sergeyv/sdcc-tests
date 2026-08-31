// Is a TAIL leg submitted twice on an ordinary Update, with no escalation anywhere?
//
// THE QUESTION, AND WHY IT IS NOT AN ESCALATION TEST
//   The tail-leg escalate of 2026-08-30 produced two complete sets of Task documents for the tail
//   SC -- distinct _ids, same devices, same sub_actions, ~90-400ms apart, from one API call. It did
//   so on escalate, rollback and deactivate, and NOT on activate. Every one of those three goes
//   through `update_incident`; activate goes through `activate_incident`.
//
//   That points away from escalation entirely. `git diff origin/dev...feature/cddos-3006` over
//   diversion.py changes exactly one line inside update_incident (`reason = {}` ->
//   `reason = dict(data.get('reason') or {})`); the head/tail machinery it would have to be --
//   `head_topologies_dict`, the `for sc_id in incident_sc_ids` synthesis at :2875, and the tail loop
//   nested inside the head loop at :2909 -- is byte-identical to dev.
//
//   So this suite asks the question with NO escalation in the picture at all: activate a head/tail
//   asset, submit a plain Update, and count. If the tail doubles here, the escalation feature is not
//   the variable and the update path is.
//
// THE CONTROL IS THE POINT
//   The same Update is run twice against the same asset and the same two SCs: once with NEW_SC
//   submitted as a TAIL (`sc_connections` naming the head) and once with both SCs as co-equal HEADS,
//   which is the shape escalation-dedupe.spec.cjs has always used. One variable. An SC's task count
//   must not depend on whether it is a head or a tail -- that invariant is what is asserted for the
//   HEAD SC, and it is what the tail is measured against.
//
//   The topology CHANGES between activate and update (2 DPs -> 1). An Update that changes nothing
//   may legitimately produce nothing, and a test that measured zero against zero would report
//   "no duplication" for the wrong reason.
//
// SAFETY
//   Activates, updates and deactivates for real behind TAIL_DUP_ALLOW_REAL=1. type=build throughout,
//   so no device is contacted. Two full cycles, cleaned up in a finally each time.
//
// Run (on the lab VM -- needs mongosh):
//   TAIL_DUP_ALLOW_REAL=1 SDCC_PORTAL_PUBLIC_URL=http://10.20.4.20:8000 \
//     npx playwright test tests/escalation/tail-duplication-on-update.spec.cjs

const { test, expect } = require('playwright/test');
const { login, waitFor } = require('../dp-isolate/dp-isolate-helpers.cjs');
const {
  multiScAssetInfo, buildMultiScTopology, assetStatus, settle,
  divertingLegs, taskCountsBySc, openIncidentId, waitUntilReady,
} = require('./escalation-multi-sc-helpers.cjs');

const ASSET_NAME = process.env.TAIL_DUP_TEST_ASSET || 'asset_9';
const READY = ['off-cloud', 'activating_request'];

test.describe.configure({ mode: 'serial', timeout: 900000 });

function withTailConnections(topology, headScId) {
  return topology.map((entry) => (entry.sc._oid === headScId
    ? entry
    : { ...entry, sc_connections: [headScId] }));
}

/** Totals per SC across every action, so a change in WHICH tasks are made cannot hide a change in
 * HOW MANY. */
function totalsBySc(counts) {
  const totals = {};
  Object.keys(counts).forEach((k) => {
    const sc = k.split('|')[0];
    totals[sc] = (totals[sc] || 0) + counts[k];
  });
  return totals;
}

test.describe('a tail leg on the ordinary update path -- no escalation involved', () => {
  let info;
  let head;
  let tail;

  test.beforeAll(async () => {
    await waitUntilReady(ASSET_NAME, READY);
    info = multiScAssetInfo(ASSET_NAME);
    expect(info.scs.length,
      `${ASSET_NAME} must divert to two SCs; it has ${info.scs.length}`).toBe(2);
    expect(READY, `test needs ${ASSET_NAME} undiverted, it is ${info.status}`).toContain(info.status);
    [head, tail] = info.scs;
  });

  /** One activate -> plain Update -> deactivate cycle. Returns the tasks the UPDATE alone created. */
  async function cycle(request, baseUrl, asTail) {
    const topology = buildMultiScTopology(info, 2);
    const activateTopology = asTail ? withTailConnections(topology, head.scId) : topology;

    const activate = await request.post(`${baseUrl}/api/incident/`, {
      data: {
        asset: { _oid: info.id },
        extended_assets_list: [],
        action: 'activate',
        type: 'build',
        topology: activateTopology,
        userInput: { reason: 'Diversion Test', notes: 'tail duplication probe' },
      },
    });
    expect(activate.status(), await activate.text()).toBe(200);
    await settle(info.id);

    // Prove the shape actually took, in both directions -- otherwise "tail" and "heads" could be
    // the same run twice and the comparison would be of noise with itself.
    const legs = divertingLegs(info.id);
    const tailLeg = legs.find((l) => l.scName === tail.scName);
    expect(tailLeg, `${tail.scName} must be diverting`).toBeTruthy();
    expect(tailLeg.connectedTo, asTail
      ? `${tail.scName} must be stored as a TAIL of ${head.scName}`
      : `${tail.scName} must be stored as a HEAD in the control run`)
      .toEqual(asTail ? [head.scId] : []);

    const since = new Date().toISOString();
    const incidentId = openIncidentId(info.id);
    // A real change, 2 DPs -> 1: an Update that alters nothing may legitimately build nothing.
    const updateTopology = buildMultiScTopology(info, 1);
    const update = await request.post(`${baseUrl}/api/incident/${incidentId}`, {
      data: {
        asset: { _oid: info.id },
        extended_assets_list: [],
        action: 'update',
        type: 'build',
        topology: asTail ? withTailConnections(updateTopology, head.scId) : updateTopology,
        userInput: { reason: 'Diversion Test', notes: 'tail duplication probe -- update' },
      },
    });
    expect(update.status(), await update.text()).toBe(200);
    await settle(info.id);

    const counts = taskCountsBySc(info.id, since);
    // eslint-disable-next-line no-console
    console.log(`[${asTail ? 'TAIL' : 'HEADS'}] tasks created by the UPDATE alone: `
      + `${JSON.stringify(counts)}`);
    return totalsBySc(counts);
  }

  async function teardown(request, baseUrl, label) {
    const deactivate = await request.post(`${baseUrl}/api/incident/`, {
      data: {
        asset: { _oid: info.id },
        extended_assets_list: [],
        action: 'deactivate',
        type: 'build',
        topology: [],
        userInput: { reason: 'Diversion Test Ended', notes: 'tail duplication probe cleanup' },
      },
    });
    // eslint-disable-next-line no-console
    console.log(`[${label}] cleanup deactivate -> ${deactivate.status()}, `
      + `asset now ${assetStatus(info.id)}`);
    await settle(info.id);
    // settle() waits out `activating`, not `deactivating` -- it was written for the escalate round
    // trip, which never tears down mid-test. The second cycle's activate came back 500 "Asset status
    // is not suitable for your action" because it fired while the asset was still deactivating, so
    // this waits for a genuinely re-activatable state instead.
    await waitFor(() => (READY.includes(assetStatus(info.id)) ? true : null), { timeoutMs: 300000 });
  }

  test('an SC gets the same number of tasks whether it is a head or a tail',
    async ({ request }) => {
      // EXPECTED TO FAIL, deliberately. Measured 2026-08-30: NEW_SC received 16 tasks from one
      // Update as a tail and 8 as a head, with the head SC steady at 7 in both runs -- exactly 2x,
      // one variable, no escalation anywhere. The assertion below states the CORRECT invariant, so
      // marking it `fail` keeps the suite honest in both directions: it stays green while the defect
      // stands, and the day update_incident stops double-submitting tails this test starts passing
      // unexpectedly and goes red, which is the signal to delete this line rather than the test.
      //
      // Do not "fix" it by relaxing the assertion.
      test.fail();
      test.skip(process.env.TAIL_DUP_ALLOW_REAL !== '1',
        'Runs two real activate/update/deactivate cycles against whatever SDCC_PORTAL_PUBLIC_URL '
        + 'names. Set TAIL_DUP_ALLOW_REAL=1 to run it.');

      const baseUrl = await login(request);
      let asTail;
      let asHeads;

      try {
        asTail = await cycle(request, baseUrl, true);
      } finally {
        await teardown(request, baseUrl, 'TAIL');
      }
      try {
        asHeads = await cycle(request, baseUrl, false);
      } finally {
        await teardown(request, baseUrl, 'HEADS');
      }

      // eslint-disable-next-line no-console
      console.log(`totals per SC -- tail run: ${JSON.stringify(asTail)}   `
        + `heads run: ${JSON.stringify(asHeads)}`);

      // The control. The head SC's role is identical in both runs, so its count must be too; if this
      // moves, the two runs differ in something other than the head/tail flag and the comparison
      // below means nothing.
      expect(asTail[head.scName], `${head.scName} is a head in both runs, so its task count must not `
        + 'change; if it does, the runs differ in more than the one variable')
        .toBe(asHeads[head.scName]);

      // The measurement. Same SC, same devices, same Update -- only its head/tail role differs.
      expect(asTail[tail.scName],
        `${tail.scName} received ${asTail[tail.scName]} task(s) as a TAIL and `
        + `${asHeads[tail.scName]} as a HEAD, from the same Update. An SC's task count must not `
        + 'depend on its head/tail role. update_incident synthesises every incident leg that is not '
        + 'already a request head INTO one (diversion.py:2875) and also walks tails inside the head '
        + 'loop (:2909), so a tail is acted on once in each role.')
        .toBe(asHeads[tail.scName]);
    });
});
