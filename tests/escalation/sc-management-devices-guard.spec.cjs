// The management_devices contract on the SC API (CDDOS-3307). No browser involved.
//
// WHY THIS EXISTS
//   An SC with NO management devices is a valid production state -- the FRA03 Escalation SC has
//   none and saves. So the defect was never "empty devices"; it was an UPDATE whose payload omits
//   the `management_devices` KEY, which reached check_if_connected_management_devices_were_deleted,
//   subscripted data["management_devices"] and raised KeyError -- a 500 for a malformed request.
//
// WHAT IT PINS, AND WHY THE OBVIOUS FIX WAS WRONG
//   add_sc_devices gates every device list on `is not None`, so absent and empty are DIFFERENT
//   instructions: absent means "leave the list alone", [] means "set it to empty". Defaulting the
//   absent key to [] before that call -- the natural repair -- would turn a forgotten key into a
//   device deletion, and only devices referenced by another entity are caught by the guard above
//   it; unreferenced ones would go silently. The 500 was masking that.
//   So: update without the key is REFUSED (400), create still tolerates it, and an explicit []
//   still means what it always meant.
//
// SAFETY
//   Everything happens on a throwaway probe SC created and deleted by this file. No existing SC is
//   updated, so a regression here cannot touch lab devices.
//
// DELIBERATE COVERAGE GAP
//   The destructive case -- an explicit [] on an SC that really HAS devices, which must still
//   delete them -- is not exercised, because building a valid device to delete is a bigger fixture
//   than this contract needs. Case 3 proves only that a legitimate [] is not over-refused.
//   Nor is the STORED device list asserted: the SC API does not expose management_devices in either
//   the list or the single view, so checking it would mean reading Mongo and making this suite
//   VM-only. What these tests pin is the status-code contract, which is what CDDOS-3307 was about.
//   For the record, measured in Mongo on 2026-08-25: a create with the key absent does NOT store an
//   empty list. It normalises to [], and then the DEFENSE_PIPE_SERVICE block further down appends
//   three invisible service elements (DNS_Service, DefenseFlow, RADB_Service), so the stored list
//   has three entries with display_group "invisible". Asserting "[] means empty" would have been
//   wrong.
//
// Run (HTTP only -- works from the lab host or a laptop on VPN):
//   cd sdcc-tests
//   SDCC_PORTAL_PUBLIC_URL=http://10.20.4.20:8001 npx playwright test tests/escalation/sc-management-devices-guard.spec.cjs

const { test, expect } = require('playwright/test');

const BASE = process.env.SDCC_PORTAL_PUBLIC_URL || 'http://localhost:8000';
const USER = process.env.PORTAL_USER || 'twister@example.com';
const PASSWORD = process.env.PORTAL_PASSWORD || 'd0sattack';
const PROBE_NAME = 'ZZ_MGMT_DEV_PROBE';

test.describe.configure({ mode: 'serial', timeout: 120000 });

let probeId = null;
let backendOid = null;

async function login(request) {
  const res = await request.post(`${BASE}/api/auth/`, { data: { u: USER, p: PASSWORD } });
  expect(res.status(), await res.text()).toBe(200);
}

async function scs(request) {
  const res = await request.get(`${BASE}/api/sc/`);
  expect(res.status()).toBe(200);
  return (await res.json()).reply;
}

async function probe(request) {
  return (await scs(request)).find((s) => s.name === PROBE_NAME) || null;
}

/** Create body WITHOUT management_devices -- that omission is case 1's whole point. */
function createBody(backendOid) {
  return {
    name: PROBE_NAME,
    abbreviation: 'ZZM',
    backend: { _oid: backendOid },
    ip_networks: [],
    vip_network: null,
  };
}

test.afterAll(async ({ request }) => {
  await login(request);
  const existing = await probe(request);
  if (existing) {
    const res = await request.delete(`${BASE}/api/sc/${existing._id._oid}`);
    expect([200, 204], `probe SC ${existing._id._oid} must be removed`).toContain(res.status());
  }
});

test.describe('management_devices on the SC API', () => {
  test('create tolerates an absent management_devices key', async ({ request }) => {
    await login(request);
    backendOid = (await scs(request)).map((s) => s.backend && s.backend._oid).find(Boolean);
    expect(backendOid, 'need an existing backend to build a valid SC body').toBeTruthy();

    const res = await request.post(`${BASE}/api/sc/`, { data: createBody(backendOid) });
    expect(res.status(), await res.text()).toBe(200);

    const created = await probe(request);
    expect(created, 'the probe SC should exist after a successful create').toBeTruthy();
    probeId = created._id._oid;
  });

  test('update WITHOUT the key is refused with 400, not 500', async ({ request }) => {
    await login(request);
    expect(probeId, 'case 1 must have created the probe').toBeTruthy();

    const res = await request.post(`${BASE}/api/sc/${probeId}`, {
      data: { name: PROBE_NAME, abbreviation: 'ZZM', backend: { _oid: backendOid }, ip_networks: [] },
    });

    const body = await res.text();
    expect(res.status(), `expected a client error, got: ${body}`).toBe(400);
    expect(body).toContain('Management devices list required');

    const after = await probe(request);
    expect(after, 'a refused update must not remove the SC').toBeTruthy();
  });

  test('update WITH an explicit empty list is accepted', async ({ request }) => {
    await login(request);
    expect(probeId).toBeTruthy();

    const res = await request.post(`${BASE}/api/sc/${probeId}`, {
      data: {
        name: PROBE_NAME, abbreviation: 'ZZM', backend: { _oid: backendOid },
        management_devices: [], ip_networks: [],
      },
    });
    expect(res.status(), await res.text()).toBe(200);

    const after = await probe(request);
    expect(after, 'an accepted update must leave the SC in place').toBeTruthy();
  });
});
