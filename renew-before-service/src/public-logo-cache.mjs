import fs from 'node:fs/promises';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertPrivateDirectory } from './private-directory.mjs';
import { acquireFileLock } from './file-lock.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const normalize = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim() : '';
const extensions = {'image/svg+xml':'svg','image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'};
const maxFileBytes = 1_048_576, maxInlineBytes = 131_072;
const privateRights = 'source-policy-unreviewed';
// Public directory artwork can use these explicit canonical/CDN redirects.
// This is not a wildcard domain allowance; every destination is still checked.
const artworkRedirects={
  'www.google.com':['t1.gstatic.com','t2.gstatic.com','t3.gstatic.com'],
  'v0.dev':['v0.app'],'www.mermaidchart.com':['mermaid.ai'],'vwo.com':['wingify.com'],
  'invesco.com':['www.invesco.com'],'verisk.com':['www.verisk.com'],'www.trustfull.com':['trustfull.com'],
  'qlik.com':['www.qlik.com'],'fathom.ai':['www.fathom.ai'],'coupler.io':['www.coupler.io'],
  'moodys.com':['www.moodys.com'],'msci.com':['www.msci.com'],'intapp.com':['www.intapp.com'],'appfolio.com':['www.appfolio.com']
};
const canonicalSource = value => { try { const url=new URL(value); return url.protocol==='https:'&&!url.username&&!url.password?url.origin+url.pathname:null; } catch { return null; } };
const identity = row => digest(JSON.stringify([row.platform,row.kind,row.id || row.slug || row.directoryURL,row.name]));

function entriesFor(catalog) {
  if(catalog?.schemaVersion!==1||!Array.isArray(catalog.entries)||catalog.entries.length>20_000)throw new Error('A supported public connector catalog is required');
  const entries=catalog.entries.filter(row=>row&&typeof row.name==='string'&&typeof row.platform==='string'&&typeof row.kind==='string'&&(row.id||row.slug||row.directoryURL));
  if(entries.length!==catalog.entries.length||new Set(entries.map(identity)).size!==entries.length)throw new Error('The public catalog has invalid or duplicate identities');
  return entries;
}

function publicAddress(address) {
  if(isIP(address)===4){const [a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);}
  if(isIP(address)===6)return /^[23][0-9a-f]{3}:/i.test(address)&&!/^2001:(?:db8|0):|^2002:/i.test(address);
  return false;
}
function checkedURL(value,allowedHosts) {
  let url;try{url=new URL(value);}catch{throw new Error('invalid_url');}
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.hash||url.href.length>16_384||!allowedHosts.has(url.hostname)||isIP(url.hostname)||url.hostname.includes(':'))throw new Error('unapproved_origin');
  if([...url.searchParams.keys()].some(key=>/sig|token|auth|secret|password|^cid$|^x-amz-|^x-goog-|^api.key$/i.test(key)))throw new Error('unapproved_origin');
  return url;
}

// DNS answers are checked and pinned to the TLS request, including redirects.
// Cookies, authorization and referrer headers are never sent.
async function requestHTTPS(url,{addresses,timeoutMs,maxBytes}) {
  return new Promise((resolve,reject)=>{
    const request=https.request(url,{method:'GET',headers:{Accept:'image/svg+xml,image/png,image/webp,image/jpeg,image/gif','User-Agent':'SubsNotes-public-logo-cache/1'},lookup:(_host,options,callback)=>options.all?callback(null,addresses):callback(null,addresses[0].address,addresses[0].family)},response=>{
      const status=response.statusCode||0,headers=response.headers;
      if(status!==200){response.destroy();resolve({status,headers,bytes:null});return;}
      if(Number(headers['content-length'])>maxBytes){response.destroy();reject(new Error('too_large'));return;}
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){response.destroy(new Error('too_large'));return;}chunks.push(chunk);});
      response.on('end',()=>resolve({status,headers,bytes:Buffer.concat(chunks)}));response.on('error',()=>reject(new Error(size>maxBytes?'too_large':'network')));
    });
    const timeout=setTimeout(()=>request.destroy(new Error('timeout')),timeoutMs);request.on('close',()=>clearTimeout(timeout));
    request.on('error',error=>reject(new Error(['timeout','too_large'].includes(error.message)?error.message:'network')));request.end();
  });
}

