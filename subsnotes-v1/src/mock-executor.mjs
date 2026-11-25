/**
 * Browser-safe mock executor for judge mode / offline demos.
 * Intentionally has no Node or Anthropic dependencies.
 */

export class MockExecutor {
  async execute(mandate, context = {}) {
    await new Promise(resolve => setTimeout(resolve, 100));

    return {
      success: true,
      message: 'Mock cancellation successful',
      evidence: {
        confirmationId: 'MOCK-' + Date.now(),
        steps: [
          { action: 'navigate', url: 'mock-site' },
          { action: 'click', selector: '.cancel-link' },
          { action: 'click', selector: '.confirm-cancel' }
        ],
        duration: 100,
        tokenUsage: 0,
        replayMode: true,
        mandateId: mandate?.id || null,
        merchant: context?.subscriptionDetails?.merchant || mandate?.merchant || null
      }
    };
  }
}
