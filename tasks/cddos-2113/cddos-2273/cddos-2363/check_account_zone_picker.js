const { attachLogging, launchBrowser, login, portalConfig } = require('./portal_playwright_helpers');

async function main() {
  const config = portalConfig();
  const browser = await launchBrowser(config);
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1100 } });
  attachLogging(page);

  await login(page, config);
  await page.waitForTimeout(2000);

  const portalRoot = config.baseUrl.endsWith('/') ? config.baseUrl.slice(0, -1) : config.baseUrl;
  await page.goto(`${portalRoot}/dashboard#/settings/account/tenants/`, {
    waitUntil: 'domcontentloaded',
    timeout: config.timeoutMs
  });
  await page.waitForLoadState('networkidle', { timeout: config.timeoutMs }).catch(() => {});
  await page.waitForTimeout(3000);

  await page.getByText(/Meir - Master|John Doe Corp MSSP|account_1/).first().click({ timeout: 10000 }).catch(async () => {
    await page.locator('.account-selector, .tenant-selector, [ng-click*="account"], [ng-click*="tenant"]').first().click({ timeout: 10000 });
  });
  await page.waitForTimeout(1000);

  const accountInput = page.locator('input[placeholder*="Search account" i], input[type="search"], input[type="text"]').locator('visible=true').first();
  await accountInput.waitFor({ state: 'visible', timeout: config.timeoutMs });
  await accountInput.fill(config.accountName);
  await page.waitForTimeout(1000);

  const accountOption = page.getByText(config.accountName, { exact: true }).last();
  await accountOption.click();
  await page.waitForLoadState('networkidle', { timeout: config.timeoutMs }).catch(() => {});
  await page.waitForTimeout(3000);

  const zoneLabel = page.getByText(/^Zone$/).last();
  await zoneLabel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);

  const optionTexts = await page.locator('select option, option, .ui-select-choices-row, .ui-select-choices-row span, .chosen-results li, .select2-results li, .dropdown-menu li, [role="option"]').evaluateAll(
    (nodes) => Array.from(new Set(nodes.map((node) => (node.textContent || '').trim()).filter(Boolean)))
  );

  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const found = optionTexts.some((text) => /attack[_ ]zone/i.test(text) || /attack zone/i.test(text)) || /attack[_ ]zone|Attack Zone/i.test(bodyText);

  console.log(`url=${page.url()}`);
  console.log(`account=${config.accountName}`);
  console.log(`found_attack_zone=${found}`);
  console.log('zone_options_start');
  for (const text of optionTexts) {
    console.log(text);
  }
  console.log('zone_options_end');

  await browser.close();

  if (!found) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
