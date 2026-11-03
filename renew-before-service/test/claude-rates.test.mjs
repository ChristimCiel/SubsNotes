import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeRatesClient } from '../src/claude-rates.mjs';
import { createFxRuntime } from '../src/fx.mjs';

const rows = [{ date:'2026-11-03', base:'USD', quote:'TWD', rate:32.576 }];
test('native rate requests contain no private data and accept standard MCP and native wrappers', async () => {
  for (const response of [{ content:[{type:'text',text:JSON.stringify(rows)}] }, {payload:rows}, {payload:JSON.stringify(rows)}, {structuredContent:rows}]) {
    const calls=[];
    const client=createClaudeRatesClient({callTool:async(...args)=>{calls.push(args);return response;}},createFxRuntime(),{clock:()=>new Date('2026-11-03T10:00:00Z')});
    const result=await client.load();
    assert.deepEqual(calls,[['Frankfurter','get_rates',{base:'USD'},{cache:false}]]);
    assert.equal(result.snapshot.rates.TWD.value,'32.576');
    assert.equal(result.snapshot.rates.USD.value,'1');
    assert.equal(result.snapshot.provider,'frankfurter');
  }
});
test('native rates fail closed for tool errors, unknown shapes, and invalid reference dates', async () => {
  for (const response of [{isError:true}, {payload:'not JSON'}, {payload:{rates:rows}}, {payload:[{...rows[0],date:'2030-01-01'}]}]) {
    await assert.rejects(createClaudeRatesClient({callTool:async()=>response},createFxRuntime(),{clock:()=>new Date('2026-11-03T10:00:00Z')}).load());
  }
});
