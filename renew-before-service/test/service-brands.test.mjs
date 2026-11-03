import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createServiceBrandsRuntime } from '../src/service-brands.mjs';

test('known service identities use exact aliases, without a network lookup or fuzzy brand collision', () => {
  const brands = createServiceBrandsRuntime();
  for (const name of ['ChatGPT', 'ChatGPT Plus', 'OpenAI API', 'chatgpt.com']) {
    assert.equal(brands.resolve({ name }).key, 'openai');
    assert.match(brands.resolve({ name }).src, /^data:image\/svg\+xml;base64,/);
  }
  assert.equal(brands.resolve({ serviceKey:'linear', name:'A personal label' }).key, 'linear');
  assert.equal(brands.resolve({ name:'Vercel Pro' }).key, 'vercel');
  for (const name of ['Not OpenAI', 'ChatGPT-style Music', 'Linear Consulting', 'https://vercel.com.attacker.invalid']) {
    assert.equal(brands.resolve({ name }).src, null);
  }
});

test('unreviewed or permission-gated artwork keeps a readable text fallback', () => {
  const brands = createServiceBrandsRuntime(), claude = brands.resolve({ name:'Claude Pro' });
  assert.equal(claude.src, null);
  assert.equal(claude.reviewState, 'permission-required');
  assert.match(claude.policyURL, /^https:\/\/www\.anthropic\.com\//);
  assert.equal(claude.initials, 'CP');
  assert.equal(brands.resolve({ name:'Fictional Music' }).initials, 'FM');
  assert.equal(brands.resolve({ name:'訂閱工具' }).initials, '訂閱');
  for (const input of [null, undefined, {}, { name:'<>' }, { name:5 }, 'ChatGPT']) {
    const value = brands.resolve(input);
    assert.equal(value.src, null);
    assert.equal(value.initials, '?');
  }
});

test('bundled owner-provided assets are bounded passive SVGs with provenance and separate terms', () => {
  const brands = createServiceBrandsRuntime(), assets = brands.notices();
  assert.deepEqual(assets.map(item => item.key).sort(), ['linear','openai','vercel']);
  const digests = {
    openai:'75c1e9fffa5e8c437bec1d67197a73992bca45d166c6ff23215185dea8fae92a',
    linear:'e683e95a5eb9b360ae06360c0350fd1b5fcf3d2222ef9de8e71fa0bc413dccc3',
    vercel:'1c1507a4a4742f992a689fcb6b61ac8c48c62e1110509b68121356154e67ed91'
  };
  for (const item of assets) {
    assert.ok(item.src.length < 32768);
    assert.match(item.assetSource, /^https:\/\//);
    assert.match(item.policyURL, /^https:\/\//);
    assert.equal(item.reviewState, 'policy-reviewed');
    assert.ok(item.attribution && item.license && item.reviewedOn);
    const svg = Buffer.from(item.src.split(',')[1], 'base64').toString('utf8');
    assert.equal(createHash('sha256').update(svg).digest('hex'), digests[item.key]);
    assert.match(svg, /^<svg\b/);
    assert.match(svg, /<\/svg>\s*$/);
    assert.doesNotMatch(svg, /<(?:script|foreignObject|image|use|a|iframe|animate|set)\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=|url\s*\(|<!DOCTYPE|<!ENTITY/i);
    assert.deepEqual([...svg.matchAll(/<(\/?[A-Za-z][A-Za-z0-9]*)\b/g)].map(match => match[1].replace(/^\//,'')).filter(tag => !['svg','path','rect'].includes(tag)), []);
  }
  assert.match(assets.find(item => item.key === 'openai').license, /not covered.*MIT/);
  assert.match(assets.find(item => item.key === 'vercel').attribution, /trademarks or registered trademarks/);
});

test('the catalog can be embedded in a sandbox without Node APIs, and callers cannot alter later results', () => {
  const brands = vm.runInNewContext('(' + createServiceBrandsRuntime.toString() + ')()');
  assert.match(brands.resolve({ name:'ChatGPT' }).src, /^data:image\/svg\+xml;base64,/);
  const first = brands.resolve({ name:'Vercel' });
  first.src = 'https://attacker.invalid/track';
  const list = brands.list();
  list.find(item => item.key === 'vercel').src = null;
  assert.match(brands.resolve({ name:'Vercel' }).src, /^data:image\/svg\+xml;base64,/);
  assert.equal(brands.resolve({ name:'Unknown', src:'data:image/svg+xml;base64,PHNjcmlwdD4=' }).src, null);
});
