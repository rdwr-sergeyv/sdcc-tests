// API-level guards for the Escalation SC data model (CDDOS-3007). No browser involved.
//
// WHY THIS EXISTS ALONGSIDE tests/ui
//   The site picker hiding Escalation SCs is convenience. These are the rules that actually hold:
//   a direct API call has to fail too, and it has to fail as a CLIENT error with a reason an
//   operator can act on -- not a 500, and not a silent success.
//
// WHAT IT PINS
//   1. The two mapping rules, through the SC API: escalates_to must name an Escalation SC, and an
//      Escalation SC must not set it. Plus sc_type being a closed set.
//   2. I10: a customer account site may not be created on, or moved to, an Escalation SC.
//   3. sc_type and escalates_to are exposed on the SC API, which is how the UI and orchestration
//      read the mapping at all.
//
// SAFETY
//   Every write here is expected to be REFUSED, so nothing should be created or changed. Each test
//   checks that afterwards rather than trusting the status code -- a 400 with a write behind it is
//   the worst outcome and the one worth catching. The SC probes use create (not update of a real
//   SC) so a bug cannot damage lab data.
//
// Run (no docker needed, HTTP only -- works from the lab host or a laptop on VPN):
//   cd sdcc-tests
//   SDCC_PORTAL_PUBLIC_URL=http://10.20.4.20:8000 npx playwright test tests/escalation/sc-and-site-guards.spec.cjs

const { test, expect } = require('playwright/test');

const BASE = process.env.SDCC_PORTAL_PUBLIC_URL || 'http://localhost:8000';
const USER = process.env.PORTAL_USER || 'twister@example.com';
const PASSWORD = process.env.PORTAL_PASSWORD || 'd0sattack';
const PROBE_NAME = 'ZZ_ESC_GUARD_PROBE';

test.describe.configure({ mode: 'serial', timeout: 120000 });

async function login(request) {
  const res = await request.post(`${BASE}/api/auth/`, { data: { u: USER, p: PASSWORD } });
  expect(res.status(), await res.text()).toBe(200);
}

async function scs(request) {
  const res = await request.get(`${BASE}/api/sc/`);
  expect(res.status()).toBe(200);
  return (await res.json()).reply;
}

async function inventory(request) {
  const all = await scs(request);
  const escalation = all.filter((s) => s.sc_type === 'escalation');
  const standard = all.filter((s) => s.sc_type !== 'escalation');
  expect(escalation.length, 'the lab needs an Escalation SC or these tests assert nothing').toBeGreaterThan(0);
  expect(standard.length).toBeGreaterThan(0);
  return { all, escalation, standard };
}

/** A minimal but complete SC creation body -- the API rejects partial ones before any rule runs. */
function scBody(backendOid, extra) {
  return Object.assign({
    name: PROBE_NAME,
    abbreviation: 'ZZP',
    backend: { _oid: backendOid },
    management_devices: [],
    ip_networks: [],
    vip_network: null,
  }, extra);
}

async function noProbeSurvived(request) {
  const names = (await scs(request)).map((s) => s.name);
  expect(names, 'a refused create must leave no Scrubbing Center behind').not.toContain(PROBE_NAME);
}

