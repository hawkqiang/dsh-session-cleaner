'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const bridge=require('./bridge.cjs');
test('request/reply uses a workspace-only synthetic Host; service refusal does not change storage',{skip:process.platform!=='win32'},async()=>{
 const original=process.env.LOCALAPPDATA,parent=__dirname,base=await fs.mkdtemp(path.join(parent,'fixture-bridge-'));let stop;
 try{process.env.LOCALAPPDATA=base;stop=await bridge.start(async(id)=>{if(id==='bad')throw Error('synthetic refusal');return {sessionId:id,bytes:42};});assert.deepEqual(await bridge.request('fake'),{ok:true,sessionId:'fake',bytes:42});assert.deepEqual(await bridge.request('bad'),{ok:false,error:'synthetic refusal'});await assert.rejects(()=>bridge.request('../invalid'));}
 finally{stop?.();process.env.LOCALAPPDATA=original;if(path.dirname(base)===parent && path.basename(base).startsWith('fixture-bridge-'))await fs.rm(base,{recursive:true,force:true});}
});
test('menu only copies captured archived ID, never performs a mutation',async()=>{
 let spec,registration,archived=[],copied=[],notice=[];const source=await fs.readFile(path.join(__dirname,'client.js'),'utf8');const scope={window:{__ModuleLoader__:{load:x=>{spec=x}}},navigator:{clipboard:{writeText:async x=>{copied.push(x)}}}};vm.runInNewContext(source,scope);const ctx={effect:fn=>fn(),locale:{register:()=>()=>{},bind:()=>key=>key},contextMenus:{register:r=>{registration=r;return ()=>{};},notify:(m,s)=>notice.push([m,s])},workspaces:{list:{getSnapshot:()=>({archivedSessionIds:archived})}}};spec.factory().apply(ctx);assert.equal(registration.target,'session');const [button]=registration.resolve({sessionId:'chosen',displayTitle:'Chat\u202eTitle'});await button.run();assert.deepEqual(copied,[]);archived=['chosen','unrelated'];await button.run();assert.deepEqual(copied,['chosen']);assert.deepEqual(notice,[['need',false],['copied\nChat Title · ID: chosen',true]]);
});
