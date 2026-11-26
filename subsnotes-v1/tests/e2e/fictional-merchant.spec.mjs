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

    const content = page.locator('#content');
    await expect(content).toBeVisible({ timeout: 10000 });

    const runBtn = page.locator('#runBtn');
    await expect(runBtn).toBeVisible();
    await runBtn.click();

    // Demo pauses for a real human approval click
    const approve = page.locator('[data-testid="approve-mandate"]');
    await expect(approve).toBeVisible({ timeout: 10000 });
    await approve.click();

    await expect(runBtn).toContainText(/Demo Complete|展示完成/, { timeout: 15000 });

    const budgetLimit = page.locator('#budgetLimit');
    await expect(budgetLimit).not.toHaveText('0.00');

    const recommendations = page.locator('.recommendation-card');
    await expect(recommendations.first()).toBeVisible();

    const mandateBox = page.locator('#mandate');
    await expect(mandateBox).toContainText('mandate_');

    const execution = page.locator('#execution');
    await expect(execution).toContainText(/Successful|成功/);

    const auditEntries = page.locator('.audit-entry');
    await expect(auditEntries.first()).toBeVisible();
  });
});
