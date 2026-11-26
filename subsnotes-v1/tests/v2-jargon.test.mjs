/**
 * Primary surface (v2.* EN/zh-TW strings + index.html outside the safety sheet)
 * must not expose technical jargon.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DICT, V2_PRIMARY_KEYS } from '../public/i18n.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BANNED = ['T0', 'T1', 'T2', 'Ed25519', 'mandate', 'envelope', 'replay', 'Detect', 'Execute', 'Verify', 'MockExecutor'];

describe('v2 primary surface jargon', () => {
  it('v2.* EN and zh-TW primary keys avoid banned words', () => {
    for (const lang of ['en', 'zh-TW']) {
      for (const key of V2_PRIMARY_KEYS) {
        const value = DICT[lang][key] || '';
        for (const w of BANNED) {
          assert.equal(
            value.includes(w),
            false,
            `${lang} ${key} contains "${w}": ${value}`
          );
        }
      }
    }
  });

  it('index.html main template (outside sheet) avoids banned words', () => {
    const html = readFileSync(join(__dirname, '../public/index.html'), 'utf8');
    const withoutSheet = html
      .replace(/<aside[\s\S]*?<\/aside>/i, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '');
    const main = withoutSheet.match(/<main[\s\S]*?<\/main>/i)?.[0] || withoutSheet;
    for (const w of BANNED) {
      if (w === 'Judge') continue; // Judge demo pill is allowed in the bar, not main
      assert.equal(main.includes(w), false, `main contains "${w}"`);
    }
  });
});
