/**
 * E2E test for fictional merchant cancellation flow in replay mode
 */

import { test, expect } from '@playwright/test';
import { PlaywrightExecutor } from '../../src/executor.mjs';

test.describe('Fictional Merchant Cancellation', () => {
  test('should complete cancellation flow in replay mode', async ({ page }) => {
    // Create executor in replay mode
    const executor = new PlaywrightExecutor({ replayMode: true });

    // Create a mock mandate
    const mandate = {
      id: 'test-mandate-123',
      merchant: 'FictionalMerchant',
      action: 'cancel',
      scope: 'single',
      status: 'approved'
    };

    const subscription = {
      merchant: 'Premium Streaming',
      amount: 29.99,
      cadence: 'monthly'
    };

    // Execute in replay mode
    const result = await executor.execute(mandate, {
      subscriptionDetails: subscription,
      page
    });

    // Verify execution was successful
    expect(result.success).toBe(true);
    expect(result.message).toContain('Executed from replay');
    expect(result.evidence.confirmationId).toBe('CNF-2026-11-25-XY789');
    expect(result.evidence.steps.length).toBeGreaterThan(0);
    expect(result.evidence.replayMode).toBe(true);
  });

  test('fictional merchant site has all required elements', async ({ page }) => {
    await page.goto('http://localhost:4199/fictional-merchant.html');

    // Check login screen
    const loginScreen = page.locator('[data-testid="login-screen"]');
    await expect(loginScreen).toBeVisible();
    
    const emailInput = page.locator('[data-testid="email-input"]');
    await expect(emailInput).toBeVisible();

    // Fill login form
    await emailInput.fill('test@example.com');
    await page.locator('[data-testid="password-input"]').fill('password123');
    await page.click('button:has-text("Sign In")');

    // Check 2FA screen
    const twoFAScreen = page.locator('[data-testid="twofa-screen"]');
    await expect(twoFAScreen).toBeVisible({ timeout: 2000 });

    const twoFAInput = page.locator('[data-testid="twofa-code"]');
    await twoFAInput.fill('123456');
    await page.click('button:has-text("Verify")');

    // Check account screen
    const accountScreen = page.locator('[data-testid="account-screen"]');
    await expect(accountScreen).toBeVisible({ timeout: 2000 });

    // Find cancel link (dark pattern: hidden/small)
    const cancelLink = page.locator('a:has-text("Need to cancel")');
    await expect(cancelLink).toBeVisible();
    
    // Click cancel link
    await cancelLink.click();

    // Dark pattern 1: Retention offer modal
    const retentionModal = page.locator('[data-testid="retention-modal"]');
    await expect(retentionModal).toBeVisible({ timeout: 1000 });

    // Reject retention offer
    await page.click('button:has-text("No thanks, continue cancelling")');

    // Dark pattern 2: Confirmshaming modal
    const confirmshamingModal = page.locator('[data-testid="confirmshaming-modal"]');
    await expect(confirmshamingModal).toBeVisible({ timeout: 1000 });

    // Proceed through confirmshaming
    await page.click('button:has-text("Yes, I want to lose all these benefits")');

    // Success screen
    const successScreen = page.locator('[data-testid="success-screen"]');
    await expect(successScreen).toBeVisible({ timeout: 2000 });

    // Verify confirmation ID is present
    const pageText = await successScreen.textContent();
    expect(pageText).toContain('CNF-');
  });

  test('judge mode page loads and runs demo', async ({ page }) => {
    await page.goto('http://localhost:4199/judge.html');

    // Wait for content to load
    await page.waitForTimeout(1500);

    // Check if content is visible
    const content = page.locator('#content');
    await expect(content).toBeVisible();

    // Click run demo button
    const runBtn = page.locator('#runBtn');
    await expect(runBtn).toBeVisible();
    await runBtn.click();

    // Wait for demo to complete (should be quick in mock mode)
    await page.waitForTimeout(3000);

    // Verify budget was populated
    const budgetLimit = page.locator('#budgetLimit');
    const limitText = await budgetLimit.textContent();
    expect(limitText).not.toBe('0.00');

    // Verify recommendations were generated
    const recommendations = page.locator('.recommendation-card');
    const recCount = await recommendations.count();
    expect(recCount).toBeGreaterThan(0);

    // Verify mandate was created
    const mandateBox = page.locator('#mandate');
    const mandateText = await mandateBox.textContent();
    expect(mandateText).toContain('mandate_');

    // Verify execution succeeded
    const execution = page.locator('#execution');
    const execText = await execution.textContent();
    expect(execText).toContain('Successful' || '成功');

    // Verify audit log
    const auditEntries = page.locator('.audit-entry');
    const auditCount = await auditEntries.count();
    expect(auditCount).toBeGreaterThan(0);
  });
});
