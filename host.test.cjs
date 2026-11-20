'use strict';
// Host path test: uses the same removePlannedSession the HTTP route calls, against a
// synthetic store in the platform temp directory (never a real session).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const core=require('./core.cjs'),{removePlannedSession}=require('./host.cjs');
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'fixture-host-'));
 t.after(async()=>{if(!path.basename(base).startsWith('fixture-host-')||path.dirname(base)!==os.tmpdir())throw Error('Unexpected fixture');await fs.rm(base,{recursive:true,force:true});});
 const root=path.join(base,'store'),planDir=path.join(base,'plans'),guardPath=path.join(base,'epoch');
 const dir=path.join(root,'_no-cwd','mock-201'),file=path.join(dir,'session.v4.jsonl');
 await fs.mkdir(dir,{recursive:true});await fs.writeFile(file,'synthetic-log');await fs.writeFile(guardPath,'1');
 const snapshots=[{header:{version:4,id:'mock-201',isSeeded:false,title:'Synthetic chat'},formatStatus:'current',location:{kind:'jsonl',path:file},sizeBytes:13}];
 return {base,root,planDir,guard:guardPath,file,snapshots,sessionId:'mock-201'};
}
test('host path deletes the verified synthetic log and reports its size', async t=>{
 const a=await fixture(t);
 const result=await removePlannedSession({...a,core});
 assert.equal(result.bytes,13);
 assert.equal(result.title,'Synthetic chat');
 await assert.rejects(fs.stat(a.file),{code:'ENOENT'});
});
test('host path refuses an archived session that is missing from the provider snapshot', async t=>{
 const a=await fixture(t);
 await assert.rejects(removePlannedSession({...a,snapshots:[{...a.snapshots[0],header:{...a.snapshots[0].header,id:'other'}}],core}),/JSONL/);
 assert.equal(await fs.readFile(a.file,'utf8'),'synthetic-log');
});
test('host path refuses a stale archive state observed after planning', async t=>{
 const a=await fixture(t);
 await assert.rejects(removePlannedSession({...a,core,stillValid:()=>false}),/归档状态已变化/);
 assert.equal(await fs.readFile(a.file,'utf8'),'synthetic-log');
});
test('host path refuses a rewrite that happened after planning', async t=>{
 const a=await fixture(t);
 await assert.rejects(removePlannedSession({...a,core,stillValid:()=>{require('node:fs').appendFileSync(a.file,'x');return true;}}),/changed/);
 assert.equal(await fs.readFile(a.file,'utf8'),'synthetic-logx');
});
test('host path refuses multi-generation session directories', async t=>{
 const a=await fixture(t);
 await fs.writeFile(path.join(path.dirname(a.file),'session.v3.jsonl'),'older');
 await assert.rejects(removePlannedSession({...a,core}),/multiple generations|Refusing/);
 assert.equal(await fs.readFile(a.file,'utf8'),'synthetic-log');
});