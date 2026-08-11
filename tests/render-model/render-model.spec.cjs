// Deterministic render-model regression test.
//
// Drives a full diversion lifecycle in BUILD mode and asserts on the rendered device
// configuration rather than on task status. Encodes the render semantics measured in the lab on
// 2026-08-11 (see docs/tasks/escalate/Confluence/Test-Plan.md section 3c), each of which
// contradicts an assertion that seemed obvious from reading the code:
//
//   1. activate renders the FULL set -- a term for every in-zone DP that has AR wiring, not just
//      the selected ones. Equality against the selected set fails on a correct render.
//   2. selection is expressed by a BGP COMMUNITY, not the metric (metric is uniform).
//   3. update renders only the DELTA; an unchanged-but-selected DP is not re-rendered at all.
//   4. removing a DP DEMOTES its AR term (rewritten, retained) while deleting its DP-side policy.
//   5. full deactivate DELETES every term plus the route-filter-list.
//   6. emptiness cannot be asserted blanket -- edge routers legitimately render nothing, and the
//      deactivate `#cmd#0` file is a read (GetConfig) phase.
//
// Deliberate design choices:
//   * No magic community values. The selected/unselected marker is derived by PARTITIONING the
//     observed communities, so the test survives a lab whose numbering differs. Hardcoding
//     65000:700 would make this a lab-specific snapshot instead of a regression test.
//   * Expectations are DERIVED from the DB (SC document, zone closure, AR interface map), never
//     hardcoded, so the test follows the lab instead of pinning it.
//   * Every task must be `type: build` AND `status: done` before any assertion runs. A failed task
//     invalidates the render, and a non-build task means a device was contacted.
//
// Run:  npx playwright test tests/render-model
// Env:  RENDER_TEST_ASSET (default asset_1)

const { test, expect } = require('playwright/test');
const {
  docker,
  login,
  mongoJson,
  waitFor,
} = require('../dp-isolate/dp-isolate-helpers.cjs');

const ASSET_NAME = process.env.RENDER_TEST_ASSET || 'asset_1';
const ARTEFACT_ROOT = '/var/lib/sdcc/core/device_config';
// The action gates in diversion.py:1988 -- an action is refused unless the asset status is in the
// matching list. `activating` is in NEITHER, and it is the transient state right after an activate:
// task completion and the asset-status transition are ASYNCHRONOUS, so a test must wait on status,
// not only on tasks.
const READY_LIST = ['off-cloud', 'activating_request'];                                    // activate
const DIVERTED_LIST = ['on-cloud', 'pending', 'on-cloud-bGP-pending', 'deactivating-request']; // update/deactivate

const ACTIVATE_REASON = 'Diversion Test';   // must be a member of the server-side reason enum
const DEACTIVATE_REASON = 'Attack Ended';   // the UI's default on deactivate

// backend name -> container. Same mapping as docs/kb/runbooks/lab-stack-reference.md section 6.
const BACKEND_CONTAINERS = {
  docker: 'legacy-portal-backend-hybrid-1',
  'docker-monitor': 'legacy-portal-backend-monitor-1',
};

let ctx; // resolved once in beforeAll and shared across the serial tests

// ---------------------------------------------------------------- DB-derived expectations

