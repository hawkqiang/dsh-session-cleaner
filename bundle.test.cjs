'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const bridge=require('./bridge.cjs');
test('request/reply uses a workspace-only synthetic Host; service refusal does not change storage',{skip:process.platform!=='win32'},async()=>{
 const original=process.env.LOCALAPPDATA,parent=__dirname,base=await fs.mkdtemp(path.join(parent,'fixture-bridge-'));let stop;
 try{process.env.LOCALAPPDATA=base;stop=await bridge.start(async(id)=>{if(id==='bad')throw Error('synthetic refusal');return {sessionId:id,bytes:42};});assert.deepEqual(await bridge.request('fake'),{ok:true,sessionId:'fake',bytes:42});assert.deepEqual(await bridge.request('bad'),{ok:false,error:'synthetic refusal'});await assert.rejects(()=>bridge.request('../invalid'));}
 finally{stop?.();process.env.LOCALAPPDATA=original;if(path.dirname(base)===parent && path.basename(base).startsWith('fixture-bridge-'))await fs.rm(base,{recursive:true,force:true});}
});
async function loadMenu({confirmAnswer=true,response}={}){
 let spec;const calls={fetch:[],refresh:0,notify:[]};
 const source=await fs.readFile(path.join(__dirname,'client.js'),'utf8');
 const scope={window:{__ModuleLoader__:{load:x=>{spec=x}},confirm:()=>confirmAnswer},
  fetch:async(url,init)=>{calls.fetch.push({url,init});return {json:async()=>response};}};
 vm.runInNewContext(source,scope);
 const ctx={effect:fn=>fn(),locale:{register:()=>()=>{},bind:()=>key=>key},
  contextMenus:{register:r=>{calls.registration=r;return ()=>{};},notify:(m,s)=>calls.notify.push([m,s])},
  workspaces:{list:{getSnapshot:()=>({archivedSessionIds:ctx.archived})}},
  sessions:{refresh:async()=>{calls.refresh++;},list:{getSnapshot:()=>({ids:ctx.ids})}},archived:['chosen','unrelated'],ids:['chosen','unrelated']};
 spec.factory().apply(ctx);
 return {calls,ctx,resolve:()=>ctx.contextMenus===undefined?null:calls.registration.resolve({sessionId:'chosen',displayTitle:'Chat\u202eTitle'})[0]};
}
test('menu deletes through the authenticated route, refreshes the list, and reports failure without refreshing',{skip:process.platform!=='win32'},async()=>{
 const ok=await loadMenu({response:{ok:true,bytes:563019}});ok.ctx.ids=['unrelated'];await ok.resolve().run();
 assert.equal(ok.calls.fetch.length,1);
 assert.equal(ok.calls.fetch[0].url,'/api/session-cleaner/delete');
 assert.equal(ok.calls.fetch[0].init.method,'POST');
 assert.deepEqual(JSON.parse(ok.calls.fetch[0].init.body),{sessionId:'chosen'});
 assert.equal(ok.calls.refresh,1);
 assert.deepEqual(ok.calls.notify,[['done',true]]);

 const refused=await loadMenu({response:{ok:false,error:'该会话未归档'}});await refused.resolve().run();
 assert.equal(refused.calls.refresh,0);
 assert.deepEqual(refused.calls.notify,[['fail',false]]);
});
test('cancelling the confirmation never calls the route',{skip:process.platform!=='win32'},async()=>{
 const cancelled=await loadMenu({confirmAnswer:false});await cancelled.resolve().run();
 assert.equal(cancelled.calls.fetch.length,0);
 assert.equal(cancelled.calls.refresh,0);
});
test('unarchived rows are refused in the client before any request',{skip:process.platform!=='win32'},async()=>{
 const menu=await loadMenu();menu.ctx.archived=[];await menu.resolve().run();
 assert.equal(menu.calls.fetch.length,0);
 assert.deepEqual(menu.calls.notify,[['need',false]]);
});