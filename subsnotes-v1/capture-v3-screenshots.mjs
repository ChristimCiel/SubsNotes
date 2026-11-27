import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'docs', 'screenshots', 'v3');
const ARTIFACTS = '/opt/cursor/artifacts';
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
  await mkdir(ARTIFACTS, { recursive: true });
  const server = spawn('node', ['src/server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });
  try {
    await waitForServer(BASE);
    const browser = await chromium.launch();
    const shots = [];
    for (const [w, h, suffix] of [[1280, 800, 'desktop'], [390, 844, 'mobile']]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();

      await page.goto(`${BASE}/?lang=en`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="approve-finding"]');
      const homePath = path.join(OUT, `home-en-${suffix}.png`);
      await page.screenshot({ path: homePath, fullPage: false });
      shots.push(homePath);

      if (suffix === 'mobile') {
        await page.locator('#importBtnMobile').click();
      } else {
        await page.getByTestId('open-import').click();
      }
      await page.waitForSelector('#sheet.is-on, #sheet:not([hidden])');
      await page.waitForTimeout(350);
      const importPath = path.join(OUT, `import-en-${suffix}.png`);
      await page.screenshot({ path: importPath, fullPage: false });
      shots.push(importPath);

      await ctx.close();
    }
    await browser.close();

    for (const p of shots) {
      await copyFile(p, path.join(ARTIFACTS, path.basename(p)));
    }
    console.log('v3 screenshots written to', OUT);
    console.log('artifacts:', shots.map((p) => path.basename(p)).join(', '));
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
