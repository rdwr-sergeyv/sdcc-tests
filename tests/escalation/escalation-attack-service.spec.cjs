// End to end from the ATTACK SERVICE, not from the legacy portal (CDDOS-3326).
//
// WHERE THIS SITS
//   The Unified UI and real attack traffic are out of scope -- they belong to CDDOS-3012 and to the
//   attack-trigger setup. So the widest range testable from here starts at the attack service's own
//   REST endpoints, invoked by script, and runs through to legacy state:
//
//     POST https://<attack>:8470/sdcc/attack/core/_escalate/{assetId}?escalate=true|false
//     POST https://<attack>:8470/sdcc/attack/core/_isolate/{assetId}?isolate=true|false
//         -> ZoneIsolationCoreAPI -> ZoneIsolationCoreService -> AssetCDDOSConnector
//         -> POST {CDDOS_ADDRESS}:{CDDOS_PORT}/api/incident/{escalation|isolation}/{enable|disable}/{id}
//         -> tasks -> backends -> rendered configuration
//
//   The connector authenticates itself and sends {"trigger":"manual"} (the API hard-codes
//   isManual=true). `returnFromIsolation` alone sends {} with no trigger.
//
//   NOTE the service is HTTPS with a self-signed certificate, and takes no authentication of its own.
//   NOTE it creates a default `Setting` document for the asset if none exists -- a side effect of
//   calling it at all, not of the action succeeding.
//
// WHAT IS WORTH PINNING HERE, AND WHY
//   `ZoneIsolationCoreAPI` returns ok() unless an exception propagates, and it IGNORES the
//   connector's Pair<Boolean,String>. `ZoneIsolationCoreService` is what decides: it throws when the
//   flags were not updated -- unless the operation was recorded as a SKIP, in which case it returns
//   normally and the caller sees 200.
//
//   That is the CDDOS-2868 rule exactly ("only an actual isolate or rollback is success; any skip is
//   a failure"), evaluated one layer up. A legacy guard that refuses must not reach the caller as
//   200 OK. These tests assert the refusal is visible.
//
// SAFETY
//   Escalates for real behind ESCALATION_ALLOW_REAL_ESCALATE=1, against whatever ATTACK_BASE_URL and
//   SDCC_PORTAL_PUBLIC_URL name -- and those two must be the SAME deployment: the attack service
//   calls the portal at its own compiled-in CDDOS_ADDRESS/CDDOS_PORT (8000 in the lab), so pointing
//   the portal variable at 8001 while the service talks to 8000 tests nothing and corrupts both
//   readings. Cleanup deactivates through the portal in a finally.
//
// Run (on the lab VM -- needs mongosh):
//   ESCALATION_ALLOW_REAL_ESCALATE=1 SDCC_PORTAL_PUBLIC_URL=http://10.20.4.20:8000 \
//     npx playwright test tests/escalation/escalation-attack-service.spec.cjs

const { test, expect } = require('playwright/test');
const { login, mongoJson, waitFor } = require('../dp-isolate/dp-isolate-helpers.cjs');

const ATTACK = process.env.ATTACK_BASE_URL || 'https://10.20.4.20:8470';
const ASSET_NAME = process.env.ATTACK_TEST_ASSET || 'asset_7';
const READY = ['off-cloud', 'activating_request'];

