import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createI18nRuntime} from '../src/i18n.mjs';
const i18n=createI18nRuntime();

test('the shared English and Traditional Chinese catalogues have matching keys and placeholders',()=>{
 assert.deepEqual(Object.keys(i18n.messages.en).sort(),Object.keys(i18n.messages['zh-TW']).sort());
 for(const key of i18n.keys())for(const language of i18n.languages){assert.ok(i18n.t(key,language).trim(),key);assert.deepEqual((i18n.messages[language][key].match(/\{\w+\}/g)||[]).sort(),(i18n.messages.en[key].match(/\{\w+\}/g)||[]).sort(),key);}
 assert.equal(i18n.normalizeLanguage('zh'),'zh-TW');assert.equal(i18n.normalizeLanguage('zh-TW'),'zh-TW');assert.equal(i18n.normalizeLanguage('unavailable'),'en');
 assert.equal(i18n.t('accountLabel','zh-TW',{number:2}),'帳號 2');
});

test('month-level dates never display a manufactured day, and invalid calendar days remain unknown',()=>{
 assert.equal(i18n.month('2028-02','en'),'February 2028');assert.equal(i18n.month('2028-02','zh-TW'),'2028年2月');
 assert.equal(i18n.date('2028-02','en'),'February 2028');assert.equal(i18n.date('2028-02-30','en'),'Not established');assert.equal(i18n.month('2028-13','zh-TW'),'尚未確認');
 assert.equal(i18n.date('2028-02-29','en'),'Feb 29, 2028');
});

test('date-only and month-only labels stay stable across UTC plus 14 and UTC minus 12',()=>{
 const source=`import {createI18nRuntime}from'./src/i18n.mjs';const i=createI18nRuntime();console.log(JSON.stringify([i.date('2028-03-01','en'),i.month('2028-03','zh-TW')]))`;
 const run=TZ=>execFileSync(process.execPath,['--input-type=module','-e',source],{cwd:new URL('../',import.meta.url),env:{...process.env,TZ},encoding:'utf8'}).trim();
 assert.equal(run('Pacific/Kiritimati'),run('Etc/GMT+12'));
});

test('currency formatting respects zero and three-decimal currencies without assuming USD',()=>{
 assert.match(i18n.money({currency:'JPY',minor:1234},'en'),/JPY.*1,234$/);assert.match(i18n.money({currency:'KWD',minor:1234},'en'),/KWD.*1\.234$/);
 assert.equal(i18n.money({currency:null,minor:1234},'zh-TW'),'幣別待確認');assert.equal(i18n.money({currency:'ZZZ',minor:1234},'en'),'Currency unconfirmed');
});

test('unknown provider errors cannot expose raw private URLs, while known confirmation errors are localized',()=>{
 const error={message:'Synthetic failure https://example.invalid/private-token?credential=fictional'};
 assert.doesNotMatch(i18n.error(error,'en'),/example|credential|fictional/);assert.match(i18n.error({code:'confirmation_stale'},'zh-TW'),/其他地方更新/);
});

test('dashboard components consume the shared catalogue instead of embedding translation dictionaries',async()=>{
 const source=await readFile(new URL('../src/claude-dashboard.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/const words\s*=|Object\.assign\(words|[\u4e00-\u9fff]/);assert.match(source,/createI18nRuntime/);
});
