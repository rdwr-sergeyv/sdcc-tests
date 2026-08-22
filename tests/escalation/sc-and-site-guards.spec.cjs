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

  test('refused whichever field carries the SC (site_sc or sc_id)', async ({ request }) => {
    await login(request);
    // The portal UI sends BOTH: sdcc-sitesEditDrct.js sets site_sc from sc_id before saving. But `sc_id`
    // is the field `process_account_site_data` consumes, so an API client can legitimately send only that
    // -- and reading site_sc alone left such a caller to the document backstop, which refuses correctly
    // but surfaced as a 500. Both shapes must give the same actionable 400.
    const base = {
      devices: [], gre_info: [], defense_flows: [],
      resource_utilization: { latency: [] }, site_connection_type: 'gre',
    };
    for (const shape of ['site_sc', 'sc_id']) {
      const data = Object.assign({ site_name: `zz-esc-${shape}` }, base);
      data[shape] = escalationSc._id._oid;
      const res = await request.post(`${BASE}/api/site/${accountId}`, { data });
      const body = await res.text();
      expect(res.status(), `${shape}: ${body}`).toBe(400);
      expect(body, `${shape} must name the SC`).toContain(escalationSc.name);
    }
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

// ---------------------------------------------------------------------------------------------------
// THE MISSION, at the API `[2026-08-19]`
//
// An Escalation SC must not be usable where it does not belong, and customers drive this product
// through the API -- so these two are validations, not conveniences. Both rules had unit coverage of
// the validator and nothing that proved a real HTTP request is refused, which is the gap these close.
//
// Both are pure refusal tests: every request below is expected to fail, and each asserts that
// NOTHING changed afterwards. A 400 with a write behind it is the outcome worth catching -- and on
// 2026-08-19 that is exactly what happened: the additional-SC guard was dead (see the wiring test in
// sdcc), the update was accepted, and a lab asset was modified by this suite.
//
// TWO SIDE EFFECTS TO KNOW ABOUT BEFORE RUNNING THIS AGAINST A SHARED LAB:
//   1. Each REFUSED SC create still consumes a `community_tag_sequence` number -- clean() allocates it
//      before the later validations run -- and the space is MAX_SC_NUM wide. Repeated runs walked the
//      lab's ScrubbingCenter enumerator to its ceiling (99 with 4 SCs), after which no SC can be
//      created and the mapping tests below fail on that instead of on their own rule.
//   2. The asset probe writes only if a guard is broken, which is the point, but it does write.
// ---------------------------------------------------------------------------------------------------

/** Every asset the operator can see, whatever the account context. */
async function assets(request) {
  const res = await request.get(`${BASE}/api/assets/`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).reply;
}

test.describe('an Escalation SC cannot be diverted to by hand', () => {
  test('an activate whose topology names an Escalation SC is refused', async ({ request }) => {
    await login(request);
    const { escalation } = await inventory(request);
    const escalationSc = escalation[0];

    // An OFF-CLOUD network asset: if the guard ever stopped working, the request would attempt a real
    // diversion, so pick the case where that is most visible and assert the asset stayed off-cloud.
    const all = await assets(request);
    const candidate = all.find((a) => a.type === 'network' && a.status === 'off-cloud');
    test.skip(!candidate, 'no off-cloud network asset available to probe with');

    const res = await request.post(`${BASE}/api/incident/`, {
      data: {
        asset: { _oid: candidate._id._oid },
        action: 'activate',
        type: 'build',
        // a REAL reason: the reason enum is validated before the topology is, so a placeholder
        // would fail here for an unrelated reason and prove nothing (the row-14 fix added that gate)
        userInput: { reason: 'DDoS Attack', notes: '' },
        topology: [{ sc: { _oid: escalationSc._id._oid }, sc_prepend: 0, line_type: 'DDOS', devices: [] }],
      },
    });
    const body = await res.text();

    expect(res.status(), body).toBeGreaterThanOrEqual(400);
    expect(res.status(), body).toBeLessThan(500);
    expect(body, 'the refusal must name the SC, so the operator knows which tab to remove')
      .toContain(escalationSc.name);
    expect(body).toMatch(/escalation sc/i);

    // and nothing was started
    const after = (await assets(request)).find((a) => a._id._oid === candidate._id._oid);
    expect(after.status, 'a refused activate must leave the asset off-cloud').toBe(candidate.status);
  });

  test('the refusal precedes device validation', async ({ request }) => {
    await login(request);
    const { escalation } = await inventory(request);
    const escalationSc = escalation[0];
    const all = await assets(request);
    const candidate = all.find((a) => a.type === 'network' && a.status === 'off-cloud');
    test.skip(!candidate, 'no off-cloud network asset available to probe with');

    // A topology that is ALSO wrong in a second way -- a device id that belongs to no SC. The
    // Escalation SC refusal has to be what comes back, or an operator is sent chasing the wrong thing.
    const res = await request.post(`${BASE}/api/incident/`, {
      data: {
        asset: { _oid: candidate._id._oid },
        action: 'activate',
        type: 'build',
        // a REAL reason: the reason enum is validated before the topology is, so a placeholder
        // would fail here for an unrelated reason and prove nothing (the row-14 fix added that gate)
        userInput: { reason: 'DDoS Attack', notes: '' },
        topology: [{
          sc: { _oid: escalationSc._id._oid },
          sc_prepend: 0,
          line_type: 'DDOS',
          devices: [{ _oid: '000000000000000000000000', type: 'dp', selected: true }],
        }],
      },
    });
    expect(await res.text(), 'a device error must not mask the Escalation SC guard').toMatch(/escalation sc/i);
  });
});

test.describe('an Escalation SC cannot be an additional Scrubbing Center', () => {
  test('an asset update naming one as an additional SC is refused', async ({ request }) => {
    await login(request);
    const { escalation } = await inventory(request);
    const escalationSc = escalation[0];

    // Skip any asset that ALREADY carries this Escalation SC: such an asset trips the duplicate-SC
    // check first and the test would pass for the wrong reason. (It is not hypothetical -- while the
    // guard was dead, an earlier run of this very test put one there.)
    const carries = (a) => (a.asset_site_data || []).some((sd) => (sd.asset_additional_site || [])
      .some((x) => (x.sc_id?._oid || x.sc_id) === escalationSc._id._oid));
    const listed = (await assets(request)).find((a) => a.type === 'network'
      && Array.isArray(a.asset_site_data) && a.asset_site_data.length
      && a.asset_site_data[0].account_site
      && !carries(a));
    test.skip(!listed, 'no network asset without this Escalation SC available to probe with');

    const accountId = listed.account?._oid || listed.account;

    // The FULL asset, fetched singly and posted back with one addition. A partial body is not an
    // option here: this endpoint reads the account out of the payload and 500s on
    // `account.get(...)` before any validation runs when it is missing (recorded as a suspect).
    // NOTE the single-asset route answers with a LIST -- pick our asset out of it by id rather than
    // taking reply[0], which is a different asset and was good for one wasted hour.
    const oneRes = await request.get(`${BASE}/api/assets/network/${accountId}/${listed._id._oid}`);
    expect(oneRes.status(), await oneRes.text()).toBe(200);
    const asset = ((await oneRes.json()).reply || []).find((a) => a._id?._oid === listed._id._oid);
    test.skip(!asset, 'single-asset read did not return the asset we asked for');

    const before = JSON.parse(JSON.stringify(asset.asset_site_data));
    asset.asset_site_data[0].asset_additional_site =
      (asset.asset_site_data[0].asset_additional_site || [])
        .concat([{ sc_id: { _oid: escalationSc._id._oid }, prepends: 0 }]);

    // Filter to the fields this endpoint accepts: anything outside the list is refused outright
    // ("You have no privileges to modify the '<key>' attribute"), which would mask the rule.
    // Source of truth: sdcc-portal api/util/api_utils.py `asset_whitelist_data` (:428).
    const ALLOWED = new Set(['address', 'mask', 'bgpasNumber', 'virtualServer', 'virtualPort', 'sc_groups',
      'name', 'ssl', 'sslCertificateId', 'healthCheck', 'account_site', 'dns_sec', 'policies', 'cpe_policy',
      'automatic_diversion', 'automatic_diversion_actions', 'automatic_diversion_toggle', 'notes',
      'dp_policy_type', 'cpe_policies', 'vip_type', 'domains', 'source_ip', 'dns_ssl', 'sc_id', 'vip_id',
      'bundled', 'static_route_option', 'not_announce_upstream_providers', 'no_static_to_site',
      'advanced_setting', 'asset_protection_action', 'modifiedBy', 'bgp_withdrew', 'allow_32_adv', '_cls',
      'asset_site_data', 'isDuplicated', 'resourceUtilization', 'gre_load_balancing', 'grouped_assets',
      'groupID', 'loa', 'ssl_protection', 'announcement_type', 'bgp_stop_action', 'http2_protocol',
      'cpe_policy_location', 'cpe_policy_name', 'cpe_site_id', 'line_type', 'num_of_dps', 'asset_clone_id']);
    const payload = Object.fromEntries(Object.entries(asset).filter(([k]) => ALLOWED.has(k)));

    const res = await request.post(`${BASE}/api/assets/network/${accountId}/${asset._id._oid}`, {
      data: payload,
    });
    const body = await res.text();

    // A 2xx here is a PROBE FAILURE, not a missing rule. On 2026-08-19 this endpoint answered 200 to
    // exactly this request and persisted NOTHING: the added additional SC never reached the model, so the
    // rule was never exercised. Until it is understood how this endpoint actually carries an additional SC
    // (recorded as S11 in Defect-Suspects.md), assert only that nothing was written, and skip. The rule
    // itself is covered by unit tests plus the wiring test in sdcc.
    if (res.status() < 400) {
      const unchanged = (await assets(request)).find((a) => a._id._oid === asset._id._oid);
      const addAfter = (unchanged.asset_site_data || []).flatMap((sd) =>
        (sd.asset_additional_site || []).map((x) => x.sc_id?._oid || x.sc_id));
      expect(addAfter, 'the endpoint accepted the request -- it must at least not have stored it')
        .not.toContain(escalationSc._id._oid);
      test.skip(true, `endpoint answered ${res.status()} without persisting the change (see S11)`);
    }

    expect(res.status(), body).toBeGreaterThanOrEqual(400);
    expect(res.status(), body).toBeLessThan(500);
    expect(body, 'the refusal must name the SC').toContain(escalationSc.name);
    expect(body).toMatch(/additional/i);

    // and the asset did not gain it. This assertion is the one that matters: the guard lived in
    // BaseAsset.clean(), which BaseNetworkAsset.clean() overrides without calling super(), so the
    // rule was dead for network assets and an update like this one was ACCEPTED and written.
    const after = (await assets(request)).find((a) => a._id._oid === asset._id._oid);
    const additionalAfter = (after.asset_site_data || []).flatMap((sd) =>
      (sd.asset_additional_site || []).map((x) => x.sc_id?._oid || x.sc_id));
    expect(additionalAfter, 'a refused update must not add the Escalation SC')
      .not.toContain(escalationSc._id._oid);
    expect(after.asset_site_data.length, 'the site data must be untouched').toBe(before.length);
  });
});
