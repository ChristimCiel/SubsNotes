import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'docs', 'screenshots', 'v2');
const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitForServer(url) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server not ready');
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = spawn('node', ['src/server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });
  try {
    await waitForServer(BASE);
    const browser = await chromium.launch();
    for (const [w, h, suffix] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();

      await page.goto(`${BASE}/?lang=en`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="approve-finding"]');
      await page.screenshot({ path: path.join(OUT, `home-ask-en-${suffix}.png`) });

      await page.goto(`${BASE}/?lang=zh-TW`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="approve-finding"]');
      await page.screenshot({ path: path.join(OUT, `home-ask-zh-${suffix}.png`) });

      await page.goto(`${BASE}/?lang=en`, { waitUntil: 'networkidle' });
      await page.getByTestId('approve-finding').click();
      await page.waitForSelector('[data-state="done"]');
      await page.screenshot({ path: path.join(OUT, `home-done-en-${suffix}.png`) });

      await page.getByRole('button', { name: /Next|下一項/ }).click();
      await page.getByTestId('approve-finding').click();
      await page.waitForSelector('[data-state="done"]');
      await page.getByRole('button', { name: /Next|下一項/ }).click();
      await page.getByTestId('approve-finding').click();
      await page.waitForSelector('[data-state="done"]');
      await page.getByRole('button', { name: /Next|下一項/ }).click();
      await page.waitForSelector('[data-state="all-done"]');
      await page.screenshot({ path: path.join(OUT, `home-alldone-en-${suffix}.png`) });

      await page.goto(`${BASE}/?lang=en`, { waitUntil: 'networkidle' });
      if (suffix === 'mobile') {
        await page.locator('#toolsBtnMobile').click();
      } else {
        await page.getByTestId('open-tools').click();
      }
      await page.waitForSelector('#sheet.is-on, #sheet:not([hidden])');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `home-tools-en-${suffix}.png`) });

      await ctx.close();
    }
    await browser.close();
    console.log('v2 screenshots written to', OUT);
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
