/**
 * Capture Suite UI screenshots for PR docs (local only helper; not part of CI).
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'docs', 'screenshots');
const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server not ready: ${url}`);
}

async function shot(page, name, opts = {}) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  console.log('wrote', name);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const server = spawn('node', ['src/server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(BASE);
    const browser = await chromium.launch();

    for (const [w, h, suffix] of [
      [1440, 900, 'desktop'],
      [390, 844, 'mobile']
    ]) {
      const context = await browser.newContext({
        viewport: { width: w, height: h },
        deviceScaleFactor: 1
      });
      const page = await context.newPage();

      await page.goto(`${BASE}/?lang=en`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#snapSpent');
      await page.waitForFunction(() => document.getElementById('snapSpent')?.textContent !== '0.00');
      await shot(page, `suite-home-en-${suffix}.png`);

      await page.goto(`${BASE}/?lang=zh-TW`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.documentElement.lang === 'zh-TW');
      await shot(page, `suite-home-zh-${suffix}.png`);

      await page.goto(`${BASE}/judge.html?lang=en`, { waitUntil: 'networkidle' });
      await page.waitForSelector('#content:not(.hidden), #content');
      await page.evaluate(() => {
        const c = document.getElementById('content');
        if (c) c.classList.remove('hidden');
      });
      await shot(page, `suite-judge-en-${suffix}.png`);

      await page.click('#runBtn');
      await page.waitForSelector('[data-testid="approve-mandate"]');
      await shot(page, `suite-judge-approval-en-${suffix}.png`);
      await page.click('[data-testid="approve-mandate"]');
      await page.waitForFunction(() => /Demo Complete|展示完成/.test(document.getElementById('runBtn')?.textContent || ''));
      await shot(page, `suite-judge-complete-en-${suffix}.png`);

      await page.goto(`${BASE}/supervised.html?lang=en`, { waitUntil: 'networkidle' });
      await shot(page, `suite-guided-en-${suffix}.png`);

      await page.goto(`${BASE}/fictional-merchant.html`, { waitUntil: 'networkidle' });
      await shot(page, `suite-merchant-en-${suffix}.png`);

      await context.close();
    }

    await browser.close();
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
