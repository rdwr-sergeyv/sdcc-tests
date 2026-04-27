const { attachLogging, launchBrowser, login, portalConfig } = require('./portal_playwright_helpers');

async function main() {
  const config = portalConfig();
  const browser = await launchBrowser(config);
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  attachLogging(page);

  const { passwordField } = await login(page, config);
  await page.waitForTimeout(3000);

  const currentUrl = page.url();
  const title = await page.title();
  const passwordVisible = await passwordField.isVisible().catch(() => false);
  const bodyText = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 1000);

  console.log(`url=${currentUrl}`);
  console.log(`title=${title}`);
  console.log(`password_field_visible=${passwordVisible}`);
  console.log('body_preview_start');
  console.log(bodyText);
  console.log('body_preview_end');

  await browser.close();

  if (passwordVisible) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