function resolveContext(assetName) {
  return mongoJson(`(() => {
    const asset = db.Assets.findOne({ name: '${assetName}', type: 'network' });
    if (!asset) throw new Error('asset not found: ${assetName}');
    const account = db.Accounts.findOne({ _id: asset.account });

    // the asset's sites -> their SCs. This test handles the single-SC case.
    const siteIds = (asset.asset_site_data || []).map((s) => s.account_site);
    const sites = db.AccountSites.find({ _id: { $in: siteIds } }).toArray();
    const scIds = [...new Set(sites.map((s) => String(s.sc_id)))];
    if (scIds.length !== 1) throw new Error('expected exactly one SC, got ' + scIds.length);
    const sc = db.ScrubbingCenters.findOne({ _id: ObjectId(scIds[0]) });

    // zone closure of the account zone: every zone reachable by walking fail_over
    const zones = {};
    db.DPZones.find({}).forEach((z) => { zones[String(z._id)] = z; });
    const closure = [];
    let cur = zones[String(account.zone)];
    while (cur) { closure.push(String(cur._id)); cur = cur.fail_over ? zones[String(cur.fail_over)] : null; }

    const devices = sc.management_devices || [];
    const dps = devices.filter((d) => d.role === 'radware-defensepro');
    const routersOut = devices.filter((d) => d.role === 'router-out');
    const routersIn = devices.filter((d) => d.role === 'router-in');

    // DP -> the VLAN it is reachable on, per AR. A DP with no ingress interface anywhere gets no
    // policy term, which is why the term set is "in-zone AND wired", not merely "in-zone".
    const wiring = {};
    routersOut.forEach((ar) => {
      (ar.interfaces || []).forEach((i) => {
        const key = String(i.ingress);
        wiring[key] = wiring[key] || {};
        wiring[key][String(ar.name)] = i.VLAN;
      });
    });

    return {
      assetId: String(asset._id),
      assetName: asset.name,
      address: String(asset.address),
      mask: Number(asset.mask) || 24,
      accountZoneId: String(account.zone),
      zoneClosure: closure,
      scId: String(sc._id),
      scName: sc.name,
      backendId: String(sc.backend),
      dps: dps.map((d) => ({
        id: String(d.unique_id),
        name: d.name,
        zoneId: String(d.zone),
        inZone: closure.includes(String(d.zone)),
        vlans: wiring[String(d.unique_id)] || {},
      })),
      routersOut: routersOut.map((r) => ({ id: String(r.unique_id), name: r.name })),
      routersIn: routersIn.map((r) => ({ id: String(r.unique_id), name: r.name })),
    };
  })()`);
}

function backendContainer(backendId) {
  const name = mongoJson(`(() => {
    const b = db.Backends.findOne({ _id: ObjectId('${backendId}') });
    return b ? b.name : null;
  })()`);
  const container = BACKEND_CONTAINERS[name];
  if (!container) {
    throw new Error(`no container mapped for backend ${name}; update BACKEND_CONTAINERS`);
  }
  return container;
}

/** DPs that must have a term: in the account zone's closure AND wired to the given AR. */
function expectedTermVlans(context, arName) {
  const out = {};
  for (const dp of context.dps) {
    if (!dp.inZone) continue;
    const vlan = dp.vlans[arName];
    if (vlan === undefined || vlan === null) continue;
    out[dp.name] = String(vlan);
  }
  return out;
}

// ---------------------------------------------------------------- artefacts

function clearArtefacts(container) {
  docker(['exec', container, 'sh', '-c', `rm -rf ${ARTEFACT_ROOT}`], { capture: true });
}

