import {createLedgerContracts} from './ledger-contracts.mjs';
import {createPaymentConfirmationRuntime} from './payment-confirmations.mjs';

export function createClaudePersonalStore(db, uid, { hash, revision = () => crypto.randomUUID(), maxBytes = 60_000, conditionalCommit = null } = {}) {
  if (!db || !uid || typeof hash !== 'function') throw new Error('Personal storage and a viewer identity are required');
  if (conditionalCommit !== null && typeof conditionalCommit !== 'function') throw new Error('A conditional commit must be a host-supplied function');
  const {expandCheckpointMetadata,compactCheckpointMetadata}=createLedgerContracts();
  const confirmations=createPaymentConfirmationRuntime();
  const collection = db.collection('data/users/' + uid), manifest = collection.doc('subsnotes-state-v1');
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  // Databases may reorder object keys. Hash canonical JSON, never insertion
  // order, and discard undefined fields before handing data to the host SDK.
  const canonical = value => JSON.stringify(value, (_,item)=>item&&typeof item==='object'&&!Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item);
  let expected = null, saving = false, uncertain = false;
  const version = value => value?.storageRevision || value?.savedAt || null;
  const verifiedChunks = new Map();
  const verifiedCheckpoints = new Map();
  const verifiedConfirmations = new Map();
  async function hydrateConfirmations(value,fresh) {
    if(!Object.hasOwn(value,'paymentConfirmationChunks')){
      if(Object.hasOwn(value,'paymentConfirmations'))confirmations.validate(value.paymentConfirmations);
      return value;
    }
    const refs=value.paymentConfirmationChunks;
    if(Object.hasOwn(value,'paymentConfirmations')||!Array.isArray(refs)||!refs.length||refs.length>512||new Set(refs).size!==refs.length||refs.some(id=>!/^[a-f0-9]{64}$/.test(id)))throw new Error('Invalid saved confirmation reference');
    const map={};
    for(const id of refs){
      let part=!fresh&&verifiedConfirmations.get(id);
      if(!part){
        const doc=await collection.doc('confirmations-'+id).get();
        if(!doc?.exists||doc.metadata?.hasPendingWrites)throw new Error('A saved confirmation chunk is unavailable');
        part=confirmations.validate(doc.data()?.paymentConfirmations);
        if(!Object.keys(part).length||await hash(canonical(part))!==id)throw new Error('A saved confirmation chunk did not match its reference');
        verifiedConfirmations.set(id,structuredClone(part));
      }
      for(const [key,entry]of Object.entries(part)){
        if(Object.hasOwn(map,key))throw new Error('Saved confirmation chunks contain duplicate identities');
        map[key]=structuredClone(entry);
      }
    }
    for(const id of verifiedConfirmations.keys())if(!refs.includes(id))verifiedConfirmations.delete(id);
    const {paymentConfirmationChunks,...metadata}=value;
    return {...metadata,paymentConfirmations:confirmations.validate(map)};
  }
  const checkpointMap = value => value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([id,record])=>/^[A-Za-z0-9_-]{1,200}$/.test(id)
      && !['__proto__','constructor','prototype'].includes(id) && Array.isArray(record) && [6,7].includes(record.length));
  async function hydrateCheckpoints(value, fresh) {
    if (!Object.hasOwn(value,'sourceProcessingChunks')) return value;
    const refs=value.sourceProcessingChunks;
    if (Object.hasOwn(value,'sourceProcessing') || !Array.isArray(refs) || !refs.length || refs.length > 512
      || new Set(refs).size !== refs.length || refs.some(id=>! /^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid saved checkpoint reference');
    const parts=new Array(refs.length);let cursor=0;
    const read=async()=>{
      while(cursor<refs.length){
        const index=cursor++,id=refs[index];let part=!fresh&&verifiedCheckpoints.get(id);
        if(!part){
          const chunk=await collection.doc('checkpoints-'+id).get();
          if(!chunk?.exists||chunk.metadata?.hasPendingWrites||!checkpointMap(chunk.data()?.sourceProcessing)) throw new Error('A saved checkpoint chunk is unavailable');
          part=chunk.data().sourceProcessing;
          if(!Object.keys(part).length||await hash(canonical(part))!==id) throw new Error('A saved checkpoint chunk did not match its reference');
          verifiedCheckpoints.set(id,structuredClone(part));
        }
        parts[index]=structuredClone(part);
      }
    };
    await Promise.all(Array.from({length:Math.min(4,refs.length)},read));
    const processing={};
    for(const part of parts)for(const [id,record]of Object.entries(part)){
      if(Object.hasOwn(processing,id))throw new Error('Saved checkpoint chunks contain duplicate message identities');
      processing[id]=record;
    }
    for(const id of verifiedCheckpoints.keys())if(!refs.includes(id))verifiedCheckpoints.delete(id);
    const {sourceProcessingChunks,...metadata}=value;
    return {...metadata,sourceProcessing:processing};
  }
  async function load({fresh = false} = {}) {
    if(saving)throw new Error('A save is already running');
    try {
    const snap = await manifest.get();
    if(snap?.metadata?.hasPendingWrites)throw new Error('The saved index has not reached storage yet');
    if (!snap?.exists) { expected = null; uncertain = false; return null; }
    const value = expandCheckpointMetadata(await hydrateConfirmations(await hydrateCheckpoints(snap.data(),fresh),fresh));
    if (Array.isArray(value.events)) {expected=version(value);uncertain=false;return value;} // Existing small histories remain readable.
    if (value.storageFormat !== 'chunks-v1' || !Array.isArray(value.eventChunks)) throw new Error('Unsupported saved record format');
    if (value.eventChunks.length > 512 || value.eventChunks.some(id=>! /^[a-f0-9]{64}$/.test(id))) throw new Error('Invalid saved chunk reference');
    const parts = new Array(value.eventChunks.length); let cursor = 0;
    // Hash-addressed chunks are immutable. Reuse verified content only within
    // this viewer-scoped store; manual refresh can force a source read.
    const read = async () => {
      while (cursor < value.eventChunks.length) {
        const index = cursor++, id = value.eventChunks[index];
        let part = !fresh && verifiedChunks.get(id);
        if (!part) {
          const chunk = await collection.doc('events-' + id).get();
          if (!chunk?.exists || chunk.metadata?.hasPendingWrites || !Array.isArray(chunk.data()?.events)) throw new Error('A saved record chunk is unavailable');
          part = chunk.data().events;
          if (await hash(canonical(part)) !== id) throw new Error('A saved record chunk did not match its reference');
          verifiedChunks.set(id,structuredClone(part));
        }
        parts[index] = structuredClone(part);
      }
    };
    await Promise.all(Array.from({length:Math.min(4,value.eventChunks.length)},read));
    for (const id of verifiedChunks.keys()) if (!value.eventChunks.includes(id)) verifiedChunks.delete(id);
    const events = parts.flat();
    const {eventChunks, storageFormat, ...state} = value;
    expected = version(value); uncertain = false;
    return {...state, events};
    } catch(error) { uncertain=true; throw error; }
  }
  async function persist(state,userConfirmationWrite) {
    if(saving)throw new Error('A save is already running');
    if(uncertain)throw new Error('Storage confirmation is uncertain. Reopen before saving again');
    saving=true;
    try {
    state=JSON.parse(JSON.stringify(state));
    if(!Array.isArray(state.events))throw new Error('An event history is required');
    if(Object.hasOwn(state,'sourceProcessingChunks'))throw new Error('Load the complete saved checkpoints before saving');
    if(Object.hasOwn(state,'paymentConfirmationChunks'))throw new Error('Load the complete saved confirmations before saving');
    const start=await manifest.get();
    if(start?.metadata?.hasPendingWrites)throw new Error('The saved index has not reached storage yet');
    const previous=start?.exists?start.data():null;
    if(version(previous)!==expected)throw new Error('Records changed in another tab. Reopen before syncing again');
    const protectedState=previous?await hydrateConfirmations(previous,false):null;
    const protectedConfirmations=protectedState?.paymentConfirmations??{};
    if(userConfirmationWrite)state.paymentConfirmations=confirmations.validateTransition(protectedConfirmations,state.paymentConfirmations??{});
    else if(Object.hasOwn(protectedState||{},'paymentConfirmations'))state.paymentConfirmations=structuredClone(protectedConfirmations);
    else delete state.paymentConfirmations;
    const chunks = []; let part = [];
    for (const event of state.events || []) {
      if (bytes({events:[event]}) > maxBytes) throw new Error('A source record exceeds the personal storage limit');
      if (part.length && bytes({events:[...part,event]}) > maxBytes) { chunks.push(part); part=[]; }
      part.push(event);
    }
    if (part.length) chunks.push(part);
    if(chunks.length>512)throw new Error('The event history requires too many saved chunks; existing records have been preserved');
    const ids = await Promise.all(chunks.map(chunk=>hash(canonical(chunk))));
    const {events, ...metadata}=state;
    let next={...compactCheckpointMetadata(metadata), storageFormat:'chunks-v1',eventChunks:ids,storageRevision:revision()};
    if(typeof next.storageRevision!=='string'||!next.storageRevision||next.storageRevision===expected)throw new Error('A fresh storage revision is required');
    const checkpointChunks=[];
    if(bytes(next)>maxBytes&&next.sourceProcessing!=null){
      if(!checkpointMap(next.sourceProcessing))throw new Error('The saved checkpoint format cannot be chunked safely');
      let checkpoint={};
      for(const [id,record]of Object.entries(next.sourceProcessing)){
        if(bytes({sourceProcessing:{[id]:record}})>maxBytes)throw new Error('A checkpoint record exceeds the personal storage limit');
        if(Object.keys(checkpoint).length&&bytes({sourceProcessing:{...checkpoint,[id]:record}})>maxBytes){checkpointChunks.push(checkpoint);checkpoint={};}
        checkpoint[id]=record;
      }
      if(Object.keys(checkpoint).length)checkpointChunks.push(checkpoint);
      if(checkpointChunks.length>512)throw new Error('The checkpoint history requires too many saved chunks; existing records have been preserved');
      const refs=await Promise.all(checkpointChunks.map(part=>hash(canonical(part))));
      const {sourceProcessing,...rest}=next;
      next={...rest,sourceProcessingChunks:refs};
    }
    const confirmationChunks=[];
    if(bytes(next)>maxBytes&&next.paymentConfirmations!=null){
      const map=confirmations.validate(next.paymentConfirmations);let part={};
      for(const [id,entry]of Object.entries(map)){
        if(bytes({paymentConfirmations:{[id]:entry}})>maxBytes)throw new Error('A confirmation history exceeds the personal storage limit');
        if(Object.keys(part).length&&bytes({paymentConfirmations:{...part,[id]:entry}})>maxBytes){confirmationChunks.push(part);part={};}
        part[id]=entry;
      }
      if(Object.keys(part).length)confirmationChunks.push(part);
      if(confirmationChunks.length>512)throw new Error('The confirmation history requires too many saved chunks; existing records have been preserved');
      const refs=await Promise.all(confirmationChunks.map(part=>hash(canonical(part))));
      const {paymentConfirmations,...rest}=next;next={...rest,paymentConfirmationChunks:refs};
    }
    if(bytes(next)>maxBytes)throw new Error('The saved index is too large; existing records have been preserved');
    // Immutable content chunks never invalidate the last readable manifest.
    for(const [i,chunk] of chunks.entries()) {
      const ref=collection.doc('events-'+ids[i]);
      await ref.set({events:chunk});
      const confirmed=await ref.get();
      if(!confirmed?.exists||confirmed.metadata?.hasPendingWrites||await hash(canonical(confirmed.data()?.events))!==ids[i])throw new Error('Storage did not confirm the new source records; the old index was kept');
    }
    for(const [i,checkpoint]of checkpointChunks.entries()){
      const id=next.sourceProcessingChunks[i],ref=collection.doc('checkpoints-'+id);
      await ref.set({sourceProcessing:checkpoint});
      const confirmed=await ref.get();
      if(!confirmed?.exists||confirmed.metadata?.hasPendingWrites||await hash(canonical(confirmed.data()?.sourceProcessing))!==id)throw new Error('Storage did not confirm the new checkpoints; the old index was kept');
    }
    for(const [i,part]of confirmationChunks.entries()){
      const id=next.paymentConfirmationChunks[i],ref=collection.doc('confirmations-'+id);
      await ref.set({paymentConfirmations:part});
      const confirmed=await ref.get();
      if(!confirmed?.exists||confirmed.metadata?.hasPendingWrites||await hash(canonical(confirmed.data()?.paymentConfirmations))!==id)throw new Error('Storage did not confirm the new confirmations; the old index was kept');
    }
    const current=await manifest.get();
    if(current?.metadata?.hasPendingWrites)throw new Error('The saved index has not reached storage yet');
    if(version(current?.exists?current.data():null)!==expected)throw new Error('Records changed in another tab. Reopen before syncing again');
    // Ordinary .set is not compare-and-swap. Hosts may inject a separately
    // tested native conditional write; the fallback requires one active writer.
    uncertain=true;
    if(conditionalCommit){
      const committed=await conditionalCommit({expectedRevision:expected,next:structuredClone(next),previous:current?.exists?structuredClone(current.data()):null});
      if(committed!==true)throw new Error('Records changed during the conditional commit. Reopen before syncing again');
    }else await manifest.set(next);
    const confirmed=await manifest.get();
    if(!confirmed?.exists||confirmed.metadata?.hasPendingWrites||version(confirmed.data())!==version(next)||canonical(confirmed.data())!==canonical(next))throw new Error('Storage did not confirm the saved index. Reopen before saving again');
    expected=version(next);uncertain=false;
    return {revision:expected,concurrency:conditionalCommit?'conditional_commit':'single_writer'};
    } finally {saving=false;}
  }
  const save=state=>persist(state,false),saveUserConfirmations=state=>persist(state,true);
  return {load,save,saveUserConfirmations,concurrency:conditionalCommit?'conditional_commit':'single_writer',getRevision:async()=>{const doc=await manifest.get();if(doc?.metadata?.hasPendingWrites)throw new Error('The saved index has not reached storage yet');return version(doc?.exists?doc.data():null);}};
}
