import { createInitialState } from './data.js';
import { loadState, saveState, updateSubscription, updatePreferences, addFeedback, getAttention } from './domain.js';
import { renderApp, renderOverlay } from './views.js';

const routes = new Set(['landing','overview','subscriptions','reminders']);
const route = () => { const value=location.hash.slice(1); return routes.has(value)?value:'landing'; };
let storage;
try { storage = window.localStorage; } catch { storage = null; }
let state = loadState(storage);
const ui = {view:route(),filter:'all',query:'',sort:'date',period:'monthly',modal:null,scanStep:0,scanDone:false,rating:0,feedbackMessage:'',showEvidence:false};
let scanTimer, toastTimer, openerSelector;
let persistenceFailed = !storage;
const app = document.getElementById('app');
const overlay = document.getElementById('overlay');
const toast = document.getElementById('toast');

function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message + (persistenceFailed ? ' (Temporary storage only; refreshing may reset your changes.)' : '');
  const dialog=overlay.querySelector('dialog[open]');
  toast.hidden = Boolean(dialog);
  if(dialog){
    let status=dialog.querySelector('.dialog-status');
    if(!status){status=document.createElement('p');status.className='dialog-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');dialog.append(status);}
    status.textContent=toast.textContent;
  }
  toastTimer = setTimeout(()=>{toast.hidden=true;},6500);
}
function persist() {
  const saved = saveState(storage,state);
  persistenceFailed = saved===false || !storage;
  return !persistenceFailed;
}
function focusKey(element) {
  if (!element || !element.matches) return null;
  if (element.name) return `[name="${CSS.escape(element.name)}"]`;
  if (element.dataset.action) {
    let key=`[data-action="${CSS.escape(element.dataset.action)}"]`;
    for (const name of ['id','view','filter','value','period']) if (element.dataset[name]) key+=`[data-${name}="${CSS.escape(element.dataset[name])}"]`;
    return key;
  }
  return element.id?`#${CSS.escape(element.id)}`:null;
}
function render({preserveFocus=false,mainFocus=false}={}) {
  const active = document.activeElement;
  const key = preserveFocus?focusKey(active):null;
  const selection = active && typeof active.selectionStart==='number'?[active.selectionStart,active.selectionEnd]:null;
  app.innerHTML=renderApp(state,ui);
  const priorDialog=overlay.querySelector('dialog');
  if(priorDialog?.open) priorDialog.close();
  overlay.innerHTML=renderOverlay(state,ui);
  const dialog=overlay.querySelector('dialog');
  if (dialog) {
    dialog.showModal();
    dialog.addEventListener('cancel',event=>{event.preventDefault();closeModal();});
    dialog.addEventListener('keydown',event=>{
      if(event.key!=='Tab')return;
      const controls=[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')].filter(element=>element.getClientRects().length>0);
      const first=controls[0],last=controls.at(-1);
      if(!first)return;
      if(event.shiftKey&&(document.activeElement===first||!controls.includes(document.activeElement))){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&(document.activeElement===last||!controls.includes(document.activeElement))){event.preventDefault();first.focus();}
    });
    dialog.addEventListener('click',event=>{
      if(event.target!==dialog)return;
      const bounds=dialog.getBoundingClientRect();
      if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom) closeModal();
    });
    document.body.classList.add('modal-open');
  } else document.body.classList.remove('modal-open');
  const target=key && (dialog||document).querySelector(key);
  if(target) {
    target.focus({preventScroll:true});
    if(selection && target.setSelectionRange) try {target.setSelectionRange(...selection);}catch{}
  } else if(mainFocus) document.querySelector('#main-content')?.focus({preventScroll:true});
  const titles={landing:'Make every renewal a choice',overview:'Overview',subscriptions:'Subscriptions',reminders:'Reminder settings'};
  document.title=`${titles[ui.view]} · SubsNotes`;
}
function openModal(modal) {
  openerSelector=focusKey(document.activeElement);
  ui.modal=modal;
  ui.showEvidence=false;
  render();
}
function closeModal() {
  clearInterval(scanTimer);
  ui.modal=null;
  render();
  const opener=openerSelector?[...document.querySelectorAll(openerSelector)].find(element=>element.getClientRects().length>0):null;
  (opener||document.querySelector('#main-content'))?.focus({preventScroll:true});
}
function navigate(view) {
  if(!routes.has(view))return;
  clearInterval(scanTimer);
  ui.modal=null;
  ui.view=view;
  if(location.hash!==`#${view}`) history.pushState(null,'',`#${view}`);
  render({mainFocus:true});
  window.scrollTo({top:0,behavior:'instant'});
}
function runScan() {
  ui.scanStep=0;ui.scanDone=false;
  openModal({type:'scan'});
  clearInterval(scanTimer);
  scanTimer=setInterval(()=>{
    if(ui.modal?.type!=='scan'){clearInterval(scanTimer);return;}
    ui.scanStep+=1;
    if(ui.scanStep>=3){ui.scanDone=true;clearInterval(scanTimer);}
    render({preserveFocus:true});
  },850);
}
function downloadJSON() {
  const blob=new Blob([ui.exportText],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');link.href=url;link.download='renew-before-demo-feedback.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
  notify('Download requested. You can also copy the JSON below and share it with your facilitator.');
}
function openExport(){
  ui.exportText=JSON.stringify({demo:true,exportedAt:new Date().toISOString(),notice:'Demo data and locally saved feedback. Nothing is sent automatically.',...state},null,2);
  openModal({type:'export'});
}
document.addEventListener('click',event=>{
  if(event.target.closest('.skip-link')){event.preventDefault();document.querySelector('#main-content')?.focus();return;}
  const button=event.target.closest('[data-action]');
  if(!button||button.disabled)return;
  if(button.tagName==='A')event.preventDefault();
  const {action,id}=button.dataset;
  switch(action) {
    case 'navigate':navigate(button.dataset.view);break;
    case 'detail':openModal({type:'subscription',id});break;
    case 'close-modal':closeModal();break;
    case 'filter':ui.filter=button.dataset.filter;if(ui.view==='overview')navigate('subscriptions');else render({preserveFocus:true});break;
    case 'reset-filters':ui.filter='all';ui.query='';render({mainFocus:true});break;
    case 'period':ui.period=button.dataset.period;render({preserveFocus:true});break;
    case 'scan':runScan();break;
    case 'scan-finish':navigate('overview');notify(`Demo scan complete: reviewed ${state.subscriptions.length} sample subscriptions. No inbox was connected.`);break;
    case 'evidence':ui.showEvidence=!ui.showEvidence;render({preserveFocus:true});break;
    case 'reminder-settings':navigate('reminders');break;
    case 'keep':
    case 'cancel-intent':
    case 'simulate-cancel':
    case 'resolve-payment': {
      state=updateSubscription(state,id,action);persist();render({preserveFocus:true});
      const messages={keep:'Recorded your decision to keep this subscription. Reminder preferences still apply. No real subscription was changed.','cancel-intent':'Recorded your intention not to renew. It is not cancelled yet. Continue to try the simulated confirmation.','simulate-cancel':'Auto-renewal turned off in this demo. Remaining access follows the sample terms. No real account was changed.','resolve-payment':'Payment issue marked as resolved in this demo. No real payment was processed.'};
      notify(messages[action]);break;
    }
    case 'feedback':ui.rating=0;ui.feedbackMessage='';openModal({type:'feedback'});break;
    case 'rating':ui.rating=Number(button.dataset.value);render({preserveFocus:true});break;
    case 'reset':openModal({type:'reset'});break;
    case 'confirm-reset':state=createInitialState();persist();ui.filter='all';ui.query='';ui.period='monthly';navigate('overview');notify('Sample subscriptions, reminder preferences, and local feedback have been reset.');break;
    case 'export':openExport();break;
    case 'download-json':downloadJSON();break;
    case 'copy-export':
      navigator.clipboard?.writeText(ui.exportText).then(()=>notify('JSON copied. You can now share it with your facilitator.')).catch(()=>{overlay.querySelector('#export-json')?.select();notify('Use your keyboard copy shortcut to copy the selected JSON.');});
      if(!navigator.clipboard){overlay.querySelector('#export-json')?.select();notify('Use your keyboard copy shortcut to copy the selected JSON.');}
      break;
    case 'preview-notification':{
      const next=getAttention(state)[0];
      notify(next?`[Preview only · Not sent] ${next.name} needs attention. Your reminder is set for ${state.preferences.days} days before renewal. Open its details for next steps.`:'[Preview only · Not sent] Nothing needs attention right now.');break;
    }
  }
});
document.addEventListener('input',event=>{
  if(event.target.name==='query') {ui.query=event.target.value;render({preserveFocus:true});}
  if(event.target.name==='message') ui.feedbackMessage=event.target.value;
});
document.addEventListener('change',event=>{
  if(event.target.name==='sort'){ui.sort=event.target.value;render({preserveFocus:true});}
  if(event.target.name==='filter'){ui.filter=event.target.value;render({preserveFocus:true});}
});
document.addEventListener('submit',event=>{
  const form=event.target.closest('[data-form]');if(!form)return;event.preventDefault();
  const data=new FormData(form);
  if(form.dataset.form==='preferences'){
    state=updatePreferences(state,{days:Number(data.get('days')),email:data.has('email'),weekly:data.has('weekly'),quiet:data.has('quiet')});
    const saved=persist();render({preserveFocus:true});notify(saved?'Reminder preferences saved in this browser. This demo does not send notifications.':'Reminder preferences updated. This demo does not send notifications.');
  }
  if(form.dataset.form==='feedback'){
    const message=String(data.get('message')||'').trim();
    if(!ui.rating){notify('Choose a rating first.');overlay.querySelector('[data-action="rating"]')?.focus();return;}
    if(!message){notify('Add a short comment to help us understand your experience.');form.querySelector('textarea')?.focus();return;}
    state=addFeedback(state,{rating:ui.rating,message:message.slice(0,2000),view:ui.view,createdAt:new Date().toISOString()});
    const saved=persist();closeModal();notify(saved?'Feedback saved locally, not sent. Use Export data & feedback to share it.':'Feedback held temporarily, not sent. Export it before refreshing.');
  }
});
window.addEventListener('popstate',()=>{ui.view=route();ui.modal=null;clearInterval(scanTimer);render({mainFocus:true});});
window.addEventListener('hashchange',()=>{if(ui.view!==route()){ui.view=route();ui.modal=null;render({mainFocus:true});}});
render();
if(!storage)notify('Temporary storage mode: refreshing may reset the demo data.');
