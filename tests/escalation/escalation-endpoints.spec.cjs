// Contract test for the legacy escalation endpoints (CDDOS-3006, design section 7b).
//
//   POST /api/incident/escalation/enable/<asset_id>    body {"trigger": "manual"|"auto"}
//   POST /api/incident/escalation/disable/<asset_id>   body {"trigger": "manual"|"auto"}
//
// WHY THIS EXISTS
//   Enable submits the real action as of CDDOS-3009; disable remains 501 until CDDOS-3010. The
//   guards, the status codes and the shape of a refusal are what integration is written against,
//   so they are pinned here.
//
// SAFETY -- WHY THE SUCCESS CASE IS OPT-IN
//   A successful escalate CANNOT BE UNDONE YET. Rollback is CDDOS-3010 (501) and deactivating an
//   escalated diversion is CDDOS-3015, so an escalate run here would leave the lab holding a
//   diversion at the Escalation SC that only a hand-written Mongo edit can clear. That is not a
//   state an automated suite may create by default, so it is behind
//   ESCALATION_ALLOW_REAL_ESCALATE=1. Everything up to the action runs unconditionally.
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
        // the trigger. Pinned so nobody "fixes" it into a 400 without deciding to diverge, and so
        // the day CDDOS-3010 starts reading the trigger for the audit entry, this test fails and
        // makes that a decision rather than an accident.
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

  test('every guard passes on an on-cloud asset, and the action is submitted',
    async ({ request }) => {
      test.skip(process.env.ESCALATION_ALLOW_REAL_ESCALATE !== '1',
        'A successful escalate cannot be undone yet: rollback is CDDOS-3010 and deactivating an '
        + 'escalated diversion is CDDOS-3015. Set ESCALATION_ALLOW_REAL_ESCALATE=1 to run it and '
        + 'be ready to clear the Escalation SC leg by hand.');
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
        for (const which of ['enable', 'disable']) {
          const res = await escalate(request, baseUrl, which, info.id, { trigger: 'manual' });
          const body = await res.text();
          if (which === 'enable') {
            // Success carries NO detail about SCs, sites, diversions or incidents [decided
            // 2026-08-16], and it means the tasks were SUBMITTED -- the call returns before they
            // run, exactly as isolate does.
            expect(res.status(), body).toBe(200);
            const reply = JSON.parse(body);
            expect(reply).toMatchObject({ reply: 'OK' });
            expect(reply.simulated, 'the integration stub is gone; a 200 is now a real submission')
              .toBeUndefined();
          } else {
            // Rollback remains intentionally unavailable until CDDOS-3010.
            expect(res.status(), body).toBe(501);
            expect(body, 'the 501 must say what is missing, not just fail').toMatch(/rollback is pending/i);
          }
        }
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
