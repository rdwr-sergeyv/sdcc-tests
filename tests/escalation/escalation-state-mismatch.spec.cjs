// The attack service's zone flags outlive legacy's state (fix/zone-state-authority).
//
// WHAT IT DEMONSTRATES
//   The attack service decides each transition from its own `attack.Settings` flags and skips the
//   CDDOS call when they already match the target. Those flags are its memory of a past call, not
//   the state of the system: legacy can change underneath them and notifies nobody. A deactivate is
//   explicitly permitted while escalated (CDDOS-3015), and after one the service still believes the
//   asset is escalated -- so the next escalate answers 200 OK having called nothing.
//
//   The invariant this pins is deliberately weaker than "must return 500", so that it holds for any
//   reasonable fix:
//
//       a 200 from the attack service must mean the action actually happened.
//
//   UNFIXED build: second escalate -> 200, no leg at the Escalation SC  -> FAILS here.
//   FIXED build (fix/zone-state-authority): the call reaches legacy, legacy answers "no active
//   incident; not in escalated state", the service throws -> non-2xx -> PASSES here.
//
//   This is NOT an escalation defect. Isolation has behaved this way for as long as it has existed
//   and escalation inherited it through the same helper; the Unified UI conceals it by hiding the
//   isolate toggle for off-cloud assets. Background:
//   cddos-legacy `docs/kb/business-logic/zone-state-ownership.md`.
//
// SAFETY
//   Escalates for real behind ESCALATION_ALLOW_REAL_ESCALATE=1. It clears the asset's attack-side
//   flags before AND after, so it is repeatable even on the unfixed build -- where it necessarily
//   leaves the flag set, that being the whole point.
//
//   ATTACK_BASE_URL and SDCC_PORTAL_PUBLIC_URL must name the SAME deployment; the service calls the
//   portal at its own compiled-in CDDOS_ADDRESS/CDDOS_PORT (8000 in the lab).
//
// Run (on the lab VM -- needs mongosh):
//   ESCALATION_ALLOW_REAL_ESCALATE=1 SDCC_PORTAL_PUBLIC_URL=http://10.20.4.20:8000 \
//     npx playwright test tests/escalation/escalation-state-mismatch.spec.cjs

const { execFileSync } = require('child_process');
const { test, expect } = require('playwright/test');
const { login, mongoJson, waitFor } = require('../dp-isolate/dp-isolate-helpers.cjs');

const ATTACK = process.env.ATTACK_BASE_URL || 'https://10.20.4.20:8470';
// asset_7: it must be an asset the service can build a Setting for -- asset_8 fails with
// "Cannot create default Setting: accountId not found" -- and it must NOT be the one
// escalation-attack-service.spec.cjs uses (asset_9), or that spec leaves it 'deactivating' and this
// one's beforeAll rejects it. Two specs sharing an asset in the same serial run collide.
const ASSET_NAME = process.env.MISMATCH_TEST_ASSET || 'asset_7';
const ATTACK_DB_HOST = process.env.ATTACK_DB_HOST || '10.20.4.20';
const ATTACK_DB_PORT = process.env.ATTACK_DB_PORT || '27017';
const READY = ['off-cloud', 'activating_request'];

