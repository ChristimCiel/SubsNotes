import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractWebEvidence } from '../src/web-evidence.mjs';
import { createPaymentConfirmationRuntime } from '../src/payment-confirmations.mjs';

// Entirely fictional records. This fixture never reads a mailbox or a ledger.
export async function syntheticConfirmationFixture({ confirmed = true } = {}) {
  const messages = Array.from({length:10},(_,i)=>({
    id:'demo-openai-mail-'+String(i+1).padStart(2,'0'), sender:'noreply@tax.openai.com',
    subject:'Your eGUI DEMO-'+String(i+1).padStart(2,'0')+' from OpenAI',
    date:`2026-${String(i+1).padStart(2,'0')}-12T10:00:00Z`,
    plaintextBody:'An invoice has been prepared for your fictional ChatGPT purchase. Review your original invoice document.'
  }));
  const events=[];
  for(const [i,m]of messages.entries()) {
    const parsed=await extractWebEvidence({id:m.id,sender:m.sender,subject:m.subject,text:m.plaintextBody,receivedAt:m.date,sourceFormat:'claude_plaintext',sourceReadAt:'2026-11-01T10:00:00Z'});
    if(parsed.length!==1)throw new Error('The fictional invoice fixture must produce one source record');
    events.push({...parsed[0],kind:'invoice_recorded',serviceKey:'chatgpt',service:'ChatGPT',category:'AI tools',
      invoiceAmount:{currency:'USD',minor:1700+i*100},invoiceDay:m.date.slice(0,10),reference:'DEMO-INVOICE-'+(i+1),plan:'Fictional monthly plan',cadence:'monthly',
      payment:null,paymentDay:null,paymentDateBasis:'unknown',evidence:'Invoice amount · USD '+(17+i)+'.00',
      receiptVerification:{checkedAt:'2026-11-01T10:00:00Z',fields:['kind','serviceKey','service','category','invoiceAmount','invoiceDay','reference','plan','cadence','payment','paymentDay','paymentDateBasis','evidence'],sources:[]}});
  }
  for(const [name,key,minor,cadence]of [['Claude','claude',2300,'monthly'],['Figma','figma',1600,'monthly'],['Notion','notion',8400,'annual']]) {
    const id='demo-'+key+'-receipt',date='2026-10-16T10:00:00Z';
    const plaintextBody=`${name} subscription. Amount paid USD ${(minor/100).toFixed(2)}. Paid October 16, 2026. Invoice number DEMO-${key.toUpperCase()}. Billing period October 16, 2026 – ${cadence==='annual'?'October 15, 2027. Billed annually':'November 15, 2026'}.`;
    const message={id,sender:'billing@'+({claude:'anthropic.com',figma:'figma.com',notion:'notion.so'}[key]),subject:'Your '+name+' subscription receipt',date,plaintextBody};
    messages.push(message);
    const parsed=await extractWebEvidence({id,sender:message.sender,subject:message.subject,text:plaintextBody,receivedAt:date,sourceFormat:'claude_plaintext',sourceReadAt:'2026-11-01T10:00:00Z'});
    if(parsed.length!==1||parsed[0].kind!=='payment_succeeded'||parsed[0].serviceKey!==key||parsed[0].cadence!==cadence)throw new Error('The fictional receipt fixture must replay one matching subscription payment');
    events.push(parsed[0]);
  }
  let state={version:1,syntheticDemo:true,events,scannedIds:[],prefs:{language:'en',currency:'USD',month:'all',view:'payments',autoRefresh:false,includeSpamTrash:false,reviews:{}}};
  if(confirmed) {
    const runtime=createPaymentConfirmationRuntime();
    state=runtime.set(state,{eventId:events[0].id,precision:'day',date:'2026-01-14',amount:events[0].invoiceAmount,expectedRevision:0},{now:'2026-11-01T10:01:00Z'});
    state=runtime.set(state,{eventId:events[1].id,precision:'month',month:'2026-02',amount:events[1].invoiceAmount,expectedRevision:0},{now:'2026-11-01T10:02:00Z'});
  }
  return {state,messages};
}

