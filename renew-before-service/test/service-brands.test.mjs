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
  assert.equal(assets.length,35);
  for (const key of ['openai','linear','vercel','figma','supabase','cursor','hugging-face','jira','trello','confluence','loom','bitbucket']) assert.ok(assets.some(item=>item.key===key));
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
    assert.equal(createHash('sha256').update(svg).digest('hex'), digests[item.key] || item.assetDigest);
    assert.match(svg, /^(?:<\?xml[^?]*\?>\s*)?<svg\b/);
    assert.match(svg, /<\/svg>\s*$/);
    assert.doesNotMatch(svg, /<(?:script|foreignObject|image|use|a|iframe|animate|set)\b|\bon[a-z]+\s*=|\b(?:href|src)\s*=|url\s*\(\s*(?!#[A-Za-z_][\w:-]*\s*\))|<!DOCTYPE|<!ENTITY/i);
    assert.deepEqual([...svg.matchAll(/<(\/?[A-Za-z][A-Za-z0-9]*)\b/g)].map(match => match[1].replace(/^\//,'')).filter(tag => !['svg','path','rect','circle','defs','linearGradient','stop','style'].includes(tag)), []);
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


test('expanded product marks stay exact, scoped, colorful where provided and carry required license copies', () => {
  const brands=createServiceBrandsRuntime();
  for (const name of ['Figma Professional','Supabase Pro','Cursor Pro','Hugging Face Pro','Jira Software','Jira Service Management','Confluence','Trello','Loom','Bitbucket']) {
    const brand=brands.resolve({name});assert.ok(brand.src,name);assert.equal(brand.reviewState,'policy-reviewed');
  }
  for (const name of ['Teams','Assets','Guard','Analytics','ChatGPT clone','Trello Consulting']) assert.equal(brands.resolve({name}).src,null);
  for (const name of ['Cloudflare','Grafana Cloud','Claude']) assert.equal(brands.resolve({name}).reviewState,'permission-required');
  const license=brands.licenses().find(item=>item.id==='Apache-2.0');
  assert.match(license.text,/Apache License/);assert.match(license.text,/END OF TERMS AND CONDITIONS/);
  license.text='mutated';assert.match(brands.licenses()[0].text,/Apache License/);
  const coverage=brands.coverage();assert.equal(coverage.bundled,35);assert.equal(coverage.allDirectoryArtworkIncluded,false);
  const figma=Buffer.from(brands.resolve({name:'Figma'}).src.split(',')[1],'base64').toString('utf8');assert.ok(new Set([...figma.matchAll(/fill="(#[A-F0-9]+)"/gi)].map(match=>match[1])).size>=5);
});
