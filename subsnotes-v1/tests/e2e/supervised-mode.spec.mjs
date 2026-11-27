/**
 * E2E test for T1 supervised mode - step-by-step cancellation with user confirmation
 */

import { test, expect } from '@playwright/test';

test.describe('T1 Supervised Mode', () => {
  test('guides user through step-by-step cancellation', async ({ page, context }) => {
    await page.goto('http://localhost:4199/supervised.html');

    // Check page loaded
    await expect(page.locator('h1')).toContainText('Cancel it yourself, step by step');

    // Step 1: Prepare
    await expect(page.locator('#step1')).toBeVisible();
    await expect(page.locator('#step1 .step-instruction')).toContainText('Premium Streaming Service');
    
    const readyBtn = page.locator('#step1 button:has-text("Ready to Start")');
    await readyBtn.click();

    // Step 2 should now be visible
    await expect(page.locator('#step2')).toBeVisible();
    await expect(page.locator('#step1')).not.toBeVisible();

    // Step 2: Login
    await expect(page.locator('#step2')).toContainText('Log In to Merchant Site');
    
    // Check that confirm button is initially disabled
    const step2Confirm = page.locator('#step2Confirm');
    await expect(step2Confirm).toBeDisabled();

    // Open merchant (this enables the confirm button)
    const openMerchantBtn = page.locator('button:has-text("Open Merchant Site")');
    
    // Listen for new page (popup)
    const popupPromise = context.waitForEvent('page');
    await openMerchantBtn.click();
    const popup = await popupPromise;
    
    // Verify popup opened to fictional merchant
    await expect(popup).toHaveURL(/fictional-merchant\.html/);
    await popup.close();

    // Confirm button should now be enabled
    await expect(step2Confirm).toBeEnabled();
    await step2Confirm.click();

    // Step 3: Navigate to Account
    await expect(page.locator('#step3')).toBeVisible();
    await expect(page.locator('#step3')).toContainText('Navigate to Account Settings');
    await expect(page.locator('#step3 .alert-warning')).toContainText('Dark Pattern Alert');

    const foundCancelBtn = page.locator('#step3 button:has-text("I Found the Cancel Option")');
    await foundCancelBtn.click();

    // Step 4: Handle Retention Offers
    await expect(page.locator('#step4')).toBeVisible();
    await expect(page.locator('#step4')).toContainText('Handle Retention Offers');
    await expect(page.locator('.confirmation-box')).toBeVisible();

    const rejectBtn = page.locator('button:has-text("No Thanks, Continue Cancelling")');
    await rejectBtn.click();

    // Step 5: Confirm Cancellation
    await expect(page.locator('#step5')).toBeVisible();
    await expect(page.locator('#step5')).toContainText('Confirm Cancellation');
    await expect(page.locator('#step5')).toContainText('confirmshaming');

    const confirmBtn = page.locator('#step5 button:has-text("Confirmed Cancellation")');
    await confirmBtn.click();

    // Step 6: Verify Success
    await expect(page.locator('#step6')).toBeVisible();
    await expect(page.locator('#step6')).toContainText('Verify Cancellation');

    // Enter confirmation ID
    const confirmationInput = page.locator('#confirmationId');
    await confirmationInput.fill('CNF-TEST-123');

    const verifyBtn = page.locator('#step6 button:has-text("Cancellation Verified")');
    await verifyBtn.click();

    // Success screen
    await expect(page.locator('#stepSuccess')).toBeVisible();
    await expect(page.locator('#stepSuccess')).toContainText('Cancellation Complete');
    await expect(page.locator('#stepSuccess')).toContainText('Premium Streaming');

    // Verify progress bar reached 100%
    const progressBar = page.locator('#overallProgress');
    const width = await progressBar.evaluate(el => el.style.width);
    expect(width).toBe('100%');
  });

  test('shows hint when user requests help', async ({ page }) => {
    await page.goto('http://localhost:4199/supervised.html');

    // Complete first two steps quickly
    await page.locator('#step1 button:has-text("Ready to Start")').click();
    
    // Open merchant to enable step 2 confirmation
    await page.locator('button:has-text("Open Merchant Site")').click();
    await page.waitForTimeout(500);
    await page.locator('#step2Confirm').click();

    // Now at step 3
    await expect(page.locator('#step3')).toBeVisible();

    await page.locator('#step3 button:has-text("Show Me Where")').click();
    const hint = page.locator('[data-testid="hint-callout"]');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Hint');
    await expect(hint).toContainText('Need to cancel your subscription');
  });

  test('prevents accepting offer without re-approval', async ({ page }) => {
    await page.goto('http://localhost:4199/supervised.html');

    // Navigate to step 4
    await page.locator('#step1 button:has-text("Ready to Start")').click();
    await page.locator('button:has-text("Open Merchant Site")').click();
    await page.waitForTimeout(500);
    await page.locator('#step2Confirm').click();
    await page.locator('#step3 button:has-text("I Found the Cancel Option")').click();

    // Now at step 4 - try to accept offer
    await expect(page.locator('#step4')).toBeVisible();

    await page.locator('button:has-text("Accept the Offer")').click();
    const rescope = page.locator('[data-testid="rescope-callout"]');
    await expect(rescope).toBeVisible();
    await expect(rescope).toContainText('Mandate scope changed');
  });

  test('tracks progress correctly', async ({ page }) => {
    await page.goto('http://localhost:4199/supervised.html');

    const progressBar = page.locator('#overallProgress');

    // Initial progress (step 1)
    let width = await progressBar.evaluate(el => el.style.width);
    expect(width).toBe('0%');

    // After step 1
    await page.locator('#step1 button:has-text("Ready to Start")').click();
    width = await progressBar.evaluate(el => el.style.width);
    expect(parseFloat(width)).toBeGreaterThan(0);

    // After step 2
    await page.locator('button:has-text("Open Merchant Site")').click();
    await page.waitForTimeout(500);
    await page.locator('#step2Confirm').click();
    width = await progressBar.evaluate(el => el.style.width);
    expect(parseFloat(width)).toBeGreaterThan(16);
  });
});