// The native QA variant delegates ONLY storage/user identity to Claude. Gmail
// is always simulated, and an existing non-demo ledger is never initialized.
export function createSyntheticDemoBridge({fixture,nativeHost,createStore,i18n}) {
  const key='subsnotes-fictional-confirmations-v1';
  const clone=x=>structuredClone(x);
  let storage=null;try{storage=window.localStorage;}catch{/* Explicit temporary mode below. */}
  let persistenceFailed=!storage;
  let initialLanguage=i18n.normalizeLanguage(new URLSearchParams(location.search).get('lang'));
  let docs=new Map(),initialized=null;
  if(!nativeHost) {
    try { const saved=JSON.parse(storage?.getItem(key)||'null');if(saved?.syntheticDemo===true&&Array.isArray(saved.documents))docs=new Map(saved.documents); }catch{persistenceFailed=true;/* Keep a corrupt demo separate from real data. */}
    if(!docs.size)docs.set('subsnotes-state-v1',{...clone(fixture.state),prefs:{...fixture.state.prefs,language:initialLanguage}});
  }
  const persist=()=>{try{if(!storage)throw new Error('Browser storage unavailable');storage.setItem(key,JSON.stringify({syntheticDemo:true,documents:[...docs]}));persistenceFailed=false;}catch{persistenceFailed=true;}paint();};
  const db={collection(name){if(!name.startsWith('data/users/'))throw new Error('Unexpected demo namespace');return{doc(id){return{
    get:async()=>({exists:docs.has(id),data:()=>clone(docs.get(id))}),
    set:async value=>{docs.set(id,clone(value));persist();}
  };}};}};
  const hash=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
  async function nativeDatabase() {
    if(!initialized)initialized=(async()=>{
      const [realDb,user]=await Promise.all([nativeHost.use('db'),nativeHost.use('user')]);
      const uid=await user.id(),store=createStore(realDb,uid,{hash});
      const current=await store.load();
      if(current&&!current.syntheticDemo)throw new Error('Existing records are not a fictional demo. No data was changed.');
      if(!current)await store.save({...clone(fixture.state),prefs:{...fixture.state.prefs,language:initialLanguage}});
      return realDb;
    })();
    return initialized;
  }
  const mcp={async callTool(server,tool,args){
    if(server!=='Gmail')throw new Error('Reference rates are unavailable in this fictional demo');
    if(tool==='search_threads') {
      if(args.query==='in:sent from:me')return{payload:{threads:[{id:'demo-sent-thread',messages:[{id:'demo-sent-mail',sender:'demo@example.invalid'}]}]}};
      const after=args.query.match(/after:(\d+)/)?.[1],before=args.query.match(/before:(\d+)/)?.[1];
      const filtered=fixture.messages.filter(m=>(!after||Date.parse(m.date)/1000>Number(after))&&(!before||Date.parse(m.date)/1000<Number(before)));
      const offset=Number(args.pageToken||0),size=args.pageSize||10,part=filtered.slice(offset,offset+size),next=offset+size<filtered.length?String(offset+size):null;
      return{payload:{threads:part.map(m=>({id:m.id,messages:[{id:m.id,sender:m.sender}]})),nextPageToken:next,resultCountEstimate:next?filtered.length:part.length}};
    }
    if(tool==='get_message') {const m=fixture.messages.find(m=>m.id===args.messageId);if(!m)throw new Error('Fictional source not found');return{payload:clone(m)};}
    throw new Error('Unsupported fictional tool');
  }};
  let banner;
  const language=()=>document.documentElement.lang||initialLanguage;
  const paint=()=>{if(banner){banner.querySelector('span').textContent=i18n.t(nativeHost?'demoNativeBanner':'demoBanner',language())+(!nativeHost&&persistenceFailed?' '+i18n.t('demoTemporary',language()):'');banner.setAttribute('aria-label',i18n.t(nativeHost?'demoNativeBanner':'demoBanner',language()));banner.querySelector('button').textContent=i18n.t('demoReset',language());}};
  banner=document.createElement('aside');banner.className='demo-banner';banner.setAttribute('aria-label','Fictional demo');
  const label=document.createElement('span'),reset=document.createElement('button');reset.type='button';banner.append(label,reset);document.body.prepend(banner);
  reset.hidden=Boolean(nativeHost);
  reset.addEventListener('click',()=>{if(window.confirm(i18n.t('demoResetConfirm',language()))){try{storage?.removeItem(key);}catch{}location.reload();}});
  new MutationObserver(paint).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});paint();
  document.addEventListener('click',event=>{const a=event.target.closest?.('a');if(a?.href?.startsWith('https://mail.google.com/')){event.preventDefault();window.alert(i18n.t('demoSource',language()));}});
  return{use:async name=>name==='db'?(nativeHost?nativeDatabase():db):name==='user'?(nativeHost?nativeHost.use('user'):{id:async()=>'fictional-demo'}):name==='mcp'?mcp:name==='permissions'?{}:null};
}

export async function buildConfirmationDemo(html,{nativeStorage=false,confirmed=true}={}) {
  const fixture=await syntheticConfirmationFixture({confirmed});
  const marker='\nmountClaudeDashboard({';
  if(html.split(marker).length!==2)throw new Error('Expected one dashboard entrypoint');
  const escaped=JSON.stringify(fixture).replaceAll('<','\\u003c');
  const bootstrap=`\nconst createSyntheticDemoBridge = ${createSyntheticDemoBridge.toString()};\nconst demoHost = createSyntheticDemoBridge({fixture:${escaped},nativeHost:${nativeStorage?'window.claude':'null'},createStore:createClaudePersonalStore,i18n:createI18nRuntime()});`;
  const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if(script.length!==1)throw new Error('Expected one compiled runtime');
  const source=script[0][1].replaceAll('window.claude','demoHost').replace(marker,()=>bootstrap+marker);
  const page=html.replace(script[0][0],()=>nativeStorage?'<script>'+source+'</script>':'<script src="./confirmations.js"></script>')
    .replace('</head>','<style>.demo-banner{font:12px/1.5 system-ui;display:flex;align-items:center;justify-content:center;gap:16px;padding:9px 14px;background:#f7e9c8;color:#4f3d13;border-bottom:1px solid #decb9d}.demo-banner button{font:inherit;min-height:30px;padding:3px 9px;background:#fffaf0;color:#4f3d13;border:1px solid #b6a16b;border-radius:6px}.demo-banner button[hidden]{display:none}</style></head>');
  return {html:page,script:source,fixture};
}

async function main(){
  const root=resolve(import.meta.dirname,'..'),html=await readFile(resolve(root,'dist/subsnotes-claude.html'),'utf8');
  const demo=await buildConfirmationDemo(html),directory=resolve(root,'../renew-before-demo/dist');
  await mkdir(directory,{recursive:true});
  await writeFile(resolve(directory,'confirmations.html'),demo.html);await writeFile(resolve(directory,'confirmations.js'),demo.script);
  console.log('Created the fictional confirmation demo. Its Gmail tools are simulated and data stays in browser storage.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
