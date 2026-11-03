import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isIP} from 'node:net';
import {publicConnectorCatalog} from '../src/connector-catalog.mjs';

const email=/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const allowedKeys=['artworkURL','brandWebsite','catalogSource','categories','directoryURL','id','kind','name','platform','slug'];

test('the dated directory includes both platforms and plugin categories without claiming worldwide completeness',()=>{
  const data=publicConnectorCatalog,rows=data.entries;
  assert.equal(data.schemaVersion,1);assert.equal(data.snapshotDate,'2026-11-03');
  assert.equal(rows.length,6605);assert.equal(data.coverage.globallyExhaustive,false);assert.equal(data.coverage.availabilityMayVary,true);
  assert.equal(rows.filter(row=>row.platform==='chatgpt'&&row.kind==='app').length,5018);
  assert.equal(rows.filter(row=>row.platform==='claude'&&row.kind==='connector').length,1059);
  assert.equal(rows.filter(row=>row.platform==='claude'&&row.kind==='plugin').length,528);
  assert.equal(new Set(rows.map(row=>row.platform+'|'+row.kind+'|'+row.id)).size,rows.length);
  assert.equal(new Set(rows.map(row=>row.name.toLowerCase())).size,data.coverage.distinctNames);
  assert.equal(rows.filter(row=>row.artworkURL).length,data.coverage.recordsWithArtwork);
  assert.ok(rows.some(row=>row.name==='Canva'));assert.ok(rows.some(row=>row.name==='Spotify'));
  assert.ok(rows.some(row=>row.name==='Figma'));assert.ok(rows.some(row=>row.name==='Slack'));
});

test('public catalog fields exclude account, installation, authorization and private connection context',()=>{
  for(const row of publicConnectorCatalog.entries){
    assert.deepEqual(Object.keys(row).sort(),allowedKeys);
    assert.ok(row.id&&row.name);assert.ok(Array.isArray(row.categories));
    assert.doesNotMatch(row.name,email);
    for(const key of ['brandWebsite','artworkURL','directoryURL','catalogSource']){
      if(row[key]===null)continue;
      const url=new URL(row[key]);
      assert.equal(url.protocol,'https:');assert.equal(url.username,'');assert.equal(url.password,'');assert.equal(url.hash,'');
      assert.equal(isIP(url.hostname),0);assert.doesNotMatch(url.hostname,/(^|\.)(localhost|local|internal|invalid)$/);
      assert.doesNotMatch(row[key],email);assert.doesNotMatch(row[key],/\/Users\/|^\/home\//);
      const params=[...url.searchParams.keys()];
      assert.ok(params.every(name=>['id','v','domain','sz','format','width','name','raw'].includes(name)));
      if(key!=='artworkURL')assert.equal(params.length,0);
      if(url.hostname==='files.openai.com')assert.ok(params.every(name=>name==='id'||name==='v'));
    }
  }
});

test('directory metadata never mistakes absent artwork or an app listing for a licensed integration',()=>{
  assert.equal(publicConnectorCatalog.entries.filter(row=>row.platform==='claude'&&row.kind==='plugin'&&row.artworkURL!==null).length,0);
  assert.ok(publicConnectorCatalog.entries.some(row=>row.artworkURL===null));
  for(const row of publicConnectorCatalog.entries){
    for(const field of ['licensed','policyReviewed','installed','enabled','isInstalled','connectionStatus','oauth','token','scopes'])assert.equal(Object.hasOwn(row,field),false);
  }
});
