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
const { login, mongoJson, waitFor } = require('../dp-isolate/dp-isolate-helpers.cjs');

const ASSET_NAME = process.env.DEDUPE_TEST_ASSET || 'asset_5';
const READY = ['off-cloud', 'activating_request'];

test.describe.configure({ mode: 'serial', timeout: 600000 });

/** The asset plus EVERY SC it diverts to -- its site's SC and each additional SC. */
function multiScAssetInfo(name) {
  return mongoJson(`(() => {
    const a = db.Assets.findOne({ name: '${name}', type: 'network' });
    if (!a) throw new Error('asset not found: ${name}');
    const sd = (a.asset_site_data || [])[0];
    const site = db.AccountSites.findOne({ _id: sd.account_site });
    const account = db.Accounts.findOne({ _id: a.account });

    const zones = {};
    db.DPZones.find({}).forEach((z) => { zones[String(z._id)] = z; });
    const closure = [];
    let cur = zones[String(account.zone)];
    while (cur) { closure.push(String(cur._id)); cur = cur.fail_over ? zones[String(cur.fail_over)] : null; }

    const scIds = [site.sc_id].concat((sd.asset_additional_site || []).map((x) => x.sc_id));
    const scs = scIds.map((id) => {
      const sc = db.ScrubbingCenters.findOne({ _id: id });
      const esc = sc.escalates_to ? db.ScrubbingCenters.findOne({ _id: sc.escalates_to }) : null;
      return {
        scId: String(sc._id),
        scName: sc.name,
        escalatesTo: esc ? esc.name : null,
        devices: (sc.management_devices || [])
          .filter((d) => ['radware-defensepro', 'router-out', 'router-in'].includes(d.role))
          .map((d) => ({
            id: String(d.unique_id),
            role: d.role,
            inZone: d.role !== 'radware-defensepro' || closure.includes(String(d.zone)),
            // which routers this DP is actually cabled to. A DP entry pairs an edge router with an
            // access router, and the activate validator refuses a topology that selects an AR the
            // DP has no interface toward: "One of the interfaces (access or edge router) is
            // missing for DP: <name>".
            routerOuts: [...new Set((d.interfaces || []).map((i) => String(i.router_out)))],
            routerIns: [...new Set((d.interfaces || []).map((i) => String(i.router_in)))],
          })),
      };
    });

    return {
      id: String(a._id),
      status: a.status,
      address: String(a.address),
      mask: Number(a.mask) || 24,
      zoneId: String(account.zone),
      scs,
    };
  })()`);
}

/** One topology entry per SC the asset diverts to.
 *
 * Routers are selected by FOLLOWING THE CABLING of the DPs we picked, not by document order. An SC
 * can carry a router-out that no DP is wired to -- NEW_SC has one, `ROut1`, left over from whatever
 * it was originally reserved for -- and selecting it makes the activate fail validation with "One
 * of the interfaces (access or edge router) is missing for DP". Ordering happened to hide this on
 * NEW-LAB-2, where the first router-out is a real AR.
 */
function buildMultiScTopology(info, dpCount) {
  return info.scs.map((sc) => {
    let picked = 0;
    const chosenDps = [];
    const devices = sc.devices.map((d) => {
      if (d.role === 'radware-defensepro') {
        const selected = d.inZone && picked < dpCount;
        if (selected) { picked += 1; chosenDps.push(d); }
        return {
          _oid: d.id, type: 'dp', selected, implicit: false,
          'dp-subnet': info.address, 'dp-mask': info.mask,
        };
      }
      return { _oid: d.id, type: d.role, selected: false, implicit: false };
    });

    const wiredOut = new Set(chosenDps.flatMap((d) => d.routerOuts));
    const wiredIn = new Set(chosenDps.flatMap((d) => d.routerIns));
    devices.forEach((entry) => {
      if (entry.type === 'router-out') entry.selected = wiredOut.has(entry._oid);
      if (entry.type === 'router-in') entry.selected = wiredIn.has(entry._oid);
    });

    if (![...wiredOut].length) {
      throw new Error(`${sc.scName}: the DPs picked are wired to no access router`);
    }
    return { sc: { _oid: sc.scId }, line_type: 'DDOS', sc_prepend: 0, zone: { _oid: info.zoneId }, devices };
  });
}

function activeDiversionScs(assetId) {
  return mongoJson(`(() => {
    const i = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    if (!i) return [];
    return (i.diversion || [])
      .filter((d) => !(d.state || {}).deactivated)
      .map((d) => (db.ScrubbingCenters.findOne({ _id: d.sc_id }) || {}).name)
      .sort();
  })()`);
}

function assetStatus(assetId) {
  return mongoJson(`String((db.Assets.findOne({ _id: ObjectId('${assetId}') }) || {}).status)`);
}

/** Wait until the action has actually LANDED, not merely left the queue.
 *
 * Two things had to be learnt the hard way here, both on 2026-08-26:
 *
 *  1. Task documents carry no incident or asset reference at all -- their fields are _id, command,
 *     createdAt, progress, status, type, modifiedAt, dependencies, startedAt, endedAt, message. A
 *     first version counted `db.Tasks` by `incident_id`, matched nothing, declared "idle" the
 *     instant the activate returned and fired the escalate mid-flight. The API rightly refused it
 *     (`ValueError("Incident status doesn't match your action.")`, 500) and left the incident
 *     wedged at `created`.
 *  2. `in_queue` alone is still too early. It clears well before the incident reaches `activated`,
 *     so a deactivate sent on that signal arrives while the asset is `activating` and is refused
 *     with "Asset status is not suitable for your action". Measured on four assets: each looked
 *     stuck at `activating`/`created` and each reached `pending`/`activated` on its own afterwards.
 *
 * So wait for the incident to leave `created` and the asset to leave `activating` as well. `pending`
 * is a normal diverted state, not a transitional one.
 */
async function settle(assetId) {
  await waitFor(() => (mongoJson(`(() => {
    const inc = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    if (!inc) return true;
    if (inc.in_queue === true) return false;
    if (String(inc.status) === 'created') return false;
    const a = db.Assets.findOne({ _id: ObjectId('${assetId}') }, { status: 1 });
    return String(a.status) !== 'activating';
  })()`) ? true : null), { timeoutMs: 300000 });
}

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