/** { 'activate/juniper-router_LAB-AR-3': '<contents>', ... } */
function readArtefacts(container) {
  const listing = docker(
    ['exec', container, 'sh', '-c', `find ${ARTEFACT_ROOT} -type f 2>/dev/null || true`],
    { capture: true },
  ).trim();
  if (!listing) return {};
  const files = {};
  for (const full of listing.split('\n').filter(Boolean)) {
    const body = docker(['exec', container, 'cat', full], { capture: true });
    // strip the "<policy>/" prefix so keys are "<action>/<device-file>"
    files[full.replace(`${ARTEFACT_ROOT}/`, '').replace(/^[^/]+\//, '')] = body;
  }
  return files;
}

const SCAFFOLD = /^(set cli screen-width|set cli screen-length|configure private|commit|exit|terminal width|conf t|end|write|#=== SECURITYDAM|\s*$)/;

function substantiveLines(body) {
  return body.split('\n').filter((l) => !SCAFFOLD.test(l)).length;
}

/** Per-VLAN term analysis of a router-out render. */
function parseTerms(body) {
  const terms = {};
  for (const line of body.split('\n')) {
    const m = line.match(/RM_iBGP_OUTBOUND_v(\d+)/);
    if (!m) continue;
    const vlan = m[1];
    terms[vlan] = terms[vlan] || { communities: new Set(), deleted: false, metric: null };
    if (/^del policy-options policy-statement RM_iBGP_OUTBOUND_v\d+ term \d+\s*$/.test(line.trim())
        && !body.includes(`set policy-options policy-statement RM_iBGP_OUTBOUND_v${vlan} term`)) {
      terms[vlan].deleted = true;
    }
    const c = line.match(/community add (\d+:\d+)/);
    if (c) terms[vlan].communities.add(c[1]);
    const mt = line.match(/then metric (\d+)/);
    if (mt) terms[vlan].metric = mt[1];
  }
  return terms;
}

// ---------------------------------------------------------------- API

function buildTopology(context, selectedDpNames, selectedArNames) {
  const devices = [];
  for (const dp of context.dps) {
    devices.push({
      _oid: dp.id,
      type: 'dp',
      selected: selectedDpNames.includes(dp.name),
      implicit: false,
      'dp-subnet': context.address,
      'dp-mask': context.mask,
    });
  }
  for (const ar of context.routersOut) {
    devices.push({ _oid: ar.id, type: 'router-out', selected: selectedArNames.includes(ar.name), implicit: false });
  }
  for (const ir of context.routersIn) {
    devices.push({ _oid: ir.id, type: 'router-in', selected: true, implicit: false });
  }
  return [{
    sc: { _oid: context.scId },
    line_type: 'DDOS',
    sc_prepend: 0,
    zone: { _oid: context.accountZoneId },
    devices,
  }];
}

function taskMarker() {
  return mongoJson('(() => { const t = db.Tasks.find({}, { _id: 1 }).sort({ _id: -1 }).limit(1).toArray()[0]; return t ? String(t._id) : "000000000000000000000000"; })()');
}

function tasksSince(marker) {
  return mongoJson(`(() => db.Tasks.find({ _id: { $gt: ObjectId('${marker}') } }, { status: 1, type: 1, 'command.action': 1 })
    .toArray()
    .map((t) => ({ id: String(t._id), status: t.status, type: t.type, action: (t.command || {}).action })))()`);
}

async function runAction(request, baseUrl, context, { action, incidentId, topology }) {
  const marker = taskMarker();
  const data = {
    asset: { _oid: context.assetId },
    extended_assets_list: [],
    action,
    type: 'build', // never 'provisioning' -- see the header note
    topology: topology || [],
    // reason is a server-side ENUM, not free text. Activate rejects anything outside
    // ['DDoS Attack','Always-On Activation','On-Boarding Test','Diversion Test','Demo',
    //  'Automatic Diversion','Other', ...]; the UI defaults to 'DDoS Attack' on activate and
    // 'Attack Ended' on deactivate. Update takes no reason/notes at all
    // (_validate_notes_field gates ACTIVATE and DEACTIVATE only).
    userInput: action === 'update'
      ? {}
      : {
        reason: action === 'deactivate' ? DEACTIVATE_REASON : ACTIVATE_REASON,
        notes: 'render model harness',
      },
  };
  const url = incidentId ? `${baseUrl}/api/incident/${incidentId}` : `${baseUrl}/api/incident/`;
  const response = await request.post(url, { data });
  expect(response.status(), await response.text()).toBe(200);

  const tasks = await waitFor(() => {
    const found = tasksSince(marker);
    if (!found.length) return null;
    return found.every((t) => ['done', 'failed'].includes(t.status)) ? found : null;
  }, { timeoutMs: 300000, intervalMs: 5000 });

  // Both guards matter. A non-build task means a device was contacted; a failed task means the
  // render is not a valid subject for assertions.
  expect(tasks.filter((t) => t.type !== 'build'), 'every task must be build-stamped').toEqual([]);
  expect(tasks.filter((t) => t.status !== 'done'), 'every task must have finished cleanly').toEqual([]);
  return tasks;
}

function assetStatus(assetId) {
  return mongoJson(`(() => {
    const a = db.Assets.findOne({ _id: ObjectId('${assetId}') }, { status: 1 });
    return a ? a.status : null;
  })()`);
}

async function waitForAssetStatus(assetId, allowed, label) {
  return waitFor(() => {
    const status = assetStatus(assetId);
    return allowed.includes(status) ? status : null;
  }, { timeoutMs: 180000, intervalMs: 3000 }).catch(() => {
    throw new Error(`asset never reached ${label} (${allowed.join('|')}); stuck at ${assetStatus(assetId)}`);
  });
}

function openIncidentId(assetId) {
  return mongoJson(`(() => {
    const i = db.Incidents.findOne({ asset: ObjectId('${assetId}'), endedAt: null });
    return i ? String(i._id) : null;
  })()`);
}

// ---------------------------------------------------------------- the tests

// Serial: the three tests are one lifecycle and share state.
// Timeout: well above Playwright's 30s default -- each action waits for its tasks to reach a
// terminal state AND for the asset status to transition, which is asynchronous (see READY_LIST /
// DIVERTED_LIST above).
test.describe.configure({ mode: 'serial', timeout: 300000 });

test.describe('render model', () => {
  let baseUrl;
  let container;
  let firstPair;  // two DPs selected by the activate
  let swapIn;     // DP added by the update

  // NOTE: no HTTP here. Playwright's `request` fixture is TEST-scoped, so a login performed in
  // beforeAll authenticates a different context than the tests use and every later call 401s.
  // Each test logs in for itself, exactly as tests/dp-isolate/dp-isolate-api.spec.cjs does.
  test.beforeAll(() => {
    ctx = resolveContext(ASSET_NAME);
    container = backendContainer(ctx.backendId);

    const wiredInZone = ctx.dps.filter((d) => d.inZone && Object.keys(d.vlans).length);
    expect(wiredInZone.length, 'need at least 3 wired in-zone DPs to exercise a swap').toBeGreaterThanOrEqual(3);
    firstPair = [wiredInZone[0].name, wiredInZone[1].name];
    swapIn = wiredInZone[2].name;
  });

  test('activate renders a term for every in-zone wired DP, and marks selection by community', async ({ request }) => {
    baseUrl = await login(request);

    // start from off-cloud so this really is a first activation
    const existing = openIncidentId(ctx.assetId);
    if (existing) {
      await runAction(request, baseUrl, ctx, {
        action: 'deactivate', incidentId: existing,
        topology: buildTopology(ctx, [], ctx.routersOut.map((r) => r.name)),
      });
    }

    await waitForAssetStatus(ctx.assetId, READY_LIST, 'a state that permits activate');

    clearArtefacts(container);
    const ars = [ctx.routersOut[0].name];
    await runAction(request, baseUrl, ctx, {
      action: 'activate',
      topology: buildTopology(ctx, firstPair, ars),
    });
    await waitForAssetStatus(ctx.assetId, DIVERTED_LIST, 'a state that permits update');

    const files = readArtefacts(container);
    const arKey = Object.keys(files).find((k) => k.startsWith('activate/') && k.includes(ars[0]));
    expect(arKey, `no activate artefact for ${ars[0]}`).toBeTruthy();

    // finding 1: the term set is every in-zone WIRED DP, not the selected subset
    const expectedVlans = expectedTermVlans(ctx, ars[0]);
    const terms = parseTerms(files[arKey]);
    expect(new Set(Object.keys(terms))).toEqual(new Set(Object.values(expectedVlans)));

    // finding 2: the discriminator is a community, and the metric is uniform
    const metrics = new Set(Object.values(terms).map((t) => t.metric));
    expect(metrics.size, 'metric does not discriminate selection').toBe(1);

    const selectedVlans = firstPair.map((n) => expectedVlans[n]);
    const unselectedVlans = Object.values(expectedVlans).filter((v) => !selectedVlans.includes(v));
    const selMarkers = selectedVlans.map((v) => [...terms[v].communities]);
    const unselMarkers = unselectedVlans.map((v) => [...terms[v].communities]);

    const sharedBySelected = selMarkers.reduce((acc, cs) => acc.filter((c) => cs.includes(c)), selMarkers[0] || []);
    const anyUnselected = new Set(unselMarkers.flat());
    const marker = sharedBySelected.filter((c) => !anyUnselected.has(c));
    expect(marker.length, 'selected DPs must share a community that no unselected DP carries').toBeGreaterThan(0);

    // finding 5, inverted: an activate must never tear the announcement down
    expect(files[arKey]).not.toMatch(/del policy-options route-filter-list/);

    // finding 6: only devices expected to carry config get an emptiness check
    expect(substantiveLines(files[arKey]), 'AR render must not be scaffold-only').toBeGreaterThan(0);
  });

  test('update renders only the delta, and a removed DP is demoted rather than deleted', async ({ request }) => {
    baseUrl = await login(request);
    await waitForAssetStatus(ctx.assetId, DIVERTED_LIST, 'a state that permits update');
    clearArtefacts(container);
    const incidentId = openIncidentId(ctx.assetId);
    expect(incidentId, 'expected an open incident from the activate').toBeTruthy();

    const removed = firstPair[1];
    const kept = firstPair[0];
    const ars = ctx.routersOut.map((r) => r.name); // add the second AR too
    await runAction(request, baseUrl, ctx, {
      action: 'update', incidentId,
      topology: buildTopology(ctx, [kept, swapIn], ars),
    });

    const files = readArtefacts(container);
    const vlansOn = (ar) => expectedTermVlans(ctx, ar);

    // finding 3: only the added DP appears in the activate direction; the unchanged one does not
    for (const ar of ars) {
      const key = Object.keys(files).find((k) => k.startsWith('activate/') && k.includes(ar));
      if (!key) continue;
      const terms = parseTerms(files[key]);
      expect(Object.keys(terms), `${ar}: update should render only the added DP`)
        .toEqual([vlansOn(ar)[swapIn]]);
    }

    // finding 4: the removed DP's term is rewritten, not deleted -- and its DP policy IS deleted
    const removalKeys = Object.keys(files).filter((k) => k.startsWith('deactivate/'));
    expect(removalKeys.length, 'expected a removal group').toBeGreaterThan(0);
    const removalBody = removalKeys.map((k) => files[k]).join('\n');
    const removedVlan = vlansOn(ars[0])[removed];
    expect(removalBody, 'removed DP term must be rewritten (set), not merely deleted')
      .toMatch(new RegExp(`set policy-options policy-statement RM_iBGP_OUTBOUND_v${removedVlan} term`));
    expect(removalBody, 'the DP-side policy must actually be deleted')
      .toMatch(/delete_policy|dp delete policy set/);
  });

  test('full deactivate deletes every term and the route-filter-list', async ({ request }) => {
    baseUrl = await login(request);
    await waitForAssetStatus(ctx.assetId, DIVERTED_LIST, 'a state that permits deactivate');
    clearArtefacts(container);
    const incidentId = openIncidentId(ctx.assetId);
    expect(incidentId).toBeTruthy();

    await runAction(request, baseUrl, ctx, {
      action: 'deactivate', incidentId,
      topology: buildTopology(ctx, [], ctx.routersOut.map((r) => r.name)),
    });

    const files = readArtefacts(container);
    const body = Object.entries(files)
      .filter(([k]) => k.startsWith('deactivate/') && k.includes('juniper-router'))
      .map(([, v]) => v)
      .join('\n');

    // finding 5: teardown deletes, it does not demote
    expect(body).toMatch(/del policy-options route-filter-list/);
    for (const vlan of Object.values(expectedTermVlans(ctx, ctx.routersOut[0].name))) {
      expect(body, `term v${vlan} must be deleted on teardown`)
        .toMatch(new RegExp(`del policy-options policy-statement RM_iBGP_OUTBOUND_v${vlan} term`));
    }

    // and the asset really is off-cloud
    expect(openIncidentId(ctx.assetId)).toBeNull();
  });
});
