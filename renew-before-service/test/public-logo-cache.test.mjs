import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {validatePublicLogo,fetchPublicLogo,cachePublicLogos,loadPublicLogoCache} from '../src/public-logo-cache.mjs';
import {createServiceBrandsRuntime} from '../src/service-brands.mjs';
import {createSubscriptionViewRuntime} from '../src/subscription-view.mjs';
import {runLogoCache} from '../scripts/cache-service-logos.mjs';

const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="#0a0"/></svg>');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=','base64');
const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
// Synthetic DNS results only: no network requests use these injected fixtures.
const publicDnsFixture=[8,8,8,8].join('.');
const address=async()=>[{address:publicDnsFixture,family:4}];
const response=(bytes=svg,mime='image/svg+xml')=>({status:200,headers:{'content-type':mime},bytes});
const catalog=(rows)=>({schemaVersion:1,snapshotDate:'2026-11-03',entries:rows.map((row,i)=>({platform:'claude',kind:'connector',id:'public-'+i,name:'Fictional '+i,slug:'fictional-'+i,brandWebsite:'https://vendor'+i+'.invalid',directoryURL:'https://claude.ai/directory/public-'+i,catalogSource:'https://claude.com/marketplace/connectors-plugins',artworkURL:'https://assets.claude.com/icon-'+i+'.svg',...row}))});
const temp=()=>fs.mkdtemp(join(tmpdir(),'subsnotes-logo-cache-'));

