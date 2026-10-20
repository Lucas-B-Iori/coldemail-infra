import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Intercept only this child process's modules: no real account, database or network is loaded.
const hook = join(mkdtempSync(join(tmpdir(), 'coldmail-verify-')), 'hook.mjs');
writeFileSync(hook, `import { registerHooks } from 'node:module';
registerHooks({load(url,context,next){
 let source;
 if(url.endsWith('/src/accounts/accounts.ts')) source="export const selectAccounts=()=>[{id:1,email:'test@example.invalid',status:'warming',auth_mode:'password'}];";
 if(url.endsWith('/src/email/smtp.ts')) source="export const usesGraph=()=>false; export const verifySmtp=async()=>{if(process.env.TEST_SMTP_FAIL==='1')throw new Error('synthetic SMTP failure')};";
 if(url.endsWith('/src/email/imap.ts')) source="export const verifyImap=async()=>{if(process.env.TEST_IMAP_FAIL==='1')throw new Error('synthetic IMAP failure')};";
 if(url.endsWith('/src/email/oauth.ts')) source="export const oauthConfigured=()=>true;";
 if(url.endsWith('/src/lib/util.ts')) source="export const errMsg=e=>e.message; export const pLimit=()=>{}; export const log=()=>{}; export const sleep=async()=>{};";
 return source?{format:'module',source,shortCircuit:true}:next(url,context);
}});`);
function run(smtp, imap, smtpOnly = false) {
  return spawnSync(process.execPath,['--import',pathToFileURL(hook).href,'scripts/verify-accounts.ts',...(smtpOnly?['--smtp-only']:[])],{
    encoding:'utf8',env:{...process.env,TEST_SMTP_FAIL:String(smtp),TEST_IMAP_FAIL:String(imap)},
  });
}
test('verify fails when either required protocol fails and ignores IMAP only with smtp-only',()=>{
  for(const [smtp,imap,smtpOnly,exit] of [[0,0,false,0],[0,1,false,1],[1,0,false,1],[1,1,false,1],[0,1,true,0],[1,0,true,1]]) {
    const result=run(smtp,imap,smtpOnly);
    assert.equal(result.status,exit,result.stderr+'\n'+result.stdout);
  }
});
