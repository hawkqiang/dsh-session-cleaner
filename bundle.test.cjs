'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm');
const bridge=require('./bridge.cjs');

test('request/reply uses a workspace-only synthetic Host (Windows)',{skip:process.platform!=='win32'},async()=>{
 const original=process.env.LOCALAPPDATA,parent=__dirname,base=await fs.mkdtemp(path.join(parent,'fixture-bridge-'));let stop;
 try{process.env.LOCALAPPDATA=base;stop=await bridge.start(async(id)=>{if(id==='bad')throw Error('synthetic refusal');return {sessionId:id,bytes:42};});assert.deepEqual(await bridge.request('fake'),{ok:true,sessionId:'fake',bytes:42});assert.deepEqual(await bridge.request('bad'),{ok:false,error:'synthetic refusal'});await assert.rejects(()=>bridge.request('../invalid'));}
 finally{stop?.();process.env.LOCALAPPDATA=original;if(path.dirname(base)===parent && path.basename(base).startsWith('fixture-bridge-'))await fs.rm(base,{recursive:true,force:true});}
});

test('request/reply uses a workspace-only synthetic Host (POSIX)',{skip:process.platform==='win32'},async()=>{
 const originalHome=process.env.HOME,originalState=process.env.XDG_STATE_HOME,parent=__dirname,base=await fs.mkdtemp(path.join(parent,'fixture-bridge-'));let stop;
 try{
  process.env.HOME=base;delete process.env.XDG_STATE_HOME;
  stop=await bridge.start(async(id)=>{if(id==='bad')throw Error('synthetic refusal');return {sessionId:id,bytes:42};});
  assert.deepEqual(await bridge.request('fake'),{ok:true,sessionId:'fake',bytes:42});
  assert.deepEqual(await bridge.request('bad'),{ok:false,error:'synthetic refusal'});
  await assert.rejects(()=>bridge.request('../invalid'));
 }finally{
  stop?.();
  if(originalHome===undefined)delete process.env.HOME;else process.env.HOME=originalHome;
  if(originalState===undefined)delete process.env.XDG_STATE_HOME;else process.env.XDG_STATE_HOME=originalState;
  if(path.dirname(base)===parent && path.basename(base).startsWith('fixture-bridge-'))await fs.rm(base,{recursive:true,force:true});
 }
});

async function loadMenu({confirmAnswer=true,inspect={ok:true,bytes:13},deleteResult={ok:true,bytes:13,deleted:1},routeStatus=undefined}={}){
 let spec;const calls={posts:[],refresh:0,notify:[]};
 const source=await fs.readFile(path.join(__dirname,'client.js'),'utf8');
 const scope={window:{__ModuleLoader__:{load:x=>{spec=x}},confirm:()=>confirmAnswer},
  fetch:async(url,init)=>{
   calls.posts.push({url,body:JSON.parse(init.body)});
   if(routeStatus!==undefined)return {status:routeStatus,text:async()=>'not found'};
   const payload=url.endsWith('/inspect')?inspect:deleteResult;
   return {status:200,text:async()=>JSON.stringify(payload)};
  }};
 vm.runInNewContext(source,scope);
 const ctx={effect:fn=>fn(),locale:{register:()=>()=>{},bind:()=>key=>key},
  contextMenus:{register:r=>{calls.registration=r;return ()=>{};},notify:(m,s)=>calls.notify.push([m,s])},
  sessions:{refresh:async()=>{calls.refresh++;},list:{getSnapshot:()=>({ids:ctx.ids})}},
  ids:['chosen','unrelated']};
 spec.factory().apply(ctx);
 return {calls,ctx,item:()=>calls.registration.resolve({sessionId:'chosen',displayTitle:'K线优化测试'})[0]};
}

test('menu inspects, asks for the parent and deletes it with the list refreshed',async()=>{
 const menu=await loadMenu();menu.ctx.ids=['unrelated'];await menu.item().run();
 assert.deepEqual(menu.calls.posts.map(p=>p.url),['/api/session-cleaner/inspect','/api/session-cleaner/delete']);
 assert.deepEqual(menu.calls.posts[1].body,{sessionId:'chosen',withChildren:false});
 assert.equal(menu.calls.refresh,1);
 assert.deepEqual(menu.calls.notify,[['done',true]]);
});

test('a row that was never archived deletes directly',async()=>{
 const menu=await loadMenu();menu.ctx.ids=['unrelated'];await menu.item().run();
 assert.deepEqual(menu.calls.posts.map(p=>p.url),['/api/session-cleaner/inspect','/api/session-cleaner/delete']);
 assert.equal(menu.calls.refresh,1);
 assert.deepEqual(menu.calls.notify,[['done',true]]);
});

test('menu confirms the whole child tree before deleting it',async()=>{
 const menu=await loadMenu({inspect:{ok:true,bytes:100,children:[{id:'kid-1',title:'Kid',origin:'subagent'},{id:'kid-2',title:'Fork',seeded:true}]}});
 menu.ctx.ids=['unrelated'];await menu.item().run();
 assert.deepEqual(menu.calls.posts[1].body,{sessionId:'chosen',withChildren:true});
 assert.equal(menu.calls.refresh,1);
 assert.deepEqual(menu.calls.notify,[['done',true]]);
});

test('a busy session is queued for the next start instead of reported as deleted',async()=>{
 const menu=await loadMenu({deleteResult:{ok:true,queued:true,sessionId:'chosen',title:'K线优化测试',error:'该会话仍被 DSH 占用'}});
 await menu.item().run();
 assert.equal(menu.calls.refresh,0,'a queued row is still on disk, so the list is not refreshed');
 assert.deepEqual(menu.calls.notify,[['queued',true]]);
});

test('menu reports a refused inspection and performs no deletion',async()=>{
 const menu=await loadMenu({inspect:{ok:false,error:'找不到受支持的 JSONL 会话'}});await menu.item().run();
 assert.deepEqual(menu.calls.posts.map(p=>p.url),['/api/session-cleaner/inspect']);
 assert.equal(menu.calls.refresh,0);
 assert.deepEqual(menu.calls.notify,[['fail',false]]);
});

test('a plain-text 404 route response is reported without a JSON syntax error',async()=>{
 const menu=await loadMenu({routeStatus:404});await menu.item().run();
 assert.deepEqual(menu.calls.posts.map(p=>p.url),['/api/session-cleaner/inspect']);
 assert.equal(menu.calls.refresh,0);
 assert.deepEqual(menu.calls.notify,[['fail',false]]);
});

test('menu reports a failed cascade without refreshing',async()=>{
 const menu=await loadMenu({inspect:{ok:true,bytes:100,children:[{id:'kid-1'}]},deleteResult:{ok:false,error:'子会话仍被占用'}});await menu.item().run();
 assert.equal(menu.calls.refresh,0);
 assert.deepEqual(menu.calls.notify,[['fail',false]]);
});

test('cancelling the confirmation never calls the delete route',async()=>{
 const menu=await loadMenu({confirmAnswer:false});await menu.item().run();
 assert.deepEqual(menu.calls.posts.map(p=>p.url),['/api/session-cleaner/inspect']);
 assert.equal(menu.calls.refresh,0);
});