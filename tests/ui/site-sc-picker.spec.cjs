// UI contract test: an Escalation SC must not be choosable for an account site (I9, CDDOS-3006).
//
// WHAT THIS PINS
//   The site dialog's Scrubbing Center dropdown offers every standard SC and no Escalation SC,
//   while the Escalation SC stays visible in the SC list itself. The rule is "cannot be chosen",
//   not "cannot be seen".
//
//   The server refuses such a site anyway (guard in sdcc-portal site.py), so this is the
//   convenience half -- but it is the half a person actually meets, and the filter has one subtle
//   case worth pinning: a site that already sits on an SC which later became an Escalation SC must
//   keep offering its own SC, or opening the dialog to edit something unrelated would silently
//   clear the site's selection.
//
// HOW TO RUN -- different from the other suites here
//   This one drives a browser and needs NO docker; it talks to the portal over HTTP only. Run it
//   from a machine with a browser that can reach the lab (VPN) -- NOT on the lab host, which has
//   no browsers installed:
//
//     cd sdcc-tests
//     SDCC_PORTAL_PUBLIC_URL=http://10.20.4.20:8000 npx playwright test tests/ui
//
//   Optional: PORTAL_USER / PORTAL_PASSWORD, UI_TEST_ACCOUNT (an account id to use).
//
// Everything is derived at run time from /api/sc/ and /api/accounts/ -- no SC name, id or account
// is hardcoded -- so the suite follows the lab's data rather than breaking when a role changes.
//
// Login goes through POST /api/auth/, which shares the page's cookie jar. Deliberate: it keeps the
// test about the picker instead of the login form's markup.

const { test, expect } = require('playwright/test');

const BASE = process.env.SDCC_PORTAL_PUBLIC_URL || 'http://localhost:8000';
const USER = process.env.PORTAL_USER || 'twister@example.com';
const PASSWORD = process.env.PORTAL_PASSWORD || 'd0sattack';

const SC_SELECT = 'select[name="sc"]';
const SITE_ROW = '[ng-click="toggleDetails(obj);"]';
const ADD_SITE = '//*[normalize-space(text())="Add Site"]';
const SETTLE_MS = 8000; // the Angular screen builds its lists after the route resolves
const SCAN_MS = 3000;   // shorter wait while probing accounts -- only needs the list to render

test.describe.configure({ mode: 'serial', timeout: 180000 });

async function login(page) {
  const auth = await page.request.post(`${BASE}/api/auth/`, { data: { u: USER, p: PASSWORD } });
  expect(auth.status(), await auth.text()).toBe(200);
}

async function scInventory(page) {
  const res = await page.request.get(`${BASE}/api/sc/`);
  expect(res.status()).toBe(200);
  const scs = (await res.json()).reply;
  const escalation = scs.filter((s) => s.sc_type === 'escalation');
  const standard = scs.filter((s) => s.sc_type !== 'escalation');
  expect(escalation.length,
    'the lab needs at least one Escalation SC or this test asserts nothing').toBeGreaterThan(0);
  return { scs, escalation, standard };
}

/**
 * An account to open the Sites screen for. The screen needs a concrete account in the route --
 * without one the app bounces to the tenants list -- so pick the first that actually has sites.
 */
async function accountWithSites(page, escalationNames) {
  if (process.env.UI_TEST_ACCOUNT) return process.env.UI_TEST_ACCOUNT;
  const res = await page.request.get(`${BASE}/api/accounts/`);
  const accounts = (await res.json()).reply;
  let fallback = null;
  for (const acc of accounts) {
    const id = acc._id._oid;
    await page.goto(`${BASE}/dashboard#/settings/account/sites/?r=${id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(SCAN_MS);
    if (!(await page.locator(SC_SELECT).count())) continue;
    if (!fallback) fallback = id;
    // Prefer an account that also has a site sitting on an Escalation SC, so the
    // keep-your-own-SC case has something to assert instead of skipping.
    const rows = await page.$$eval(SITE_ROW, (els) => els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()));
    if (rows.some((t) => escalationNames.some((n) => t.endsWith(n)))) return id;
  }
  if (fallback) return fallback;
  throw new Error('no account produced a Sites screen with an SC picker');
}

async function openSitesScreen(page, accountId) {
  await page.goto(`${BASE}/dashboard#/settings/account/sites/?r=${accountId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(SETTLE_MS);
  await expect(page.locator(SC_SELECT).first()).toHaveCount(1);
}

/** The SC names the picker is currently offering. */
async function pickerOptions(page) {
  return page.$$eval(`${SC_SELECT} option`, (opts) =>
    opts.map((o) => (o.textContent || '').trim()).filter(Boolean));
}

test.describe('the site dialog Scrubbing Center picker', () => {
  let accountId;

  test.beforeAll(async ({ browser }) => {
    // the scan visits accounts one by one; give it room independently of the per-test budget
    test.setTimeout(300000);
    const page = await browser.newPage();
    await login(page);
    const { escalation } = await scInventory(page);
    accountId = await accountWithSites(page, escalation.map((s) => s.name));
    await page.close();
  });

  test('a new site may be put on any standard SC', async ({ page }) => {
    await login(page);
    const { standard } = await scInventory(page);
    await openSitesScreen(page, accountId);
    await page.click(ADD_SITE);
    await page.waitForTimeout(2000);

    const offered = await pickerOptions(page);
    expect(offered.length, 'the picker rendered no options at all').toBeGreaterThan(0);
    for (const sc of standard) {
      expect(offered, `standard SC ${sc.name} must be choosable`).toContain(sc.name);
    }
  });

  test('a new site may NOT be put on an Escalation SC', async ({ page }) => {
    await login(page);
    const { escalation } = await scInventory(page);
    await openSitesScreen(page, accountId);
    await page.click(ADD_SITE);
    await page.waitForTimeout(2000);

    const offered = await pickerOptions(page);
    for (const sc of escalation) {
      // An Escalation SC has no customer GRE, so a customer site there could never carry traffic.
      expect(offered, `Escalation SC ${sc.name} must not be offered`).not.toContain(sc.name);
    }
  });

  test('an Escalation SC stays visible in the SC list -- not chosen, not hidden', async ({ page }) => {
    // Guards against "fixing" I9 by filtering the shared SC list that every screen reads.
    await login(page);
    const { escalation } = await scInventory(page);
    const names = (await (await page.request.get(`${BASE}/api/sc/`)).json()).reply.map((s) => s.name);
    for (const sc of escalation) {
      expect(names, `${sc.name} must remain visible in the SC list`).toContain(sc.name);
    }
  });

  test('a site already on an Escalation SC keeps offering its own SC', async ({ page }) => {
    await login(page);
    const { escalation } = await scInventory(page);
    const escIds = escalation.map((s) => s._id._oid);

    await openSitesScreen(page, accountId);
    // Site rows carry the SC name as text; find one sitting on an Escalation SC.
    const rows = await page.$$eval(SITE_ROW,
      (els) => els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()));
    const escNames = escalation.map((s) => s.name);
    const target = rows.findIndex((t) => escNames.some((n) => t.endsWith(n)));
    test.skip(target < 0, `no site sits on an Escalation SC (${escNames.join(', ')}) in this account`);

    await page.locator(SITE_ROW).nth(target).click();
    await page.waitForTimeout(2000);

    const offered = await pickerOptions(page);
    const own = escNames.find((n) => rows[target].endsWith(n));
    expect(offered,
      `${own} must still be offered while editing a site that already sits on it`).toContain(own);
    expect(escIds.length).toBeGreaterThan(0);
  });
});
