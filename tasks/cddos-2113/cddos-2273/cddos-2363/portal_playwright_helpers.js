const { chromium } = require('playwright');

function parseArgs(defaults = {}) {
  const args = { ...defaults };
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    let value = inlineValue;
    if (value === undefined && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
      value = process.argv[i + 1];
      i += 1;
    }
    args[key] = value === undefined ? true : value;
  }
  return args;
}

function boolValue(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function portalConfig(defaults = {}) {
  const args = parseArgs(defaults);
  return {
    baseUrl: args.url || process.env.SDCC_PORTAL_URL || defaults.url || 'https://10.20.3.43/',
    username: args.user || process.env.SDCC_PORTAL_USER || defaults.user || 'twister@example.com',
    password: args.password || process.env.SDCC_PORTAL_PASSWORD || defaults.password || 'd0sattack',
    accountName: args.account || process.env.SDCC_ACCOUNT_NAME || defaults.account || 'meir_policy_test',
    browserChannel: args.browser || process.env.PLAYWRIGHT_BROWSER_CHANNEL || defaults.browser || 'msedge',
    headless: boolValue(args.headless || process.env.PLAYWRIGHT_HEADLESS, true),
    timeoutMs: Number(args.timeout || process.env.PLAYWRIGHT_TIMEOUT_MS || defaults.timeout || 30000),
  };
}

async function launchBrowser(config) {
  if (config.browserChannel) {
    try {
      return await chromium.launch({ channel: config.browserChannel, headless: config.headless });
    } catch (channelError) {
      console.log(`${config.browserChannel} launch failed: ${channelError.message}`);
    }
  }
  return chromium.launch({ headless: config.headless });
}

async function login(page, config) {
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
  await page.waitForLoadState('networkidle', { timeout: config.timeoutMs }).catch(() => {});

  const userField = page.locator(
    'input[type="email"], input[name="email"], input[name="username"], input[placeholder*="Email" i], input[placeholder*="User" i], input[type="text"]'
  ).first();
  const passwordField = page.locator('input[type="password"]').first();

  await userField.waitFor({ state: 'visible', timeout: config.timeoutMs });
  await passwordField.waitFor({ state: 'visible', timeout: config.timeoutMs });
  await userField.fill(config.username);
  await passwordField.fill(config.password);

  const submit = page.locator(
    'button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Log in"), button:has-text("Sign in")'
  ).first();

  if (await submit.count()) {
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: config.timeoutMs }).catch(() => {}),
      submit.click()
    ]);
  } else {
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: config.timeoutMs }).catch(() => {}),
      passwordField.press('Enter')
    ]);
  }

  return { passwordField };
}

function attachLogging(page) {
  page.on('console', (msg) => console.log(`browser console ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', (err) => console.log(`browser pageerror: ${err.message}`));
}

module.exports = {
  attachLogging,
  launchBrowser,
  login,
  portalConfig,
};
