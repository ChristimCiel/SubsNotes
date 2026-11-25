/**
 * T2 Playwright Executor - Autonomous subscription cancellation
 * Guided by Claude API with offline replay capability
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockExecutor } from './mock-executor.mjs';

export { MockExecutor };

const MAX_STEPS = 20;
const TOKEN_LIMIT = 10000;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPLAY_DIR = join(MODULE_DIR, '..', 'fixtures', 'replays');

// Map demo merchant labels onto the recorded offline fixture.
const REPLAY_ALIASES = {
  'premium-streaming': 'fictional-merchant',
  'fictionalmerchant': 'fictional-merchant',
  'fictional-merchant': 'fictional-merchant'
};

/**
 * Executor for T2 (autonomous) cancellations
 */
export class PlaywrightExecutor {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
    this.replayMode = options.replayMode || !this.apiKey;
    this.replayDir = options.replayDir || DEFAULT_REPLAY_DIR;
    this.tokenUsage = 0;
    this.client = null;
    this._anthropicReady = null;
  }

  async ensureClient() {
    if (this.client) return this.client;
    if (!this.apiKey) {
      throw new Error('Claude API key not available');
    }
    if (!this._anthropicReady) {
      this._anthropicReady = import('@anthropic-ai/sdk').then(({ default: Anthropic }) => {
        this.client = new Anthropic({ apiKey: this.apiKey });
        return this.client;
      });
    }
    return this._anthropicReady;
  }

  /**
   * Execute a cancellation mandate
   * @param {Object} mandate - Approved mandate
   * @param {Object} context - { subscriptionDetails, page }
   * @returns {Object} Execution result
   */
  async execute(mandate, context) {
    const { subscriptionDetails, page } = context;
    
    if (!page) {
      throw new Error('Playwright page instance required');
    }

    const steps = [];
    const startTime = Date.now();
    let success = false;
    let message = '';
    let evidence = {};

    try {
      // Check if we're in replay mode and have recorded steps
      const replayFile = this.getReplayFilename(mandate, subscriptionDetails);
      
      if (this.replayMode) {
        const result = await this.executeFromReplay(replayFile, page, steps);
        success = result.success;
        message = result.message;
        evidence = result.evidence;
      } else {
        const result = await this.executeLive(mandate, subscriptionDetails, page, steps);
        success = result.success;
        message = result.message;
        evidence = result.evidence;
        
        // Record the successful execution for replay
        if (success) {
          await this.saveReplay(replayFile, steps, result);
        }
      }
    } catch (error) {
      message = `Execution failed: ${error.message}`;
      success = false;
    }

    return {
      success,
      message,
      evidence: {
        ...evidence,
        steps,
        duration: Date.now() - startTime,
        tokenUsage: this.tokenUsage,
        replayMode: this.replayMode
      }
    };
  }

  /**
   * Execute live with Claude API guidance
   */
  async executeLive(mandate, subscription, page, steps) {
    await this.ensureClient();

    // Navigate to the merchant site
    await page.goto('http://localhost:4199/fictional-merchant.html');
    steps.push({ action: 'navigate', url: 'fictional-merchant.html', timestamp: Date.now() });

    // Get initial guidance
    const context = await this.buildContext(page, subscription, mandate);
    let currentStep = 0;

    while (currentStep < MAX_STEPS) {
      if (this.tokenUsage > TOKEN_LIMIT) {
        throw new Error('Token limit exceeded');
      }

      const screenshot = await page.screenshot({ type: 'png', encoding: 'base64' });
      const guidance = await this.getGuidance(context, screenshot, steps);
      
      this.tokenUsage += guidance.usage?.total_tokens || 0;

      if (guidance.action === 'complete') {
        // Verify cancellation
        const confirmed = await this.verifyCancellation(page);
        
        if (confirmed) {
          steps.push({ action: 'verified', timestamp: Date.now() });
          return {
            success: true,
            message: 'Subscription cancelled successfully',
            evidence: { confirmationId: await this.extractConfirmationId(page) }
          };
        } else {
          return {
            success: false,
            message: 'Could not verify cancellation',
            evidence: { screenshot }
          };
        }
      } else if (guidance.action === 'stop') {
        return {
          success: false,
          message: guidance.reason || 'Execution stopped by agent',
          evidence: { screenshot }
        };
      } else {
        // Execute the guided step
        await this.executeStep(page, guidance, steps);
        currentStep++;
      }
    }

    throw new Error('Max steps reached without completion');
  }

  /**
   * Execute from recorded replay (offline mode)
   */
  async executeFromReplay(replayFile, page, steps) {
    try {
      const replay = JSON.parse(await readFile(replayFile, 'utf8'));
      
      // Execute each recorded step
      for (const step of replay.steps) {
        switch (step.action) {
          case 'navigate':
            await page.goto(step.url);
            break;
          case 'click':
            await page.click(step.selector);
            break;
          case 'fill':
            await page.fill(step.selector, step.value);
            break;
          case 'wait':
            await page.waitForTimeout(step.duration);
            break;
        }
        steps.push(step);
      }

      return {
        success: replay.result.success,
        message: 'Executed from replay: ' + replay.result.message,
        evidence: replay.result.evidence
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`No replay found: ${replayFile}. Run with ANTHROPIC_API_KEY first to record.`);
      }
      throw error;
    }
  }

  /**
   * Get guidance from Claude
   */
  async getGuidance(context, screenshot, previousSteps) {
    const prompt = this.buildPrompt(context, previousSteps);
    
    const response = await this.client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } }
        ]
      }]
    });

    return this.parseGuidance(response.content[0].text);
  }

  /**
   * Build context for Claude
   */
  buildContext(page, subscription, mandate) {
    return {
      task: 'Cancel subscription',
      merchant: subscription.merchant,
      mandate,
      constraints: [
        'User login and 2FA are user-present (wait for user)',
        'Stop at payment forms',
        'Look for hidden cancel links',
        'Handle retention offers (reject them)',
        'Handle confirmshaming (proceed with cancellation)',
        'Extract confirmation ID when done'
      ]
    };
  }

  /**
   * Build prompt for Claude
   */
  buildPrompt(context, previousSteps) {
    return `You are helping cancel a subscription at ${context.merchant}.

Mandate: ${JSON.stringify(context.mandate, null, 2)}

Previous steps: ${previousSteps.length} steps taken

Constraints:
${context.constraints.map(c => `- ${c}`).join('\n')}

Look at the current page screenshot and determine the next action.

Respond with JSON only:
{
  "action": "click" | "fill" | "wait" | "complete" | "stop",
  "selector": "CSS selector (for click/fill)",
  "value": "text to enter (for fill)",
  "reason": "explanation of why this step is needed",
  "duration": milliseconds (for wait)
}

If you see the cancellation confirmation screen, respond with action: "complete".
If you encounter an unexpected page or error, respond with action: "stop" and explain why.`;
  }

  /**
   * Parse Claude's guidance
   */
  parseGuidance(text) {
    try {
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      return JSON.parse(json);
    } catch {
      return { action: 'stop', reason: 'Could not parse guidance' };
    }
  }

  /**
   * Execute a single step
   */
  async executeStep(page, guidance, steps) {
    const step = {
      action: guidance.action,
      selector: guidance.selector,
      value: guidance.value,
      duration: guidance.duration,
      reason: guidance.reason,
      timestamp: Date.now()
    };

    switch (guidance.action) {
      case 'click':
        await page.click(guidance.selector);
        break;
      case 'fill':
        await page.fill(guidance.selector, guidance.value);
        break;
      case 'wait':
        await page.waitForTimeout(guidance.duration);
        break;
    }

    steps.push(step);
  }

  /**
   * Verify cancellation
   */
  async verifyCancellation(page) {
    const successScreen = await page.$('[data-testid="success-screen"]');
    if (!successScreen) return false;

    const isVisible = await successScreen.isVisible();
    return isVisible;
  }

  /**
   * Extract confirmation ID
   */
  async extractConfirmationId(page) {
    try {
      const text = await page.textContent('[data-testid="success-screen"]');
      const match = text.match(/CNF-[\w-]+/);
      return match ? match[0] : null;
    } catch {
      return null;
    }
  }

  /**
   * Save replay for offline mode
   */
  async saveReplay(filename, steps, result) {
    const replay = {
      version: '1.0',
      recorded: new Date().toISOString(),
      steps,
      result
    };

    await writeFile(filename, JSON.stringify(replay, null, 2));
  }

  /**
   * Get replay filename
   */
  getReplayFilename(mandate, subscription) {
    const raw = (subscription?.merchant || mandate?.merchant || 'fictional-merchant')
      .toLowerCase()
      .replace(/\s+/g, '-');
    const name = REPLAY_ALIASES[raw] || raw;
    return join(this.replayDir, `${name}-cancel.json`);
  }
}
