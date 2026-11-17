import {createServer} from 'node:http';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';

const token=()=>randomBytes(32).toString('base64url');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const fail=code=>{const error=new Error(code);error.code=code;throw error;};
const page=()=>({items:[],total:0,nextOffset:null});

// A private local viewer, not a remote account service. The server-selected
// access object owns the ledger boundary; URLs can never select a file/profile.
export async function createAgentDashboardServer({access,html,allowUserEdits=false,allowProposals=false}={}) {
  if(!access||typeof access.invoke!=='function'||typeof html!=='string'||typeof allowUserEdits!=='boolean'||typeof allowProposals!=='boolean')throw new Error('Invalid local dashboard configuration');
  const bootstrap=token(),session=token(),cookieName='subsnotes_session_'+randomBytes(8).toString('hex');
  const scriptHashes=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>"'sha256-"+createHash('sha256').update(m[1]).digest('base64')+"'");
  const headers={
    'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY','Cross-Origin-Resource-Policy':'same-origin',
    'Content-Security-Policy':"default-src 'none'; script-src 'self' "+scriptHashes.join(' ')+"; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'"
  };
  let origin,host;
  const setup=initialized=>({initialized,proposalsEnabled:allowProposals,canConfirmPayments:allowUserEdits&&typeof access.userAction==='function'});
  const json=(response,status,payload,extra={})=>{response.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8',...extra});response.end(JSON.stringify(payload));};
  function authenticated(request){
    const values=String(request.headers.cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(cookieName+'='));
    return values.length===1&&equal(values[0].slice(cookieName.length+1),session);
  }
  function queries(url,allowed){if([...url.searchParams.keys()].some(k=>!allowed.includes(k))||allowed.some(k=>url.searchParams.getAll(k).length>1))fail('agent_dashboard_query_invalid');}
  function pagination(url){
    const args={};for(const key of ['offset','limit'])if(url.searchParams.has(key)){
      const raw=url.searchParams.get(key);if(!/^\d+$/.test(raw))fail('agent_page_invalid');const n=Number(raw);
      if(!Number.isSafeInteger(n)||n<(key==='limit'?1:0)||key==='limit'&&n>100)fail('agent_page_invalid');args[key]=n;
    }return args;
  }
  async function body(request){
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type']||''))fail('agent_dashboard_content_type_invalid');
    if(Number(request.headers['content-length'])>16_384)fail('agent_dashboard_body_too_large');
    let size=0;const chunks=[];
    for await(const chunk of request){size+=chunk.length;if(size>16_384)fail('agent_dashboard_body_too_large');chunks.push(chunk);}
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('agent_dashboard_body_invalid');}
    if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).some(k=>['__proto__','constructor','prototype'].includes(k)))fail('agent_dashboard_body_invalid');
    return result;
  }
  function empty(method){
    const common={ledgerRevision:null,setup:setup(false)};
    if(method==='dashboard')return {...common,protocol:'subsnotes-agent',version:1,services:page(),counts:{events:0,establishedServices:0,discoveredServices:0,held:0,conflicts:0,excludedPayments:0},spending:{recordedPaidMinorByCurrency:{},sourcePaidMinorByCurrency:{},userConfirmedPaidMinorByCurrency:{},userConfirmedCount:0,bankReconciled:false,coverage:'incomplete',exclusions:page()},coverage:null,limits:'No ledger has been saved yet. No source scan has been completed; no records does not mean zero spending.'};
    if(method==='syncStatus')return {...common,status:'ready',coverage:null,backgroundUpdates:false};
    return {...common,...page(),...(method==='evidence'?{conflicts:page()}:{})};
  }
  async function read(method,args){
    try{const result=await access.invoke(method,args);return {...result,setup:setup(true)};}
    catch(error){if(error.code==='agent_store_uninitialized')return empty(method);throw error;}
  }
  const server=createServer(async(request,response)=>{
    try{
      if(request.headers.host!==host||request.headers.origin!==undefined&&request.headers.origin!==origin){json(response,403,{error:{code:'agent_dashboard_origin_denied'}});return;}
      if(typeof request.url!=='string'||!request.url.startsWith('/')||request.url.startsWith('//')){json(response,404,{error:{code:'agent_dashboard_route_missing'}});return;}
      const url=new URL(request.url,origin);
      if(request.method==='GET'&&url.pathname==='/'&&!url.search){response.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8'});response.end(html);return;}
      if(request.method==='POST'){
        if(request.headers.origin!==origin||request.headers['x-subsnotes-request']!=='1'){json(response,403,{error:{code:'agent_dashboard_csrf_denied'}});return;}
        queries(url,[]);
        if(url.pathname==='/api/session'){
          const input=await body(request);
          if(Object.keys(input).length!==1||!equal(input.token,bootstrap)){json(response,401,{error:{code:'agent_dashboard_session_denied'}});return;}
          json(response,200,{connected:true,setup:setup(null)},{'Set-Cookie':cookieName+'='+session+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'});return;
        }
      }
      if(!url.pathname.startsWith('/api/')){json(response,404,{error:{code:'agent_dashboard_route_missing'}});return;}
      if(!authenticated(request)){json(response,401,{error:{code:'agent_dashboard_session_required'}});return;}
      if(request.method==='GET'){
        let method,args={};
        if(url.pathname==='/api/dashboard'){
          queries(url,['month']);method='dashboard';if(url.searchParams.has('month')){const month=url.searchParams.get('month');if(!/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month))fail('agent_month_invalid');args.month=month;}
        }else if(url.pathname==='/api/billing'){
          queries(url,['view','month','offset','limit']);method='billingRecords';args=pagination(url);
          if(url.searchParams.has('view'))args.view=url.searchParams.get('view');
          if(url.searchParams.has('month'))args.month=url.searchParams.get('month');
          if(args.view!==undefined&&!['payments','invoices','history'].includes(args.view)||args.month!==undefined&&!/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(args.month))fail('agent_billing_query_invalid');
        }else if(url.pathname==='/api/subscriptions'){queries(url,['month','offset','limit']);method='listSubscriptions';args=pagination(url);if(url.searchParams.has('month')){args.month=url.searchParams.get('month');if(!/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(args.month))fail('agent_month_invalid');}}
        else if(url.pathname==='/api/evidence'){
          queries(url,['serviceKey','month','eventId','offset','limit']);method='evidence';args=pagination(url);args.serviceKey=url.searchParams.get('serviceKey');if(typeof args.serviceKey!=='string'||!args.serviceKey||args.serviceKey.length>300)fail('agent_service_invalid');
          if(url.searchParams.has('month')){args.month=url.searchParams.get('month');if(!/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(args.month))fail('agent_month_invalid');}
          if(url.searchParams.has('eventId')){args.eventId=url.searchParams.get('eventId');if(!args.eventId||args.eventId.length>500)fail('agent_evidence_query_invalid');}
        }else if(url.pathname==='/api/sync'){queries(url,[]);method='syncStatus';}
        else{json(response,404,{error:{code:'agent_dashboard_route_missing'}});return;}
        json(response,200,await read(method,args));return;
      }
      if(request.method==='POST'&&['/api/confirm','/api/preferences'].includes(url.pathname)){
        if(!allowUserEdits||typeof access.userAction!=='function'){json(response,403,{error:{code:'agent_user_edits_disabled'}});return;}
        const input=await body(request);
        if(url.pathname==='/api/preferences'&&(Object.keys(input).some(k=>k!=='language')||!['en','zh-TW'].includes(input.language)))fail('agent_dashboard_preferences_invalid');
        const result=await access.userAction(url.pathname==='/api/confirm'?'confirm':'preferences',input);
        json(response,200,result);return;
      }
      json(response,404,{error:{code:'agent_dashboard_route_missing'}});
    }catch(error){
      const code=/^(?:agent|assistant|confirmation)_[a-z_]+$/.test(error.code||'')?error.code:'agent_operation_failed';
      const status=code==='agent_dashboard_body_too_large'?413:code.endsWith('_stale')||code==='confirmation_duplicate'?409:code.endsWith('_invalid')||code==='confirmation_future'?400:503;
      if(!response.headersSent)json(response,status,{error:{code},saved:null});else response.end();
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  host='127.0.0.1:'+server.address().port;origin='http://'+host;
  const url=origin+'/#token='+bootstrap;
  const close=()=>new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections?.();});
  return {url,close,server};
}