export function validatePublicLogo(bytes,contentType,{maxBytes=maxFileBytes}={}) {
  if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes||[]);
  if(!bytes.length||bytes.length>maxBytes)throw new Error('too_large');
  let mime,width=null,height=null;
  const textStart=bytes.subarray(0,128).toString('utf8').replace(/^\uFEFF/,'').trimStart();
  if(/^<\?xml\s|^<svg\b/i.test(textStart)){
    let svg;try{svg=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{throw new Error('invalid_svg');}
    let inspected;
    try{inspected=svg.replace(/&#(x[0-9a-f]+|\d+);/gi,(_,value)=>String.fromCodePoint(value[0].toLowerCase()==='x'?Number.parseInt(value.slice(1),16):Number(value))).replace(/&(amp|lt|gt|quot|apos);/g,(_,name)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[name]));}catch{throw new Error('unsafe_svg');}
    if(!/^(?:\s*<\?xml\s[^?]*\?>)?\s*<svg\b/i.test(svg)||!/<\/svg>\s*$/i.test(svg)||/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|\\|\bon[a-z]+\s*=|\b(?:href|src)\s*=|@import|@font-face|expression\s*\(|-moz-binding|\b(?:image-set|image|cross-fade|paint|element|canvas)\s*\(|url\s*\(\s*(?!#[A-Za-z_][\w:-]*\s*\))/i.test(inspected))throw new Error('unsafe_svg');
    const tags=[...inspected.matchAll(/<\/?([A-Za-z][\w:-]*)\b/g)].map(match=>match[1]);
    const allowed=new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','defs','linearGradient','radialGradient','stop','clipPath','mask','title','desc','style','metadata']);
    if(tags.some(tag=>!allowed.has(tag)))throw new Error('unsafe_svg');
    mime='image/svg+xml';
  }else if(bytes.length>=33&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'){
    width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);mime='image/png';
    if(bytes.length<12||bytes.toString('ascii',bytes.length-8,bytes.length-4)!=='IEND')throw new Error('invalid_png');
  }else if(bytes.length>=13&&/^GIF8[79]a$/.test(bytes.toString('ascii',0,6))&&bytes.at(-1)===0x3b){width=bytes.readUInt16LE(6);height=bytes.readUInt16LE(8);mime='image/gif';
  }else if(bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length){
    const kind=bytes.toString('ascii',12,16);mime='image/webp';
    if(kind==='VP8X'){width=1+bytes.readUIntLE(24,3);height=1+bytes.readUIntLE(27,3);}
    else if(kind==='VP8L'&&bytes[20]===0x2f){width=1+(((bytes[22]&0x3f)<<8)|bytes[21]);height=1+(((bytes[24]&0xf)<<10)|(bytes[23]<<2)|((bytes[22]&0xc0)>>6));}
    else if(kind==='VP8 '&&bytes[23]===0x9d&&bytes[24]===1&&bytes[25]===0x2a){width=bytes.readUInt16LE(26)&0x3fff;height=bytes.readUInt16LE(28)&0x3fff;}
    else throw new Error('invalid_webp');
  }else if(bytes.length>=4&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes.at(-2)===0xff&&bytes.at(-1)===0xd9){
    mime='image/jpeg';let at=2;
    while(at+4<bytes.length){if(bytes[at]!==0xff)break;const marker=bytes[at+1],size=bytes.readUInt16BE(at+2);if(size<2||at+2+size>bytes.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&size>=7){height=bytes.readUInt16BE(at+5);width=bytes.readUInt16BE(at+7);break;}if(marker===0xda)break;at+=2+size;}
    if(!width||!height)throw new Error('invalid_jpeg');
  }else throw new Error('unsupported_image');
  if(width!==null&&(!width||!height||width>4096||height>4096||width*height>16_777_216))throw new Error('image_dimensions');
  const declared=String(contentType||'').split(';')[0].trim().toLowerCase();
  if(![mime,'application/octet-stream','binary/octet-stream',''].includes(declared))throw new Error('content_type_mismatch');
  return {mime,extension:extensions[mime],bytes:bytes.length,width,height,sha256:digest(bytes),viewEligible:bytes.length<=(mime==='image/svg+xml'?24552:maxInlineBytes)};
}

export async function fetchPublicLogo(value,{allowedHosts,request=requestHTTPS,resolve=lookup,timeoutMs=8000,maxBytes=maxFileBytes,retries=1}={}) {
  if(!(allowedHosts instanceof Set))throw new Error('An explicit public artwork host allowlist is required');
  for(let attempt=0;attempt<=retries;attempt++){
    let current=value;const activeHosts=new Set(allowedHosts);
    try{
      for(let redirect=0;redirect<=3;redirect++){
        const url=checkedURL(current,activeHosts),addresses=await resolve(url.hostname,{all:true,verbatim:true});
        if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw new Error('non_public_address');
        const result=await request(url,{addresses,timeoutMs,maxBytes});
        if([301,302,303,307,308].includes(result.status)){if(redirect===3||!result.headers?.location)throw new Error('redirect_limit');const next=new URL(result.headers.location,url);if(artworkRedirects[url.hostname]?.includes(next.hostname))activeHosts.add(next.hostname);current=next.href;continue;}
        if(result.status!==200){const error=new Error('http_error');error.retryable=result.status===408||result.status===429||result.status>=500;throw error;}
        return {data:result.bytes,...validatePublicLogo(result.bytes,result.headers?.['content-type'],{maxBytes}),sourceURL:canonicalSource(url.href)};
      }
    }catch(error){
      const reason=['invalid_url','unapproved_origin','non_public_address','too_large','unsafe_svg','invalid_svg','invalid_png','invalid_gif','invalid_jpeg','invalid_webp','image_dimensions','content_type_mismatch','unsupported_image','redirect_limit','http_error','timeout','network'].includes(error.message)?error.message:'network';
      if(attempt<retries&&(error.retryable||['network','timeout'].includes(reason))){await new Promise(done=>setTimeout(done,250*(attempt+1)));continue;}
      throw new Error(reason);
    }
  }
}

async function readJSON(path,maxBytes=25_000_000) {
  const stat=await fs.lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes)throw new Error('Use a bounded regular private cache file');
  let value;try{value=JSON.parse(await fs.readFile(path,'utf8'));}catch{throw new Error('Invalid private cache JSON');}return value;
}
async function cacheDirectory(directory,{create=false}={}) {
  const target=await assertPrivateDirectory(directory);if(create)await fs.mkdir(target,{recursive:true,mode:0o700});
  const stat=await fs.lstat(target);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('A private logo cache directory is required');
  for(const entry of await fs.readdir(target,{withFileTypes:true}))if(entry.isSymbolicLink()||!(/^([a-f0-9]{64}\.(svg|png|jpg|webp|gif)|index\.json|\.index-[a-f0-9-]+|\.DS_Store)$/.test(entry.name)||entry.name==='.refresh-lock'&&entry.isDirectory()))throw new Error('The logo cache directory contains unrelated files');
  if(create)await fs.chmod(target,0o700);return target;
}
async function readAsset(directory,entry) {
  if(!/^[a-f0-9]{64}\.(?:svg|png|jpg|webp|gif)$/.test(entry.file||'')||!Object.hasOwn(extensions,entry.mime))throw new Error('Invalid cached logo reference');
  const path=join(directory,entry.file),stat=await fs.lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxFileBytes)throw new Error('Invalid cached logo file');
  const data=await fs.readFile(path),info=validatePublicLogo(data,entry.mime);
  if(info.sha256!==entry.sha256||entry.file!==info.sha256+'.'+info.extension)throw new Error('Cached logo integrity check failed');return {data,...info};
}
async function writeIndex(directory,index) {
  const text=JSON.stringify(index),temp=join(directory,'.index-'+randomUUID());
  await fs.writeFile(temp,text,{flag:'wx',mode:0o600});await fs.rename(temp,join(directory,'index.json'));
  if(JSON.stringify(await readJSON(join(directory,'index.json')))!==text)throw new Error('Logo cache index readback failed');
}
export async function cachePublicLogos({directory,catalog,request,resolve,onProgress=()=>{},maxTotalBytes=256*1024*1024}={}) {
  const entries=entriesFor(catalog),target=await cacheDirectory(directory,{create:true}),release=await acquireFileLock(target);
  try{
    let previous=null;try{previous=await readJSON(join(target,'index.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(previous&&(previous.version!==1||!previous.entries||Array.isArray(previous.entries)))throw new Error('Unsupported logo cache index');
    const allowedHosts=new Set(['assets.claude.com','files.openai.com','chatgpt.com']);
    for(const row of entries){try{const url=new URL(row.artworkURL);if(url.protocol==='https:'&&!url.username&&!url.password&&!isIP(url.hostname))allowedHosts.add(url.hostname);}catch{}}
    const validKeys=new Set(entries.map(identity));
    const retained=Object.fromEntries(Object.entries(previous?.entries||{}).filter(([key])=>validKeys.has(key)).map(([key,row])=>[key,{...row,sourceURL:canonicalSource(row.sourceURL)}]));
    const index={version:1,catalogSnapshot:catalog.snapshotDate||null,createdAt:new Date().toISOString(),completed:false,rightsStatus:privateRights,entries:retained};
    const counts={downloaded:0,cached:0,missing:0,rejected:0,failed:0,budgetLimited:0,bytes:0,total:entries.length};let cursor=0,completed=0,checkpoint=Promise.resolve();
    const work=async()=>{while(cursor<entries.length){const row=entries[cursor++],key=identity(row),old=previous?.entries?.[key];let record={key,name:row.name,platform:row.platform,kind:row.kind,directoryURL:canonicalSource(row.directoryURL),catalogSource:canonicalSource(row.catalogSource),rightsStatus:privateRights,status:'missing'};
      try{
        if(old?.file){const {data,...asset}=await readAsset(target,old);if(counts.bytes+asset.bytes>maxTotalBytes){record.status='budget_limited';counts.budgetLimited++;}else{counts.bytes+=asset.bytes;record={...record,...asset,file:old.file,sourceURL:canonicalSource(old.sourceURL),fetchedAt:old.fetchedAt||null,status:'cached'};counts.cached++;}}
        else{const url=row.artworkURL;
          if(!url)counts.missing++;
          else if(counts.bytes>=maxTotalBytes){record.status='budget_limited';counts.budgetLimited++;}
          else{const asset=await fetchPublicLogo(url,{allowedHosts,request,resolve});if(counts.bytes+asset.bytes>maxTotalBytes){record.status='budget_limited';counts.budgetLimited++;}
            else{const {data,...info}=asset,file=info.sha256+'.'+info.extension;counts.bytes+=info.bytes;
              try{try{await fs.writeFile(join(target,file),data,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;await readAsset(target,{...info,file});}}
              catch(error){counts.bytes-=info.bytes;throw error;}
              record={...record,...info,file,status:'downloaded',fetchedAt:new Date().toISOString()};counts.downloaded++;}}
        }
      }catch(error){record.status=['network','timeout','http_error'].includes(error.message)?'failed':'rejected';record.reason=['network','timeout','http_error','unapproved_origin','non_public_address','too_large','unsafe_svg','invalid_svg','invalid_png','invalid_jpeg','invalid_webp','image_dimensions','content_type_mismatch','unsupported_image','redirect_limit'].includes(error.message)?error.message:'cache_or_image_rejected';counts[record.status]++;}
      index.entries[key]=record;completed++;try{onProgress({...counts,completed});}catch{/* Progress output cannot authorize or alter a download. */}
      if(completed%50===0){const snapshot=clone({...index,counts});checkpoint=checkpoint.then(()=>writeIndex(target,snapshot));await checkpoint;}
    }};
    await Promise.all(Array.from({length:Math.min(4,entries.length)},work));await checkpoint;index.completed=true;index.counts={...counts};await writeIndex(target,index);return clone(index.counts);
  }finally{await release();}
}

export async function loadPublicLogoCache(directory,{catalog,bundled,requests=[]}={}) {
  const entries=entriesFor(catalog),target=await cacheDirectory(directory),index=await readJSON(join(target,'index.json'));
  if(index.version!==1||!index.entries||Array.isArray(index.entries)||typeof bundled?.resolve!=='function')throw new Error('A supported logo cache and bundled catalog are required');
  const aliases=new Map(),byKey=new Map(entries.map(row=>[identity(row),row]));
  for(const row of entries)for(const value of [row.id,row.slug,row.name,...(row.aliases||[])]){const alias=normalize(value);if(alias){if(!aliases.has(alias))aliases.set(alias,new Set());aliases.get(alias).add(identity(row));}}
  const owner=row=>{try{return new URL(row.brandWebsite).hostname.toLowerCase().replace(/^www\./,'')||null;}catch{return null;}};
  const choose=input=>{
    const matches=aliases.get(normalize(input.serviceKey))||aliases.get(normalize(input.name));if(!matches)return null;
    // A text-only plugin entry is not evidence of a conflicting image owner.
    const candidates=[...matches].filter(key=>index.entries[key]?.file&&index.entries[key].viewEligible===true);
    const owners=new Set(candidates.map(key=>owner(byKey.get(key))).filter(Boolean));
    if(owners.size>1)return null;
    if(owners.size===1)return candidates.find(key=>owner(byKey.get(key))===[...owners][0])||null;
    if(candidates.length===1)return candidates[0];
    return candidates.length&&new Set(candidates.map(key=>index.entries[key].sha256)).size===1?candidates[0]:null;
  };
  const wanted=new Set(requests.filter(input=>!bundled.resolve(input).src).map(choose).filter(Boolean)),images=new Map(),used=new Set();
  for(const key of wanted){try{const asset=await readAsset(target,index.entries[key]);if(asset.viewEligible)images.set(key,{...asset,src:'data:'+asset.mime+';base64,'+asset.data.toString('base64')});}catch{/* Optional images never suppress a subscription. */}}
  return Object.freeze({
    resolve(input={}){const fallback=bundled.resolve(input);if(fallback.src)return fallback;const key=choose(input),asset=images.get(key),row=byKey.get(key);if(!asset||!row)return fallback;used.add(key);return {...fallback,key:fallback.key||'public-catalog:'+key,label:row.name,src:asset.src,assetSource:canonicalSource(index.entries[key].sourceURL),reviewState:fallback.reviewState==='not-reviewed'?privateRights:fallback.reviewState,catalogAssetState:'private-cache',license:fallback.license||'Directory-provided artwork; owner policy unreviewed; not included in the source-code license',attribution:fallback.attribution||row.name+' artwork belongs to its owner; privately cached from the public directory.'};},
    notices:()=>[...(bundled.notices?.()||[]),...[...used].map(key=>({attribution:byKey.get(key).name+' artwork belongs to its owner; private directory cache; owner policy is not established.'}))],
    coverage:()=>({...(bundled.coverage?.()||{}),privateCached:Object.values(index.entries).filter(row=>row.file).length,selectedImages:images.size,cacheUpdateComplete:index.completed!==false,allDirectoryArtworkIncluded:false})
  });
}
