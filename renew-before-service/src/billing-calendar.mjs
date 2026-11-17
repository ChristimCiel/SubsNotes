// Civil billing dates stay in their source calendar. Only explicit instants
// are converted; email arrival is never a substitute for a transaction date.
export const BILLING_TIME_ZONE='Asia/Taipei';
export function billingDay(value){
  if(typeof value!=='string')return null;
  if(/^20\d{2}-\d{2}-\d{2}$/.test(value))return Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value?value:null;
  if(!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!billingDay(value.slice(0,10))||!Number.isFinite(Date.parse(value)))return null;
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:BILLING_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  return ['year','month','day'].map(type=>parts.find(p=>p.type===type).value).join('-');
}
export function validateBillingMonth(month){
  if(month!==null&&!/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month))throw new Error('Use a calendar month in YYYY-MM format');
  return month;
}
export const belongsToBillingMonth=(day,month)=>month===null||billingDay(day)?.slice(0,7)===month;
