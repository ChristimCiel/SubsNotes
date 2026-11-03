import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createEvidenceRuntime } from '../src/evidence-runtime.mjs';
import { extractWebEvidence } from '../src/web-evidence.mjs';
import { createCashflowRuntime } from '../src/cashflow.mjs';
import { createFxRuntime } from '../src/fx.mjs';
import { createClaudeGmailClient } from '../src/claude-gmail.mjs';
import { createClaudeRatesClient } from '../src/claude-rates.mjs';
import { createWebSync, createSourceEvidenceMerger } from '../src/web-sync.mjs';
import { mountClaudeDashboard } from '../src/claude-dashboard.mjs';
import { createClaudePersonalStore } from '../src/claude-store.mjs';
import { mergeAssistantEvidence } from '../src/assistant-update.mjs';
import { prepareAssistantSync } from '../src/assistant-sync.mjs';
import { preserveReceiptVerification } from '../src/receipt-verification.mjs';
import { createLedgerContracts } from '../src/ledger-contracts.mjs';
import { createSubscriptionViewRuntime } from '../src/subscription-view.mjs';
import { createServiceBrandsRuntime } from '../src/service-brands.mjs';

const names={createServiceBrandsRuntime,createLedgerContracts,createSubscriptionViewRuntime,preserveReceiptVerification,createSourceEvidenceMerger,createEvidenceRuntime,extractWebEvidence,createCashflowRuntime,createFxRuntime,createClaudeGmailClient,createClaudeRatesClient,createWebSync,createClaudePersonalStore,mergeAssistantEvidence,prepareAssistantSync,mountClaudeDashboard};
const template=await readFile(resolve(import.meta.dirname,'../src/claude-dashboard.html'),'utf8');
const source=Object.entries(names).map(([key,value])=>`const ${key} = ${value.toString()};`).join('\n')+'\nmountClaudeDashboard({'+Object.keys(names).filter(k=>k!=='mountClaudeDashboard').join(',')+'});';
if(source.includes('</script'))throw new Error('Inline source must not close its containing script');
// A replacement function preserves receipt regexes containing $' or $&.
const html=template.replace('<!-- SUBSNOTES_RUNTIME -->',()=>'<script>\n'+source+'\n</script>');
await mkdir(resolve(import.meta.dirname,'../dist'),{recursive:true});
await writeFile(resolve(import.meta.dirname,'../dist/subsnotes-claude.html'),html);
console.log('Created an empty-data Claude Artifact source in renew-before-service/dist/subsnotes-claude.html. It requires native Gmail and personal-storage capabilities; opening the HTML locally does not connect Gmail.');
