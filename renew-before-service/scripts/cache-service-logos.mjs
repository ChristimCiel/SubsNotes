import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { cachePublicLogos } from '../src/public-logo-cache.mjs';

export async function runLogoCache(args,{catalog,cache=cachePublicLogos,progress=()=>{}}={}) {
  let directory=null,all=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--help')return {help:true};
    if(args[i]==='--all-public-catalog'&&!all)all=true;
    else if(args[i]==='--directory'&&!directory&&args[i+1]&&!args[i+1].startsWith('--'))directory=args[++i];
    else throw new Error('Use --all-public-catalog --directory PRIVATE_DIRECTORY');
  }
  if(!all||!directory)throw new Error('Use --all-public-catalog --directory PRIVATE_DIRECTORY');
  return cache({directory,catalog,onProgress:progress});
}

export async function main(args=process.argv.slice(2)) {
  const {publicConnectorCatalog}=await import('../src/connector-catalog.mjs');
  let last=Date.now();
  const result=await runLogoCache(args,{catalog:publicConnectorCatalog,progress:counts=>{if(Date.now()-last>30_000){last=Date.now();console.error(`Public catalog: ${counts.completed}/${counts.total}; ${counts.downloaded} downloaded, ${counts.cached} reused, ${counts.failed+counts.rejected} unavailable or rejected.`);}}});
  if(result.help)console.log('Cache public directory artwork privately: --all-public-catalog --directory PRIVATE_DIRECTORY. Downloads the complete catalog snapshot, never a subscription-selected list. No account, key or authorization header is used. Images and provenance remain outside the repository; owner rights are not cleared by public availability. Use --logo-cache PRIVATE_DIRECTORY with the read-view CLI to embed only locally cached matching images.');
  else console.log(JSON.stringify({scope:'all-public-catalog',...result,artworkRightsReviewed:false}));
}
const invokedPath=process.argv[1]?await realpath(process.argv[1]).catch(()=>null):null;
if(invokedPath&&import.meta.url===pathToFileURL(invokedPath).href)main().catch(()=>{console.error('Logo cache operation failed. Use a private directory outside the repository and check cache integrity, permissions and available storage.');process.exitCode=1;});
