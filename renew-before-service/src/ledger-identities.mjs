import {createLedgerContracts} from './ledger-contracts.mjs';
import {projectPaymentHistory} from './payment-history.mjs';
const contracts=createLedgerContracts();

// Additive, ledger-local joins. These IDs never authenticate a source, grant
// payment authority, rewrite event IDs or replace protected confirmations.
export function projectLedgerIdentities(input,{history=null}={}) {
  const state=contracts.validateCanonicalState(input),events=state.events;
  const eventsById=new Map(events.map(event=>[event.id,event]));
  const vendors=new Map(),accounts=new Map(),subscriptions=new Map(),documents=new Map(),transactions=new Map(),links=new Map();
  const put=(map,id,value)=>{if(!map.has(id))map.set(id,{id,...value});return map.get(id);};
  for(const event of events){
    const vendorId=contracts.identityId('vendor',[event.serviceKey]);
    put(vendors,vendorId,{serviceKey:event.serviceKey,name:event.service,identityBasis:'source_service_key'});
    const accountId=event.accountRef?contracts.identityId('account',[vendorId,event.accountRef]):null;
    if(accountId)put(accounts,accountId,{vendorId,sourceAccountRef:event.accountRef});
    const instance=contracts.instanceReference(event);
    const subscriptionInstanceId=instance?contracts.identityId('subscription',[vendorId,accountId,instance.basis,instance.value,instance.lineItemRef||null]):null;
    if(subscriptionInstanceId)put(subscriptions,subscriptionInstanceId,{vendorId,accountId,sourceReference:instance.value,sourceLineItemRef:instance.lineItemRef||null,identityBasis:instance.basis,legacy:instance.basis==='legacy_line_item'});
    const source=event.sourceDocument;
    const documentId=contracts.identityId('document',[event.messageId,source?.attachmentId||null,source?.sha256||null,source?null:vendorId,source?null:accountId,source?null:event.kind,source?null:event.reference||null]);
    const document=put(documents,documentId,{messageId:event.messageId,attachmentId:source?.attachmentId||null,sha256:source?.sha256||null,sourceEventIds:[],transactionIds:[]});
    document.sourceEventIds.push(event.id);
    links.set(event.id,{eventId:event.id,vendorId,accountId,subscriptionInstanceId,documentId,financialTransactionIds:[],legacyReasons:[...(!accountId?['account_identity_unknown']:[]),...(!instance?['subscription_identity_unknown']:instance.basis==='legacy_line_item'?['legacy_line_item_scope']:[])]});
  }
  for(const row of history||projectPaymentHistory(state)){
    if(!['payment_succeeded','refund_recorded'].includes(row.kind))continue;
    const event=eventsById.get(row.eventId),link=links.get(row.eventId);if(!event||!link)continue;
    const reference=row.kind==='refund_recorded'?event.refundRef:event.transactionRef;
    const transactionId=contracts.identityId('transaction',[link.vendorId,link.accountId,link.subscriptionInstanceId,row.kind,reference?['source_transaction_reference',reference]:['source_event',event.id]]);
    const transaction=put(transactions,transactionId,{vendorId:link.vendorId,accountId:link.accountId,subscriptionInstanceId:link.subscriptionInstanceId,kind:row.kind,identityBasis:reference?'source_transaction_reference':'source_event',sourceReference:reference||null,status:row.status,documentIds:[],sourceEventIds:[]});
    for(const proof of row.documents){
      const sourceLink=links.get(proof.eventId);if(!sourceLink)continue;
      if(!sourceLink.financialTransactionIds.includes(transactionId))sourceLink.financialTransactionIds.push(transactionId);
      if(!transaction.documentIds.includes(sourceLink.documentId))transaction.documentIds.push(sourceLink.documentId);
      if(!transaction.sourceEventIds.includes(proof.eventId))transaction.sourceEventIds.push(proof.eventId);
      const doc=documents.get(sourceLink.documentId);if(!doc.transactionIds.includes(transactionId))doc.transactionIds.push(transactionId);
    }
  }
  const sorted=map=>[...map.values()].map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Array.isArray(v)?[...new Set(v)].sort():v]))).sort((a,b)=>(a.id||a.eventId).localeCompare(b.id||b.eventId));
  return {version:1,scope:'ledger_local',authority:'derived_identity_only',vendors:sorted(vendors),accounts:sorted(accounts),subscriptionInstances:sorted(subscriptions),financialTransactions:sorted(transactions),supportingDocuments:sorted(documents),eventLinks:sorted(links)};
}

// Pure copy migration; the caller must separately choose and authorize storage.
// Unknown legacy identities remain null. No missing contract IDs are invented.
export function withLedgerIdentityIndex(input) {
  contracts.validateCanonicalState(input);
  const copy=structuredClone(input);
  return {...copy,identityIndex:projectLedgerIdentities(copy)};
}
