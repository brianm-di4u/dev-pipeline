import { expect, test } from '@playwright/test';

test('the running app answers, as a user would see it', async ({ page }) => {
  await page.goto('/?name=Ada');
  await expect(page.locator('body')).toContainText('Hello, Ada!');
});

test('the health check answers', async ({ request }) => {
  const response = await request.get('/health');
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toEqual({ ok: true });
});
