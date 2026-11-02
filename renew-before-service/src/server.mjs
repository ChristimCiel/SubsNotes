import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { FX_CONNECT_ORIGINS } from './fx.mjs';

export function createReportServer({ html, readHtml = async () => html }) {
  return createServer(async (request, response) => {
    const host = request.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { response.writeHead(403); response.end('Forbidden'); return; }
    if (request.method !== 'GET' || request.url !== '/') { response.writeHead(404); response.end('Not found'); return; }
    let current;
    try { current = await readHtml(); if (typeof current !== 'string') throw new Error('Invalid report'); }
    catch { response.writeHead(503, { 'Cache-Control': 'no-store' }); response.end('The local report is unavailable. Retry after the review completes.'); return; }
    const hashes = [...current.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'");
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; script-src " + hashes.join(' ') + "; style-src 'unsafe-inline'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; connect-src " + FX_CONNECT_ORIGINS.join(' ')
    });
    response.end(current);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  const file = process.argv[process.argv.indexOf('--report') + 1];
  if (!process.argv.includes('--report') || !file) throw new Error('Usage: npm start -- --report /absolute/path/to/private/review.html');
  await readFile(file, 'utf8');
  const server = createReportServer({ readHtml: () => readFile(file, 'utf8') });
  const port = Number(process.env.PORT || 4183);
  server.listen(port, '127.0.0.1', () => console.log(`Private, read-only report: http://127.0.0.1:${port}/ (reload to read the latest saved report; opening this page never scans Gmail)`));
}
