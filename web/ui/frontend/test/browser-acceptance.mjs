import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { fixtureResponses } from './fixture-service.mjs';

export async function checkBrowser(url) {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const unexpected = new Set();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
    const responses = fixtureResponses();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/fixture-api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace('/fixture-api', '');
      if (request.headers()['x-frontend-test'] !== 'fixture') unexpected.add('missing adapter header');
      const response = responses.get(path);
      if (request.method() !== 'GET' || !response) {
        unexpected.add(`${request.method()} ${path}`);
        await route.fulfill({ status: 501, json: { ok: false, error: 'fixture_route_not_implemented' } });
      } else await route.fulfill({ json: response });
    });
    await page.goto(url + '/?view=contacts');
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.locator('.app-titlebar-brand-word')).toHaveText('Mau');
    await expect(page.getByText('0 个员工')).toBeVisible();
    for (const name of ['内核', '员工', '新建应用', 'App 商店', '扩展', '设置']) {
      await expect(page.locator('#app-main-navigation').getByText(name, { exact: true })).toBeVisible();
    }
    for (const view of ['rooms', 'chat', 'extensions', 'app-store', 'settings']) {
      await page.goto(url + '/?view=' + view);
      await expect(page.locator('.app-shell')).toBeVisible();
      await expect(page.locator('.app-fatal-error')).toHaveCount(0);
    }
    await expect(page.getByText('直接与内核对话', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '外观', exact: true }).click();
    await expect(page.getByText('主题和界面语言。', { exact: true })).toBeVisible();
    await expect(page.getByText('简体中文', { exact: true })).toBeVisible();
    await page.evaluate(() => window.frontendTestHandle.dispose());
    await expect(page.locator('#root')).toBeEmpty();
    await page.evaluate(() => window.frontendTestHandle.dispose());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(url + '/?view=contacts');
    await expect(page.locator('.app-shell')).toBeVisible();
    assert.equal(await page.locator('html').getAttribute('data-resolved-theme'), 'dark');
    // Verify the original authentication gate, without inventing a Mau login screen.
    responses.set('/health', { ok: true, tokenRequired: false, auth: { mode: 'session' } });
    responses.set('/auth/session', { ok: true, status: 'unauthenticated', authenticated: false });
    responses.set('/auth/team-status', { required: false, satisfied: false });
    await page.goto(url);
    await expect(page.locator('.cloud-auth-shell')).toBeVisible();
    await expect(page.locator('.cloud-auth-wordmark')).toHaveText('Mau');
    await expect(page.locator('input[type=email]')).toBeVisible();
    await page.goto(url + '/?password-login=1');
    await expect(page.getByLabel('账号', { exact: true })).toBeVisible();
    await expect(page.locator('input[type=email]')).toHaveCount(0);
    await page.getByLabel('账号', { exact: true }).fill('  fixture-owner  ');
    await page.getByLabel('密码', { exact: true }).fill('wrong');
    await page.locator('button[type=submit]').click();
    await expect(page.getByRole('alert')).toHaveText('fixture_login_rejected');
    await page.getByLabel('密码', { exact: true }).fill(' fixture-password ');
    responses.set('/health', { ok: true, tokenRequired: false, auth: { mode: 'bridge-token' } });
    await page.locator('button[type=submit]').click();
    await expect(page.locator('.app-shell')).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.frontendTestCredentials), { account: 'fixture-owner', password: ' fixture-password ' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(url + '/?gaps=1&view=app-store');
    await expect(page.getByText('尚未接入', { exact: true })).toBeVisible();
    await expect(page.getByText('Fixture App Store is not connected')).toBeVisible();
    await expect(page.getByText('Fixture product control')).toBeVisible();
    await expect(page.locator('#app-main-navigation').getByText('App 商店', { exact: true })).toBeVisible();
    await page.goto(url + '/?gaps=1&view=settings');
    await page.getByRole('button', { name: '桌面端', exact: true }).click();
    await expect(page.getByText('Fixture desktop is not connected')).toBeVisible();
    assert.deepEqual([...unexpected], [], 'all fixture calls must be explicitly supported');
    assert.deepEqual(errors, [], 'no browser errors');
    console.log('Browser acceptance passed: full navigation, settings, branding, dark/mobile, email/password gates, credential callback, disposal. Fixtures only; no live model execution.');
  } finally { await browser.close(); }
}
