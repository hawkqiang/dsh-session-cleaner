'use strict';
// Host path test: uses the same removeTree the HTTP route calls, against synthetic
// stores in the platform temp directory (never a real session).
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),fsSync=require('node:fs'),os=require('node:os'),path=require('node:path');
const core=require('./core.cjs'),{removeTree,describeTree}=require('./host.cjs');

async function makeSession(base,id,header,body='synthetic-log'){
 const dir=path.join(base,'store','_no-cwd',id),file=path.join(dir,'session.v4.jsonl');
 await fs.mkdir(dir,{recursive:true});await fs.writeFile(file,body);
 return {header:{version:4,id,isSeeded:false,...header},formatStatus:'current',location:{kind:'jsonl',path:file},sizeBytes:Buffer.byteLength(body)};
}
async function fixture(t,{withChild=false,seededChild=false}={}){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'fixture-host-'));
 t.after(async()=>{if(!path.basename(base).startsWith('fixture-host-')||path.dirname(base)!==os.tmpdir())throw Error('Unexpected fixture');await fs.rm(base,{recursive:true,force:true});});
 const planDir=path.join(base,'plans'),guard=path.join(base,'epoch');await fs.writeFile(guard,'1');
 const snapshots=[await makeSession(base,'mock-201',{title:'Synthetic chat'})];
 if(withChild)snapshots.push(await makeSession(base,'mock-202',{title:'Synthetic child',parentSession:'mock-201',delegationDepth:1},'child-log'));
 if(seededChild)snapshots.push(await makeSession(base,'mock-203',{title:'Synthetic fork',parentSession:'mock-201',isSeeded:true},'fork-log'));
 const list=async()=>snapshots.filter(s=>fsSync.existsSync(s.location.path));
 return {base,planDir,guard,snapshots,sessionId:'mock-201',core,list,withChildren:false};
}

test('host path deletes a leaf session and reports its size', async t=>{
 const a=await fixture(t);
 const result=await removeTree(a);
 assert.equal(result.bytes,13);
 assert.equal(result.deleted,1);
 assert.equal(result.title,'Synthetic chat');
 await assert.rejects(fs.stat(a.snapshots[0].location.path),{code:'ENOENT'});
});

test('host path refuses a parent until the caller opts into the tree', async t=>{
 const a=await fixture(t,{withChild:true});
 await assert.rejects(removeTree(a),/子会话/);
 assert.equal(await fs.readFile(a.snapshots[1].location.path,'utf8'),'child-log');
});

test('host path deletes children before the parent when a cascade is confirmed', async t=>{
 const a=await fixture(t,{withChild:true,seededChild:true});
 const described=describeTree({sessionId:a.sessionId,snapshots:a.snapshots});
 assert.deepEqual(described.children.map(c=>c.id),['mock-202','mock-203']);
 const result=await removeTree({...a,withChildren:true});
 assert.equal(result.deleted,3);
 for(const snapshot of a.snapshots)await assert.rejects(fs.stat(snapshot.location.path),{code:'ENOENT'});
});

test('host path refuses an archived session that is missing from the provider snapshot', async t=>{
 const a=await fixture(t);
 await assert.rejects(removeTree({...a,list:undefined,snapshots:[{...a.snapshots[0],header:{...a.snapshots[0].header,id:'other'}}]}),/JSONL/);
 assert.equal(await fs.readFile(a.snapshots[0].location.path,'utf8'),'synthetic-log');
});

test('host path refuses a stale archive state observed before deletion', async t=>{
 const a=await fixture(t);
 await assert.rejects(removeTree({...a,stillValid:()=>false}),/归档状态已变化/);
 assert.equal(await fs.readFile(a.snapshots[0].location.path,'utf8'),'synthetic-log');
});

test('host path refuses a log rewritten after planning', async t=>{
 const a=await fixture(t);
 await assert.rejects(removeTree({...a,stillValid:()=>{fsSync.appendFileSync(a.snapshots[0].location.path,'x');return true;}}),/changed/);
 assert.equal(await fs.readFile(a.snapshots[0].location.path,'utf8'),'synthetic-logx');
});

test('host path refuses multi-generation session directories', async t=>{
 const a=await fixture(t);
 await fs.writeFile(path.join(path.dirname(a.snapshots[0].location.path),'session.v3.jsonl'),'older');
 await assert.rejects(removeTree(a),/multiple generations|Refusing/);
 assert.equal(await fs.readFile(a.snapshots[0].location.path,'utf8'),'synthetic-log');
});