test.use({ ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial', timeout: 900000 });

/** The attack service's own store -- a DIFFERENT server from legacy's (27017 vs 27018). */
function attackDbEval(script) {
  return execFileSync('docker', [
    'exec', 'legacy-portal-mongo-1', 'mongosh',
    '--host', ATTACK_DB_HOST, '--port', ATTACK_DB_PORT, 'attack', '--quiet', '--eval', script,
  ], { encoding: 'utf8' }).trim();
}

/** `assetId` is stored as an ObjectId here; a string lookup silently finds nothing. */
function zoneFlags(assetId) {
  const out = attackDbEval(
    `const s = db.Settings.findOne({assetId: ObjectId("${assetId}")});`
    + ' print(s ? JSON.stringify({isIsolated: !!s.isIsolated, isEscalated: !!s.isEscalated}) : "null");');
  return out === 'null' ? null : JSON.parse(out);
}

function clearZoneFlags(assetId) {
  attackDbEval(
    `db.Settings.updateOne({assetId: ObjectId("${assetId}")},`
    + ' {$set: {isEscalated: false, isIsolated: false}});');
}

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

function assetStatus(assetId) {
  return mongoJson(`String((db.Assets.findOne({ _id: ObjectId('${assetId}') }) || {}).status)`);
}

async function waitForLegs(assetId, pred, what) {
  await waitFor(() => (pred(activeDiversionScs(assetId)) ? true : null),
    { timeoutMs: 300000, description: what });
}

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

const escalateVia = (request, id, on) =>
  request.post(`${ATTACK}/sdcc/attack/core/_escalate/${id}?escalate=${on}`, { data: {} });

test.describe('zone state ownership -- the service must not report a success it did not perform', () => {
  let info;

  test.beforeAll(() => {
    info = assetInfo(ASSET_NAME);
    expect(info.escalatesTo, `${info.scName} maps to no Escalation SC`).toBeTruthy();
    expect(READY, `test needs ${ASSET_NAME} undiverted, it is ${info.status}`).toContain(info.status);
    clearZoneFlags(info.id);
  });

  test('a deactivate in legacy must not leave the service reporting phantom escalations',
    async ({ request }) => {
      test.skip(process.env.ESCALATION_ALLOW_REAL_ESCALATE !== '1',
        'Activates, escalates and deactivates for real. ATTACK_BASE_URL and SDCC_PORTAL_PUBLIC_URL '
        + 'must name the same deployment. Set ESCALATION_ALLOW_REAL_ESCALATE=1 to run it.');

      const baseUrl = await login(request);
      const target = info.escalatesTo;

      try {
        // --- 1. divert and escalate, so the service records isEscalated = true
        const activate = await request.post(`${baseUrl}/api/incident/`, {
          data: {
            asset: { _oid: info.id },
            extended_assets_list: [],
            action: 'activate',
            type: 'build',
            topology: buildTopology(info, 2),
            userInput: { reason: 'Diversion Test', notes: 'zone state mismatch' },
          },
        });
        expect(activate.status(), await activate.text()).toBe(200);
        await settle(info.id);

        const first = await escalateVia(request, info.id, true);
        expect(first.status(), await first.text()).toBe(200);
        await waitForLegs(info.id, (legs) => legs.includes(target), `a leg at ${target}`);
        // the leg appearing is not the escalate finishing -- the incident can still be queued, and
        // the deactivate below is refused with "The previous action is in queue" if it is.
        await settle(info.id);
        expect(zoneFlags(info.id)).toMatchObject({ isEscalated: true });

        // --- 2. deactivate IN LEGACY. Permitted while escalated (CDDOS-3015), and the attack
        // service is never told: legacy makes no outbound call to any service.
        const deactivate = await request.post(`${baseUrl}/api/incident/`, {
          data: {
            asset: { _oid: info.id },
            extended_assets_list: [],
            action: 'deactivate',
            type: 'build',
            topology: [],
            userInput: { reason: 'Diversion Test Ended', notes: 'zone state mismatch' },
          },
        });
        expect(deactivate.status(), await deactivate.text()).toBe(200);
        await waitFor(() => (assetStatus(info.id) === 'off-cloud' ? true : null),
          { timeoutMs: 300000, description: 'the asset to go off-cloud' });
        expect(activeDiversionScs(info.id), 'the deactivate should leave no active leg').toEqual([]);

        // --- 3. THE ASSERTION. Ask the service to escalate again. It does not matter whether it
        // refuses or accepts -- what matters is that it does not claim a success it never performed.
        const second = await escalateVia(request, info.id, true);
        const body = await second.text();

        if (second.status() === 200) {
          await waitForLegs(info.id, (legs) => legs.includes(target),
            `a leg at ${target} after a 200 from the second escalate`)
            .catch(() => {});
          expect(activeDiversionScs(info.id),
            'the service answered 200 to the second escalate but produced no leg -- it skipped on a '
            + 'stale isEscalated flag without calling legacy at all')
            .toContain(target);
        } else {
          expect(second.status(),
            `expected either a real escalation or an honest refusal, got ${second.status()}: ${body}`)
            .toBeGreaterThanOrEqual(400);
          expect(activeDiversionScs(info.id), 'a refused escalate must change nothing').toEqual([]);
        }
      } finally {
        if (assetStatus(info.id) !== 'off-cloud') {
          await request.post(`${baseUrl}/api/incident/`, {
            data: {
              asset: { _oid: info.id },
              extended_assets_list: [],
              action: 'deactivate',
              type: 'build',
              topology: [],
              userInput: { reason: 'Diversion Test Ended', notes: 'zone state mismatch cleanup' },
            },
          });
        }
        // Always reset the attack-side flags. On an unfixed build this test necessarily leaves
        // isEscalated set -- that IS the defect -- and without this the next run would skip.
        clearZoneFlags(info.id);
        // eslint-disable-next-line no-console
        console.log(`cleanup: asset ${assetStatus(info.id)}, flags ${JSON.stringify(zoneFlags(info.id))}`);
      }
    });
});