test.describe('SC escalation mapping, through the API', () => {
  test('escalates_to must name an Escalation SC', async ({ request }) => {
    await login(request);
    const { standard } = await inventory(request);
    const target = standard.find((s) => s.name !== PROBE_NAME);

    const res = await request.post(`${BASE}/api/sc/`, {
      data: scBody(standard[0].backend._oid, { escalates_to: { _oid: target._id._oid } }),
    });
    const body = await res.text();

    // 400, not 500: pointing at the wrong SC is a client mistake, and the reply has to say so.
    expect(res.status(), body).toBe(400);
    expect(body, 'the message must name the SC that is wrong').toContain(target.name);
    expect(body, 'and say what it should have been').toMatch(/escalation sc/i);
    expect(body, 'mongoengine wrapper should not leak to an operator').not.toContain('__all__');
    await noProbeSurvived(request);
  });

  test('an Escalation SC may not escalate onwards', async ({ request }) => {
    await login(request);
    const { escalation, standard } = await inventory(request);

    const res = await request.post(`${BASE}/api/sc/`, {
      data: scBody(standard[0].backend._oid, {
        sc_type: 'escalation',
        escalates_to: { _oid: escalation[0]._id._oid },
      }),
    });
    const body = await res.text();
    expect(res.status(), body).toBe(400);
    expect(body).toMatch(/escalates_to/);
    await noProbeSurvived(request);
  });

  test('sc_type is a closed set', async ({ request }) => {
    await login(request);
    const { standard } = await inventory(request);

    const res = await request.post(`${BASE}/api/sc/`, {
      data: scBody(standard[0].backend._oid, { sc_type: 'banana' }),
    });
    const body = await res.text();
    expect(res.status(), body).toBe(400);
    expect(body, 'the reply should list what is allowed').toMatch(/standard.*escalation|escalation.*standard/);
    await noProbeSurvived(request);
  });

  test('an incomplete request reaches validation instead of crashing', async ({ request }) => {
    await login(request);
    // Omitting management_devices used to raise KeyError inside add_sc_devices, surfacing as a 500
    // before any rule ran. Pair it with a value the rules reject, so the request is refused rather
    // than accepted -- this asserts the ordering without creating anything to clean up.
    const { standard } = await inventory(request);
    const body = scBody(standard[0].backend._oid, { sc_type: 'banana' });
    delete body.management_devices;

    const res = await request.post(`${BASE}/api/sc/`, { data: body });
    const text = await res.text();
    expect(res.status(), text).toBe(400);
    expect(text, 'it must fail on the rule, not on the missing field').toMatch(/standard.*escalation|escalation.*standard/);
    await noProbeSurvived(request);
  });

  test('sc_type and escalates_to are exposed on the SC API', async ({ request }) => {
    await login(request);
    const { all, escalation } = await inventory(request);
    // Without these fields the UI cannot mark an Escalation SC and orchestration cannot follow the
    // mapping -- and every SC predating the feature must read as standard rather than undefined.
    for (const sc of all) {
      expect(['standard', 'escalation'], `${sc.name} has no usable sc_type`).toContain(sc.sc_type);
      expect(sc, `${sc.name} is missing escalates_to`).toHaveProperty('escalates_to');
    }
    const mapped = all.filter((s) => s.escalates_to);
    for (const sc of mapped) {
      const targetId = sc.escalates_to._oid || sc.escalates_to;
      expect(escalation.map((e) => e._id._oid),
        `${sc.name} maps to something that is not an Escalation SC`).toContain(targetId);
    }
  });
});

test.describe('I10 -- a customer site may not live on an Escalation SC', () => {
  let accountId;
  let escalationSc;

  test.beforeAll(async ({ request }) => {
    await login(request);
    const { escalation } = await inventory(request);
    escalationSc = escalation[0];
    const accounts = (await (await request.get(`${BASE}/api/accounts/`)).json()).reply;
    accountId = accounts.find((a) => a.name === 'account_1')?._id._oid || accounts[0]._id._oid;
  });

  test('creating one is refused, naming the SC', async ({ request }) => {
    await login(request);
    const res = await request.post(`${BASE}/api/site/${accountId}`, {
      data: {
        site_name: 'zz-esc-guard-probe',
        site_sc: escalationSc._id._oid,
        devices: [],
        site_connection_type: 'gre',
      },
    });
    const body = await res.text();
    expect(res.status(), body).toBe(400);
    expect(body).toContain(escalationSc.name);
    expect(body, 'the reason should be the missing customer GRE, not a generic refusal').toMatch(/escalation sc/i);
  });

  test('the guard runs before the other validations', async ({ request }) => {
    await login(request);
    // The account is at its site limit, which used to fire first and hide this guard entirely.
    const res = await request.post(`${BASE}/api/site/${accountId}`, {
      data: {
        site_name: 'zz-esc-guard-probe',
        site_sc: escalationSc._id._oid,
        devices: [],
        site_connection_type: 'gre',
      },
    });
    expect(await res.text(), 'a site-limit or name error must not mask the SC guard').toMatch(/escalation sc/i);
  });

  test('moving an existing site onto one is refused too', async ({ request }) => {
    await login(request);
    // The list needs the account context in the query, not just in the path -- without it the
    // handler has no accounts to scope by and fails.
    const sitesRes = await request.get(`${BASE}/api/site/${accountId}?type=account&id=${accountId}`);
    test.skip(sitesRes.status() !== 200, `site list unavailable: ${sitesRes.status()}`);
    const sites = (await sitesRes.json()).reply;
    test.skip(!sites || !sites.length, 'account has no sites to move');

    const site = sites.find((s) => (s.sc_id?._oid || s.sc_id) !== escalationSc._id._oid) || sites[0];
    const res = await request.post(`${BASE}/api/site/${accountId}/${site._id._oid}`, {
      data: {
        site_name: site.name,
        site_sc: escalationSc._id._oid,
        devices: [],
        site_connection_type: 'gre',
      },
    });
    const body = await res.text();
    expect(res.status(), body).toBe(400);
    expect(body).toMatch(/escalation sc/i);

    // and the site did not move
    const after = (await (await request.get(`${BASE}/api/site/${accountId}?type=account&id=${accountId}`)).json()).reply;
    const moved = after.find((s) => s._id._oid === site._id._oid);
    expect(moved.sc_id?._oid || moved.sc_id,
      'a refused move must leave the site where it was').not.toBe(escalationSc._id._oid);
  });
});