test('logo validation checks passive SVG, raster signatures, dimensions, type and bounds',()=>{
  assert.equal(validatePublicLogo(svg,'image/svg+xml').mime,'image/svg+xml');
  assert.deepEqual([validatePublicLogo(png,'image/png').width,validatePublicLogo(png,'image/png').height],[1,1]);
  assert.equal(validatePublicLogo(gif,'image/gif').mime,'image/gif');
  assert.throws(()=>validatePublicLogo(png,'text/html'),/content_type_mismatch/);
  assert.throws(()=>validatePublicLogo(Buffer.from('<html>Not an image</html>'),'image/svg+xml'),/unsupported_image/);
  assert.throws(()=>validatePublicLogo(svg,'image/svg+xml',{maxBytes:4}),/too_large/);
  const huge=Buffer.from(png);huge.writeUInt32BE(100000,16);assert.throws(()=>validatePublicLogo(huge,'image/png'),/image_dimensions/);
  for(const inner of ['<script>alert(1)</script>','<foreignObject/>','<image href="https://example.invalid/a"/>','<path onload="alert(1)"/>','<style>@import "https://example.invalid/a";</style>','<path style="fill:url(https://example.invalid/a)"/>','<style>p{background:u\\72l(https://example.invalid)}</style>','<path style="fill:&#117;rl(https://example.invalid/a)"/>','<style>@impor&#116; "https://example.invalid/a";</style>'])assert.throws(()=>validatePublicLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'+inner+'</svg>'),'image/svg+xml'),/unsafe_svg/);
});

test('passive SVG validation rejects CSS resource functions including entity-disguised image-set',()=>{
  for(const value of ['image-set("https://tracking.example/p.png" 1x)','-webkit-image-set("https://tracking.example/p.png" 1x)','image("https://tracking.example/p.png")','cross-fade("https://tracking.example/a.png", "https://tracking.example/b.png", 50%)','-webkit-cross-fade("https://tracking.example/p.png",red,50%)','paint(custom-worklet)','element(private-canvas)','-moz-element(private-canvas)','-webkit-canvas(private-canvas)','&#105;mage-set(&quot;https://tracking.example/p.png&quot; 1x)']){
    const bytes=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><style>svg{background-image:'+value+'}</style><rect width="1" height="1"/></svg>');
    assert.throws(()=>validatePublicLogo(bytes,'image/svg+xml'),/unsafe_svg/);
  }
});

test('concurrent new logo writes reserve the total byte budget before awaiting filesystem writes',async()=>{
  const dir=await temp();try{
    const data=catalog([{name:'Budget first'},{name:'Budget second'}]);
    const counts=await cachePublicLogos({directory:dir,catalog:data,request:async()=>response(),resolve:address,maxTotalBytes:svg.length});
    assert.equal(counts.downloaded,1);assert.equal(counts.budgetLimited,1);assert.equal(counts.bytes,svg.length);
    const index=JSON.parse(await fs.readFile(join(dir,'index.json'),'utf8'));assert.equal(Object.values(index.entries).filter(row=>row.file).length,1);assert.equal(index.counts.bytes,svg.length);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a failed asset write returns its reserved bytes so a later valid logo can use the budget',async()=>{
  const dir=await temp(),original=fs.writeFile;let failed=false,releaseSecond;
  try{
    fs.writeFile=async(path,...args)=>{if(String(path).endsWith('.svg')&&!failed){failed=true;const error=new Error('Synthetic asset write failure');error.code='EACCES';throw error;}return original(path,...args);};
    const data=catalog([{name:'Write failure'},{name:'Write success'}]);
    const counts=await cachePublicLogos({directory:dir,catalog:data,resolve:address,maxTotalBytes:svg.length,request:async url=>url.pathname.includes('0.svg')?response():new Promise(done=>{releaseSecond=()=>done(response());}),onProgress:counts=>{if(counts.completed===1)releaseSecond();}});
    assert.equal(counts.rejected,1);assert.equal(counts.downloaded,1);assert.equal(counts.budgetLimited,0);assert.equal(counts.bytes,svg.length);
  }finally{fs.writeFile=original;await fs.rm(dir,{recursive:true,force:true});}
});

test('HTTPS artwork requests reject credentials, signatures, private DNS and unapproved redirects before disclosure',async()=>{
  const allowedHosts=new Set(['assets.claude.com']);let calls=0;
  const request=async()=>{calls++;return response();};
  for(const url of ['http://assets.claude.com/a.svg','https://user:pass@assets.claude.com/a.svg','https://assets.claude.com/a.svg?sig=test-signature','https://attacker.invalid/a.svg','https://assets.claude.com:8443/a.svg'])await assert.rejects(fetchPublicLogo(url,{allowedHosts,request,resolve:address}),/invalid_url|unapproved_origin/);
  assert.equal(calls,0);
  const nonPublicFixtures=[[127,0,0,1].join('.'),[10,0,0,1].join('.'),[169,254,169,254].join('.'),'::1',['','','ffff',[127,0,0,1].join('.')].join(':'),['fd00','','1'].join(':'),'2001:db8::1'];
  for(const ip of nonPublicFixtures)await assert.rejects(fetchPublicLogo('https://assets.claude.com/a.svg',{allowedHosts,request,resolve:async()=>[{address:ip,family:ip.includes(':')?6:4}]}),/non_public_address/);
  assert.equal(calls,0);
  await assert.rejects(fetchPublicLogo('https://assets.claude.com/a.svg',{allowedHosts,resolve:address,request:async()=>{calls++;return{status:302,headers:{location:'https://attacker.invalid/logo.svg'}};}}),/unapproved_origin/);
  assert.equal(calls,1);
  const asset=await fetchPublicLogo('https://assets.claude.com/a.svg?width=128',{allowedHosts,resolve:address,request});
  assert.equal(asset.sourceURL,'https://assets.claude.com/a.svg');assert.equal(asset.mime,'image/svg+xml');
});

test('the complete public snapshot is cached privately with bounded concurrency, immutable assets and signed-free provenance',async()=>{
  const dir=await temp();try{
    let running=0,peak=0,calls=0;
    const request=async()=>{calls++;running++;peak=Math.max(peak,running);await new Promise(done=>setTimeout(done,5));running--;return response();};
    const data=catalog(Array.from({length:9},(_,i)=>({artworkURL:i===8?null:'https://assets.claude.com/'+i+'.svg?w=128'})));
    const counts=await cachePublicLogos({directory:dir,catalog:data,request,resolve:address});
    assert.equal(counts.downloaded,8);assert.equal(counts.missing,1);assert.equal(calls,8);assert.ok(peak<=4&&peak>1);
    const index=JSON.parse(await fs.readFile(join(dir,'index.json'),'utf8'));
    assert.equal(Object.keys(index.entries).length,9);assert.equal(index.rightsStatus,'source-policy-unreviewed');
    assert.ok(Object.values(index.entries).filter(row=>row.sourceURL).every(row=>!row.sourceURL.includes('?')));
    const files=await fs.readdir(dir);assert.equal(files.filter(name=>name.endsWith('.svg')).length,1);
    if(process.platform!=='win32'){assert.equal((await fs.stat(dir)).mode&0o777,0o700);assert.equal((await fs.stat(join(dir,'index.json'))).mode&0o777,0o600);assert.equal((await fs.stat(join(dir,files.find(name=>name.endsWith('.svg'))))).mode&0o777,0o600);}
    const again=await cachePublicLogos({directory:dir,catalog:data,request:async()=>{throw Error('Unexpected repeated network request');},resolve:address});
    assert.equal(again.cached,8);assert.equal(again.downloaded,0);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('only explicit public artwork canonical redirects can extend one request allowlist',async()=>{
  const allowedHosts=new Set(['www.google.com']);let calls=0;
  const request=async url=>{calls++;return url.hostname==='www.google.com'?{status:301,headers:{location:'https://t1.gstatic.com/icon.png'}}:response(png,'image/png');};
  const asset=await fetchPublicLogo('https://www.google.com/s2/favicons?domain=example.invalid',{allowedHosts,request,resolve:address});
  assert.equal(calls,2);assert.equal(asset.sourceURL,'https://t1.gstatic.com/icon.png');assert.deepEqual([...allowedHosts],['www.google.com']);
  await assert.rejects(fetchPublicLogo('https://www.google.com/s2/favicons',{allowedHosts,resolve:address,request:async()=>({status:301,headers:{location:'https://t4.gstatic.com/icon.png'}})}),/unapproved_origin/);
  await assert.rejects(fetchPublicLogo('https://www.google.com/s2/favicons',{allowedHosts,resolve:address,request:async()=>({status:301,headers:{location:'https://t1.gstatic.com/icon.png?sig=test-signature'}})}),/unapproved_origin/);
  await assert.rejects(fetchPublicLogo('https://www.google.com/s2/favicons',{allowedHosts,resolve:async host=>[{address:host==='t1.gstatic.com'?'127.0.0.1':publicDnsFixture,family:4}],request}),/non_public_address/);
});

test('invalid downloads and cache integrity failures are visible without replacing good immutable images',async()=>{
  const dir=await temp();try{
    const data=catalog([{name:'Fictional safe'},{name:'Fictional unsafe'},{name:'Fictional absent',artworkURL:null}]);
    const counts=await cachePublicLogos({directory:dir,catalog:data,resolve:address,request:async url=>url.pathname.includes('1.svg')?response(Buffer.from('<svg><script/></svg>')):response()});
    assert.equal(counts.downloaded,1);assert.equal(counts.rejected,1);assert.equal(counts.missing,1);
    const good=(await fs.readdir(dir)).find(name=>name.endsWith('.svg'));await fs.writeFile(join(dir,good),Buffer.from('altered'));
    const brands=await loadPublicLogoCache(dir,{catalog:data,bundled:createServiceBrandsRuntime(),requests:[{name:'Fictional safe'}]});
    assert.equal(brands.resolve({name:'Fictional safe'}).src,null);
    const before=await fs.readFile(join(dir,good));await cachePublicLogos({directory:dir,catalog:data,resolve:address,request:async()=>response()});assert.deepEqual(await fs.readFile(join(dir,good)),before);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a cache refresh retains previously available logos while later public artwork requests are pending',async()=>{
  const dir=await temp();try{
    const old=catalog(Array.from({length:55},(_,i)=>({name:'Existing '+i})));
    await cachePublicLogos({directory:dir,catalog:old,resolve:address,request:async()=>response()});
    const next={...old,entries:[{...old.entries[0],id:'new',name:'New public logo',slug:'new-public',artworkURL:'https://assets.claude.com/new.svg'},...old.entries]};
    let release,verified=false,verification;
    const refreshing=cachePublicLogos({directory:dir,catalog:next,resolve:address,request:async()=>new Promise(done=>{release=()=>done(response());}),onProgress:counts=>{
      if(counts.completed>=50&&!verification)verification=(async()=>{
        try{
        for(let i=0;i<100;i++){const current=JSON.parse(await fs.readFile(join(dir,'index.json'),'utf8'));if(current.completed===false)break;await new Promise(done=>setTimeout(done,1));}
        const brands=await loadPublicLogoCache(dir,{catalog:next,bundled:createServiceBrandsRuntime(),requests:[{name:'Existing 54'}]});
        assert.ok(brands.resolve({name:'Existing 54'}).src);assert.equal(brands.coverage().cacheUpdateComplete,false);verified=true;
        }finally{release();}
      })();
      void verification?.catch(()=>{});
    }});
    await refreshing;await verification;assert.equal(verified,true);
    assert.equal(JSON.parse(await fs.readFile(join(dir,'index.json'),'utf8')).completed,true);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('cache reads embed only requested exact matches, keep reviewed assets first and reject ambiguous aliases',async()=>{
  const dir=await temp();try{
    const data=catalog([{name:'Fictional Notes'},{name:'Same',slug:'same',brandWebsite:'https://one.invalid'},{name:'Same',slug:'same',brandWebsite:'https://two.invalid'},{name:'Claude',slug:'claude'},{name:'OpenAI',slug:'openai'}]);
    await cachePublicLogos({directory:dir,catalog:data,resolve:address,request:async()=>response(png,'image/png')});
    const bundled=createServiceBrandsRuntime(),brands=await loadPublicLogoCache(dir,{catalog:data,bundled,requests:[{name:'Fictional Notes'},{name:'Same'},{name:'Claude'},{name:'OpenAI'}]});
    assert.match(brands.resolve({name:'Fictional Notes'}).src,/^data:image\/png;base64,/);
    assert.equal(brands.resolve({name:'Fictional Notes'}).reviewState,'source-policy-unreviewed');
    assert.equal(brands.resolve({name:'Same'}).src,null);assert.equal(brands.resolve({name:'Fictional Notes clone'}).src,null);
    assert.equal(brands.resolve({name:'Claude'}).reviewState,'permission-required');
    assert.equal(brands.resolve({name:'OpenAI'}).src,bundled.resolve({name:'OpenAI'}).src);
    const snapshot={kind:'subsnotes.read-view',version:1,mode:'read-only',rows:[{name:'Fictional Notes',providerServiceKey:'fictional-0',status:'needs_verification',sources:[]}],selection:{},coverage:{},totals:{}};
    const html=createSubscriptionViewRuntime({brands}).renderInlineHTML(snapshot);
    assert.match(html,/data:image\/png;base64,/);assert.doesNotMatch(html,/>Same<|one\.invalid|two\.invalid/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('cache paths reject repository, unrelated files and symlinks; invalid JSON never echoes its contents',async()=>{
  await assert.rejects(cachePublicLogos({directory:resolve(import.meta.dirname,'../dist/test-logo-cache'),catalog:catalog([])}),/outside the source repository/);
  const dir=await temp(),other=await temp();try{
    await fs.writeFile(join(dir,'keep.txt'),'user data');await assert.rejects(cachePublicLogos({directory:dir,catalog:catalog([])}),/unrelated files/);assert.equal(await fs.readFile(join(dir,'keep.txt'),'utf8'),'user data');
    await fs.rm(join(dir,'keep.txt'));await fs.writeFile(join(other,'index.json'),'private raw malformed payload');await fs.symlink(join(other,'index.json'),join(dir,'index.json'));
    await assert.rejects(cachePublicLogos({directory:dir,catalog:catalog([])}),/unrelated files/);
    await fs.rm(join(dir,'index.json'));await fs.writeFile(join(dir,'index.json'),'private raw malformed payload');
    await assert.rejects(cachePublicLogos({directory:dir,catalog:catalog([])}),error=>/Invalid private cache JSON/.test(error.message)&&!error.message.includes('private raw'));
  }finally{await fs.rm(dir,{recursive:true,force:true});await fs.rm(other,{recursive:true,force:true});}
});

test('text-only plugins and unknown-site copies do not hide one cached known-owner image; true owner conflicts still fall back',async()=>{
  const dir=await temp();try{
    const data=catalog([
      {name:'Fictional Notes',slug:'notes',brandWebsite:'https://www.notes.invalid'},
      {name:'Fictional Notes',slug:'notes-plugin',kind:'plugin',brandWebsite:null,artworkURL:null},
      {name:'Fictional Notes',slug:'notes-copy',brandWebsite:null},
      {name:'Fictional Team',slug:'team-one',brandWebsite:'https://team.invalid'},
      {name:'Fictional Team',slug:'team-two',brandWebsite:'https://www.team.invalid'},
      {name:'Fictional Conflict',slug:'conflict-one',brandWebsite:'https://first.invalid'},
      {name:'Fictional Conflict',slug:'conflict-two',brandWebsite:'https://second.invalid'},
      {name:'Fictional Same',slug:'same-one',brandWebsite:null},
      {name:'Fictional Same',slug:'same-two',brandWebsite:null},
      {name:'Fictional Unknown',slug:'unknown-one',brandWebsite:null},
      {name:'Fictional Unknown',slug:'unknown-two',brandWebsite:null}
    ]);
    await cachePublicLogos({directory:dir,catalog:data,resolve:address,request:async url=>url.pathname.includes('10.svg')||url.pathname.includes('2.svg')?response(png,'image/png'):response()});
    const brands=await loadPublicLogoCache(dir,{catalog:data,bundled:createServiceBrandsRuntime(),requests:['Fictional Notes','Fictional Team','Fictional Conflict','Fictional Same','Fictional Unknown'].map(name=>({name}))});
    assert.match(brands.resolve({name:'Fictional Notes'}).src,/^data:image\/svg\+xml;/);
    assert.match(brands.resolve({name:'Fictional Team'}).src,/^data:image\/svg\+xml;/);
    assert.equal(brands.resolve({name:'Fictional Conflict'}).src,null);
    assert.match(brands.resolve({name:'Fictional Same'}).src,/^data:image\/svg\+xml;/);
    assert.equal(brands.resolve({name:'Fictional Unknown'}).src,null);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('the cache CLI requires explicit complete-public-catalog scope and never accepts subscription filters',async()=>{
  let called=0;const api={catalog:catalog([]),cache:async()=>{called++;return{total:0};}};
  await assert.rejects(runLogoCache(['--directory','/private/cache'],api),/all-public-catalog/);
  await assert.rejects(runLogoCache(['--all-public-catalog','--directory','/private/cache','--service','Claude'],api),/all-public-catalog/);
  assert.equal(called,0);assert.deepEqual(await runLogoCache(['--help'],api),{help:true});
  assert.deepEqual(await runLogoCache(['--all-public-catalog','--directory','/private/cache'],api),{total:0});assert.equal(called,1);
});
