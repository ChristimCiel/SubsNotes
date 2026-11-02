import { readFile } from 'node:fs/promises';
import { planRefresh, finishRefresh } from '../src/refresh.mjs';
const [mode, directory, resultFile] = process.argv.slice(2);
if (!directory || !['plan','finish'].includes(mode)) throw new Error('Usage: node scripts/refresh.mjs plan /private/dir OR finish /private/dir /private/scan-result.json');
const result = mode === 'plan' ? await planRefresh(directory) : await finishRefresh(directory, JSON.parse(await readFile(resultFile, 'utf8')));
console.log(JSON.stringify(result));
