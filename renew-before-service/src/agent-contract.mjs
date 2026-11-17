// Discovery contract, shared by any MCP client. No model or account credentials.
export function getAgentCapabilities({allowProposals=false,transport='in_process'}={}) {
  return {protocol:'subsnotes-agent',version:1,sourceContractVersion:1,models:'host-selected',transport,proposalsEnabled:allowProposals,confirmationsWritable:false,directMailboxAccess:false,backgroundUpdates:false,remoteEndpoint:false,interactiveUi:'local-browser',dashboardTool:'open_dashboard',contractTool:'get_integration_contract'};
}

export function getAgentContract() {
  const ref=name=>({$ref:'#/$defs/'+name});
  const bounded={type:'string',minLength:1,maxLength:200};
  const attachmentIdentity={type:'string',minLength:1,maxLength:2048};
  const day={type:'string',pattern:'^20[0-9]{2}-[0-9]{2}-[0-9]{2}$',description:'A real calendar date. Invoice, received and paid dates are different facts.'};
  const instant={type:'string',format:'date-time'};
  const kinds=['payment_succeeded','invoice_recorded','subscription_confirmed','trial_confirmed','renewal_notice','renewal_disabled','payment_failed','access_expiring','access_expired','access_paused','refund_recorded','refund_pending','one_time_purchase','wallet_top_up','unclassified_purchase','account_not_subscribed'];
  const properties={schemaVersion:{const:1},messageId:bounded,serviceKey:bounded,service:{...bounded,maxLength:300},category:bounded,kind:{enum:kinds},fieldEvidence:{type:'object',additionalProperties:ref('fieldEvidence')}};
  for(const key of ['payment','refund','invoiceAmount','recurringRate','nextCharge'])properties[key]=ref('money');
  for(const key of ['paymentDay','refundDay','invoiceDay','nextBilling','accessEnds','trialEnds','cancelBy'])properties[key]=day;
  for(const key of ['accountRef','lineItemRef','transactionRef','refundRef','reference','plan'])properties[key]=bounded;
  for(const key of ['paymentDateBasis','refundDateBasis'])properties[key]={enum:['explicit','unknown']};
  properties.cadence={enum:['monthly','annual']};
  properties.period={type:'object',additionalProperties:false,required:['start','end'],properties:{start:day,end:day}};
  for(const key of Object.keys(properties))if(!['schemaVersion','messageId','serviceKey','service','kind','fieldEvidence'].includes(key))properties[key]={anyOf:[properties[key],{type:'null'}]};
  const schema={
    $schema:'https://json-schema.org/draft/2020-12/schema',
    title:'SubsNotes assistant result v1',...ref('result'),
    $defs:{
      money:{type:'object',additionalProperties:false,required:['minor','currency'],properties:{minor:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},currency:{type:['string','null'],enum:[...Intl.supportedValuesOf('currency'),null],description:'Use explicit ISO currency or null. A bare $ is not proof of USD. minor uses the currency exponent; keep uncertain amounts unverified.'}}},
      fieldEvidence:{type:'object',additionalProperties:false,required:['quote'],properties:{quote:{type:'string',minLength:1,maxLength:1000},currencyQuote:{type:'string',minLength:1,maxLength:1000},attachmentId:attachmentIdentity}},
      document:{type:'object',additionalProperties:false,required:['sha256','page','parserVersion'],dependentRequired:{recordKey:['start','end'],start:['recordKey','end'],end:['recordKey','start']},properties:{sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},page:{type:'integer',minimum:1,maximum:40},parserVersion:{type:'string',pattern:'^[a-z0-9.-]{1,64}$'},recordKey:{type:'string',pattern:'^[a-f0-9]{64}$'},start:{type:'integer',minimum:0,maximum:199999},end:{type:'integer',minimum:1,maximum:200000}}},
      candidate:{type:'object',additionalProperties:false,required:['schemaVersion','messageId','serviceKey','service','kind','fieldEvidence'],properties},
      observation:{type:'object',additionalProperties:false,required:['messageId','receivedAt','observedAt','text'],properties:{messageId:bounded,receivedAt:instant,observedAt:instant,text:{type:'string',maxLength:4000},mailboxHash:{type:'string',pattern:'^[a-f0-9]{64}$'},attachmentId:attachmentIdentity,document:ref('document')}},
      coverage:{type:'object',additionalProperties:false,required:['queriesComplete','attachmentsComplete','mailboxExhaustive'],properties:{queriesComplete:{type:'boolean'},attachmentsComplete:{type:'boolean'},mailboxExhaustive:{const:false}}},
      result:{type:'object',additionalProperties:false,required:['schemaVersion','kind','requestId','ledgerRevision','records','coverage'],properties:{schemaVersion:{const:1},kind:{const:'subsnotes.assistant-scan-result'},requestId:bounded,ledgerRevision:{anyOf:[bounded,{type:'null'}]},records:{type:'array',maxItems:100,items:{type:'object',additionalProperties:false,required:['candidate','observation'],properties:{candidate:ref('candidate'),observation:ref('observation')}}},coverage:ref('coverage')}}
    }
  };
  const requestSchema={$schema:'https://json-schema.org/draft/2020-12/schema',title:'SubsNotes assistant request v1',type:'object',additionalProperties:false,required:['schemaVersion','kind','requestId','ledgerRevision','language','scope'],properties:{schemaVersion:{const:1},kind:{const:'subsnotes.assistant-scan-request'},requestId:bounded,ledgerRevision:{anyOf:[bounded,{type:'null'}]},language:{enum:['en','zh-TW']},scope:{enum:['new_and_unresolved','all_available_billing_history']}}};
  return {protocol:'subsnotes-agent',version:1,versions:{request:1,result:1,canonicalState:1},requestSchema,resultSchema:schema,limits:{recordsPerResult:100,resultBytes:2_000_000,observationCharacters:4000},
    rules:{assistantReadsSources:true,directMailboxAccess:false,assistantMayConfirmPayments:false,quoteIsSemanticProof:false,unknownFields:'omit; money.currency may be null',missingEvidence:'retain as unverified; never report zero spending',sourceScope:'v1 billing observations reference Gmail messages; assistants and models are unrestricted',documentExtraction:'Use the local assistant:documents prepare/validate CLI for source-matched PDF proposals. It re-extracts original PDFs; a model-supplied quote or verification flag is not a local validation result. Validated proposals still require review.',ledgerBinding:'Server-selected private ledger; request identity and revision must match',confirmationAuthority:'Existing explicit user confirmations are protected; no agent tool can create or erase them',persistence:'Check saved/readback status; dispatch is not completion'}};
}
