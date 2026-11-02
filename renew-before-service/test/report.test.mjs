import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/report.mjs';
import { createReportServer } from '../src/server.mjs';
import { projectEvidence } from '../src/evidence.mjs';
import { get } from 'node:http';

test('private report serializes hostile email text without executable markup', () => {
  const snapshot = projectEvidence([], { asOf: '2026-11-02T10:00:00Z', coverage: { messageCount: 0 } });
  const html = renderReport(snapshot, [{ subject: '</script><script>alert("fixture")</script>', evidence: 'A & B' }]);
  assert.ok(!html.includes('</script><script>alert("fixture")'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));
  assert.match(html, /Background updates are not enabled/);
});

test('private preview is read-only, uncached, frame-isolated and rejects unknown hosts', async () => {
  const server = createReportServer({ html: '<html><script>void 0;</script></html>' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(url);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /sha256-/);
    assert.match(response.headers.get('content-security-policy'), /connect-src https:\/\/api.frankfurter.dev https:\/\/cdn.jsdelivr.net https:\/\/latest.currency-api.pages.dev/);
    assert.ok(!response.headers.get('content-security-policy').includes('connect-src *'));
    assert.equal((await fetch(url + '/messages-0.json')).status, 404);
    assert.equal((await fetch(url, { method: 'POST' })).status, 404);
    const rejectedStatus = await new Promise((resolve, reject) => { const req = get(url, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); });
    assert.equal(rejectedStatus, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('reloading the preview reads the latest saved report and its matching CSP', async () => {
  let html = '<html><script>void 1;</script>First</html>';
  const server = createReportServer({ readHtml: async () => html });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const first = await fetch(url); const firstCsp = first.headers.get('content-security-policy');
    assert.match(await first.text(), /First/);
    html = '<html><script>void 2;</script>Updated</html>';
    const next = await fetch(url);
    assert.match(await next.text(), /Updated/);
    assert.notEqual(next.headers.get('content-security-policy'), firstCsp);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