// self-signed certificate on the attack service
test.use({ ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial', timeout: 900000 });

function assetInfo(name) {
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
    const sc = db.ScrubbingCenters.findOne({ _id: site.sc_id });
    const esc = sc.escalates_to ? db.ScrubbingCenters.findOne({ _id: sc.escalates_to }) : null;
    return {
      id: String(a._id),
      status: a.status,
      address: String(a.address),
      mask: Number(a.mask) || 24,
      zoneId: String(account.zone),
      scId: String(sc._id),
      scName: sc.name,
      escalatesTo: esc ? esc.name : null,
      devices: (sc.management_devices || [])
        .filter((d) => ['radware-defensepro', 'router-out', 'router-in'].includes(d.role))
        .map((d) => ({
          id: String(d.unique_id),
          role: d.role,
          inZone: d.role !== 'radware-defensepro' || closure.includes(String(d.zone)),
          routerOuts: [...new Set((d.interfaces || []).map((i) => String(i.router_out)))],
          routerIns: [...new Set((d.interfaces || []).map((i) => String(i.router_in)))],
        })),
    };
  })()`);
}

/** Routers picked by following the DPs' cabling -- see escalation-dedupe.spec.cjs for why. */
function buildTopology(info, dpCount) {
  let picked = 0;
  const chosen = [];
  const devices = info.devices.map((d) => {
    if (d.role === 'radware-defensepro') {
      const selected = d.inZone && picked < dpCount;
      if (selected) { picked += 1; chosen.push(d); }
      return {
        _oid: d.id, type: 'dp', selected, implicit: false,
        'dp-subnet': info.address, 'dp-mask': info.mask,
      };
    }
    return { _oid: d.id, type: d.role, selected: false, implicit: false };
  });
  const wiredOut = new Set(chosen.flatMap((d) => d.routerOuts));
  const wiredIn = new Set(chosen.flatMap((d) => d.routerIns));
  devices.forEach((e) => {
    if (e.type === 'router-out') e.selected = wiredOut.has(e._oid);
    if (e.type === 'router-in') e.selected = wiredIn.has(e._oid);
  });
  return [{
    sc: { _oid: info.scId }, line_type: 'DDOS', sc_prepend: 0, zone: { _oid: info.zoneId }, devices,
  }];
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

/** Wait for the action to LAND -- see escalation-dedupe.spec.cjs for why in_queue alone is not enough. */
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

/** Wait until the active-leg set satisfies `pred`.
 *
 * A POSITIVE condition, deliberately. `settle()` waits for signals to go quiet, and after an
 * escalate they are already quiet at the moment the call returns -- the incident is `activated` and
 * the asset `pending` before the escalate's own tasks have produced anything. Waiting for quiet
 * therefore returns instantly and the assertion reads the state from BEFORE the action. Measured
 * 2026-08-29: the service logged `moveToEscalation succeeded ... {"reply":"OK"}` while the test read
 * only the original leg.
 */
async function waitForLegs(assetId, pred, what) {
  await waitFor(() => (pred(activeDiversionScs(assetId)) ? true : null),
    { timeoutMs: 300000, description: what });
}

const escalateVia = (request, id, on) =>
  request.post(`${ATTACK}/sdcc/attack/core/_escalate/${id}?escalate=${on}`, { data: {} });
const isolateVia = (request, id, on) =>
  request.post(`${ATTACK}/sdcc/attack/core/_isolate/${id}?isolate=${on}`, { data: {} });

test.describe('CDDOS-3326 -- escalation driven through the attack service', () => {
  let info;

  test.beforeAll(() => {
    info = assetInfo(ASSET_NAME);
    expect(info.escalatesTo, `${info.scName} maps to no Escalation SC; nothing to escalate to`)
      .toBeTruthy();
    expect(READY, `test needs ${ASSET_NAME} undiverted, it is ${info.status}`).toContain(info.status);
  });

  test('the service reaches legacy at all', async ({ request }) => {
    // A non-existent asset must produce a real business error from the service, not a transport or
    // routing failure. This is the cheap check that the URL, the TLS and the deployment are right
    // before anything is activated.
    const res = await escalateVia(request, '000000000000000000000000', true);
    const body = await res.text();
    expect(res.status(), body).toBe(500);
    expect(body).toMatch(/accountId not found/i);
  });

  test('escalate, refuse the isolation actions, roll back -- all through the service',
    async ({ request }) => {
      test.skip(process.env.ESCALATION_ALLOW_REAL_ESCALATE !== '1',
        'Activates and escalates for real. ATTACK_BASE_URL and SDCC_PORTAL_PUBLIC_URL must name the '
        + 'same deployment -- the service calls the portal at its own CDDOS_ADDRESS/CDDOS_PORT. Set '
        + 'ESCALATION_ALLOW_REAL_ESCALATE=1 to run it.');

      const baseUrl = await login(request);
      const target = info.escalatesTo;

      try {
        const activate = await request.post(`${baseUrl}/api/incident/`, {
          data: {
            asset: { _oid: info.id },
            extended_assets_list: [],
            action: 'activate',
            type: 'build',
            topology: buildTopology(info, 2),
            userInput: { reason: 'Diversion Test', notes: 'CDDOS-3326 attack-service chain' },
          },
        });
        expect(activate.status(), await activate.text()).toBe(200);
        await settle(info.id);
        expect(activeDiversionScs(info.id)).toEqual([info.scName]);

        // --- escalate THROUGH THE ATTACK SERVICE
        const esc = await escalateVia(request, info.id, true);
        expect(esc.status(), await esc.text()).toBe(200);
        await waitForLegs(info.id, (legs) => legs.includes(target),
          `a leg to appear at ${target} after the escalate`);
        await settle(info.id);

        const escalated = activeDiversionScs(info.id);
        expect(escalated).toContain(target);
        expect(escalated).toContain(info.scName);

        // --- CDDOS-3325 seen from one layer up: ISOLATE while escalated.
        //
        // Only this direction can be tested from here. The service short-circuits on its OWN
        // Setting flags before calling legacy -- measured 2026-08-29:
        //     "returnFromIsolation skipped for assetId ...: asset is not currently isolated"
        // -- and answers 200 without a call. So a de-isolate on a NOT-isolated asset never reaches
        // legacy's guard, and asserting a refusal here would be asserting against a local skip.
        // The de-isolate guard needs an asset that is isolated AND escalated; reaching that state
        // requires isolating first, which is a different ordering and a separate test.
        //
        // Isolate, by contrast, does reach legacy: the asset is not isolated, so nothing
        // short-circuits, and legacy's stack guard is what must refuse it.
        const blocked = await isolateVia(request, info.id, true);
        const blockedBody = await blocked.text();
        expect(blocked.status(),
          `isolate while escalated must not report success -- got ${blocked.status()} ${blockedBody}`)
          .toBe(500);
        expect(blockedBody, "the refusal should carry legacy's reason").toMatch(/escalat/i);

        expect(activeDiversionScs(info.id),
          'a refused isolation action must change nothing')
          .toEqual(escalated);

        // --- roll back THROUGH THE ATTACK SERVICE
        const roll = await escalateVia(request, info.id, false);
        expect(roll.status(), await roll.text()).toBe(200);
        await waitForLegs(info.id, (legs) => !legs.includes(target),
          `the ${target} leg to go away after the rollback`);
        await settle(info.id);

        expect(activeDiversionScs(info.id),
          `the rollback returned 200 but left a leg at ${target}`)
          .toEqual([info.scName]);
      } finally {
        const de = await request.post(`${baseUrl}/api/incident/`, {
          data: {
            asset: { _oid: info.id },
            extended_assets_list: [],
            action: 'deactivate',
            type: 'build',
            topology: [],
            userInput: { reason: 'Diversion Test Ended', notes: 'CDDOS-3326 cleanup' },
          },
        });
        // eslint-disable-next-line no-console
        console.log(`cleanup deactivate -> ${de.status()}`);
      }
    });
});
