import {readFile,realpath} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createFileAgentAccess} from './agent-file-store.mjs';
import {createAgentDashboardServer} from './agent-dashboard-server.mjs';
import {defaultAgentDirectory} from './agent-mcp.mjs';

// Optional launcher for hosts without a browser-opening tool. Same private
// store; no mailbox/model credentials or hosted account service.
export async function launchAgentDashboard({directory=defaultAgentDirectory(),allowEdits=false}={}) {
  const html=await readFile(new URL('./agent-dashboard.html',import.meta.url),'utf8');
  return createAgentDashboardServer({access:createFileAgentAccess({directory,allowProposals:allowEdits}),html,allowUserEdits:allowEdits,allowProposals:allowEdits});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(process.argv[1])).href){
  const args=process.argv.slice(2);let directory=process.env.SUBSNOTES_DATA_DIR||defaultAgentDirectory(),allowEdits=process.env.SUBSNOTES_ALLOW_PROPOSALS==='1';
  for(let i=0;i<args.length;i++){
    if(args[i]==='--data-dir'&&args[i+1])directory=args[++i];
    else if(args[i]==='--allow-edits')allowEdits=true;
    else if(args[i]==='--read-only')allowEdits=false;
    else throw new Error('Usage: npm run dashboard -- [--data-dir /private/directory] [--allow-edits|--read-only]');
  }
  const dashboard=await launchAgentDashboard({directory,allowEdits});
  console.log('Open your private SubsNotes dashboard on this computer:\n'+dashboard.url+'\nKeep this process running. Refresh reads saved data; it does not scan Gmail.');
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;await dashboard.close();};
  process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
}
