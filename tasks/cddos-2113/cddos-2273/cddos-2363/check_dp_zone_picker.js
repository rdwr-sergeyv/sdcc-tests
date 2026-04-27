const { attachLogging, launchBrowser, login, portalConfig } = require('./portal_playwright_helpers');

function getArg(name, defaultValue) {
  const dashed = `--${name}`;
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === dashed && process.argv[i + 1]) {
      return process.argv[i + 1];
    }
    if (process.argv[i].startsWith(`${dashed}=`)) {
      return process.argv[i].slice(dashed.length + 1);
    }
  }
  return defaultValue;
}

async function main() {
  const config = portalConfig();
  const scName = getArg('sc', process.env.SDCC_SC_NAME || 'SCRUBBING_1');
  const browser = await launchBrowser(config);
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1100 } });
  attachLogging(page);

  await login(page, config);
  await page.waitForTimeout(2000);

  const portalRoot = config.baseUrl.endsWith('/') ? config.baseUrl.slice(0, -1) : config.baseUrl;
  await page.goto(`${portalRoot}/dashboard#/settings/op/sc/`, {
    waitUntil: 'domcontentloaded',
    timeout: config.timeoutMs
  });
  await page.waitForLoadState('networkidle', { timeout: config.timeoutMs }).catch(() => {});
  await page.waitForTimeout(3000);

  await page.getByText(scName, { exact: true }).click({ timeout: config.timeoutMs });
  await page.waitForTimeout(1000);
  await page.getByText(/DefensePro/).first().click({ timeout: config.timeoutMs });
  await page.waitForTimeout(1000);

  const zoneOptions = await page.locator('select option, option, .ui-select-choices-row, .ui-select-choices-row span, .chosen-results li, .select2-results li, .dropdown-menu li, [role="option"]').evaluateAll(
    (nodes) => Array.from(new Set(nodes.map((node) => (node.textContent || '').trim()).filter(Boolean)))
  );
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const found = zoneOptions.some((text) => /attack[_ ]zone/i.test(text) || /attack zone/i.test(text)) || /attack[_ ]zone|Attack Zone/i.test(bodyText);
  const zoneColumnVisible = await page.getByText(/^Zone$/).first().isVisible().catch(() => false);

  console.log(`url=${page.url()}`);
  console.log(`scrubbing_center=${scName}`);
  console.log(`zone_column_visible=${zoneColumnVisible}`);
  console.log(`found_attack_zone=${found}`);
  console.log('zone_options_start');
  for (const text of zoneOptions) {
    console.log(text);
  }
  console.log('zone_options_end');
  console.log('body_zone_lines_start');
  for (const line of bodyText.split('\n').filter((line) => /zone|default|attack|always/i.test(line))) {
    console.log(line);
  }
  console.log('body_zone_lines_end');

  await browser.close();

  if (!found) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
