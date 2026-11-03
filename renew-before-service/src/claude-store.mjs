import {createLedgerContracts} from './ledger-contracts.mjs';

export function createClaudePersonalStore(db, uid, { hash, revision = () => crypto.randomUUID(), maxBytes = 60_000, conditionalCommit = null } = {}) {
  if (!db || !uid || typeof hash !== 'function') throw new Error('Personal storage and a viewer identity are required');
  if (conditionalCommit !== null && typeof conditionalCommit !== 'function') throw new Error('A conditional commit must be a host-supplied function');
  const {expandCheckpointMetadata,compactCheckpointMetadata}=createLedgerContracts();
  const collection = db.collection('data/users/' + uid), manifest = collection.doc('subsnotes-state-v1');
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  // Databases may reorder object keys. Hash canonical JSON, never insertion
  // order, and discard undefined fields before handing data to the host SDK.
  const canonical = value => JSON.stringify(value, (_,item)=>item&&typeof item==='object'&&!Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item);
  let expected = null, saving = false, uncertain = false;
  const version = value => value?.storageRevision || value?.savedAt || null;
  const verifiedChunks = new Map();
  async function load({fresh = false} = {}) {
    if(saving)throw new Error('A save is already running');
    const snap = await manifest.get();
    if(snap?.metadata?.hasPendingWrites)throw new Error('The saved index has not reached storage yet');
    if (!snap?.exists) { expected = null; uncertain = false; return null; }
    const value = expandCheckpointMetadata(snap.data());
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
  }
  async function save(state) {
    if(saving)throw new Error('A save is already running');
    if(uncertain)throw new Error('Storage confirmation is uncertain. Reopen before saving again');
    saving=true;
    try {
    state=JSON.parse(JSON.stringify(state));
    if(!Array.isArray(state.events))throw new Error('An event history is required');
    const chunks = []; let part = [];
    for (const event of state.events || []) {
      if (bytes({events:[event]}) > maxBytes) throw new Error('A source record exceeds the personal storage limit');
      if (part.length && bytes({events:[...part,event]}) > maxBytes) { chunks.push(part); part=[]; }
      part.push(event);
    }
    if (part.length) chunks.push(part);
    const ids = await Promise.all(chunks.map(chunk=>hash(canonical(chunk))));
    const {events, ...metadata}=state;
    const next={...compactCheckpointMetadata(metadata), storageFormat:'chunks-v1',eventChunks:ids,storageRevision:revision()};
    if(typeof next.storageRevision!=='string'||!next.storageRevision||next.storageRevision===expected)throw new Error('A fresh storage revision is required');
    if(bytes(next)>maxBytes)throw new Error('The saved index is too large; existing records have been preserved');
    // Immutable content chunks never invalidate the last readable manifest.
    for(const [i,chunk] of chunks.entries()) {
      const ref=collection.doc('events-'+ids[i]);
      await ref.set({events:chunk});
      const confirmed=await ref.get();
      if(!confirmed?.exists||confirmed.metadata?.hasPendingWrites||await hash(canonical(confirmed.data()?.events))!==ids[i])throw new Error('Storage did not confirm the new source records; the old index was kept');
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
  return {load,save,concurrency:conditionalCommit?'conditional_commit':'single_writer',getRevision:async()=>{const doc=await manifest.get();if(doc?.metadata?.hasPendingWrites)throw new Error('The saved index has not reached storage yet');return version(doc?.exists?doc.data():null);}};
}
