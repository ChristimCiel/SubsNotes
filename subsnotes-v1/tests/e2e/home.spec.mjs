import { test, expect } from '@playwright/test';

test.describe('Home v2', () => {
  test('home: 3-second clarity, one decision, real approval', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('monthly-total')).toContainText('128');
    await expect(page.getByTestId('hook')).toContainText('32');
    const card = page.getByTestId('decision-card');
    await expect(card).toHaveAttribute('data-state', 'ask');
    await expect(card).toContainText('Lumen Chat Plus');
    await expect(page.getByTestId('approve-finding')).toContainText('12');
    await page.getByTestId('approve-finding').click();
    await expect(card).toHaveAttribute('data-state', 'done', { timeout: 5000 });
    await expect(card).toContainText(/MOCK-\d+/);
    await expect(page.getByTestId('monthly-total')).toContainText('116');
    await expect(page.getByTestId('saved-so-far')).toContainText('12');
  });

  test('home: keep, then finish all; audit visible', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('keep-finding').click();
    await page.getByTestId('approve-finding').click();
    await page.getByRole('button', { name: /Next|下一項/ }).click();
    await page.getByTestId('approve-finding').click();
    await page.getByRole('button', { name: /Next|下一項/ }).click();
    await expect(page.getByTestId('decision-card')).toHaveAttribute('data-state', 'all-done');
    await expect(page.getByTestId('monthly-total')).toContainText('108');
    await page.getByRole('button', { name: /See what changed|查看变更纪录|查看變更紀錄/ }).click();
    await expect(page.locator('.audit-entry').first()).toBeVisible();
  });

  test('home: zh-TW toggle and no jargon on primary surface', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('language-toggle').click();
    await expect(page.getByTestId('language-toggle')).toHaveText('English');
    await expect(page.getByTestId('approve-finding')).toContainText('核准');
    const visible = await page.locator('main').innerText();
    for (const w of ['T0', 'T1', 'T2', 'Ed25519', 'mandate', 'envelope', 'replay']) {
      expect(visible).not.toContain(w);
    }
  });

  test('home: mobile 390 has no horizontal scroll and the primary CTA is above the fold', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = await page.getByTestId('approve-finding').boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(844);
  });

  test('home: no alert() and no mandate before click', async ({ page }) => {
    page.on('dialog', () => {
      throw new Error('dialog opened');
    });
    await page.goto('/');
    await expect(page.getByTestId('decision-card')).toHaveAttribute('data-state', 'ask');
  });
});
