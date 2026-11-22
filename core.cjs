'use strict';
// Offline maintenance for the JSONL provider shipped in DSH 0.2.2-rc.5.
// Not a generic file remover. All roots, archive and snapshot facts come from the Host.
// Windows keeps the exclusive handle plus named-semaphore path; POSIX (Linux, Android
// Termux, macOS) arbitrates on the same `flock(2)` DSH itself takes on session.lock.
const fs = require('node:fs/promises');
const fsc = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {createRequire} = require('node:module');
const {pathToFileURL} = require('node:url');
const TTL=10*60*1000;
const WIN32=process.platform==='win32';
// The JSONL provider keeps one zero-length lock file beside every materialized log on
// POSIX; it is expected storage, not a stray artifact.
const LOCK='session.lock';
const fail=m=>{throw Error(m)};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function simpleId(s){return typeof s==='string' && /^[A-Za-z0-9_-]{1,160}$/.test(s) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(s)}
function rootPath(p){if(typeof p!=='string'||!path.isAbsolute(p)||path.resolve(p)!==p||path.parse(p).root===p|| (process.platform==='win32' && (!/^[A-Za-z]:\\/.test(p)||/[\x00-\x1f<>:"|?*]/.test(p.slice(2))||p.slice(3).split('\\').some(x=>/[. ]$/.test(x)))))fail('Expected canonical absolute local path');return p}
async function checkDir(p){rootPath(p);for(let q=p;;q=path.dirname(q)){const s=await fs.lstat(q);if(!s.isDirectory()||s.isSymbolicLink())fail('Unexpected directory type');if(q===path.dirname(q))break}const real=await fs.realpath(p);if(WIN32?real.toLowerCase()!==p.toLowerCase():real!==p)fail('Redirected directory');}
async function oneFile(f){await checkDir(path.dirname(f));const s=await fs.lstat(f,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size>BigInt(Number.MAX_SAFE_INTEGER))fail('Expected a single-link regular file');return [String(s.dev),String(s.ino),String(s.size),String(s.mtimeNs),String(s.ctimeNs)]}
async function digest(f){const h=await fs.open(f,'r');try{const s=await h.stat({bigint:true});if(!s.isFile()||s.nlink!==1n)fail('Unsafe log');const sum=crypto.createHash('sha256');for await(const chunk of h.createReadStream({autoClose:false}))sum.update(chunk);return sum.digest('hex')}finally{await h.close()}}
function admit({sessionId,archived,snapshots,allowTree=false}){
 if(!simpleId(sessionId)||archived!==true||!Array.isArray(snapshots))fail('Archived session with verified provider inventory required');
 const seen=new Set();let target;for(const s of snapshots){const h=s?.header;if(!h||typeof h.id!=='string'||seen.has(h.id)||h.version!==4)fail('Incomplete or ambiguous provider inventory');seen.add(h.id);if(!allowTree&&h.parentSession===sessionId)fail('Session has child sessions');if(h.id===sessionId)target=s}
 const h=target?.header;
 if(!h||target.formatStatus!=='current'||target.location?.kind!=='jsonl')fail('Only independent current-format JSONL sessions qualify');
 // A cascade member is deleted as part of its own tree, so its parent link and
 // inherited prefix disappear together with the ancestor that carries them.
 if(!allowTree&&(h.isSeeded!==false||h.parentSession!==undefined||h.origin!==undefined||(h.delegationDepth??0)!==0))fail('Only independent current-format JSONL sessions qualify');
 if(allowTree){const depth=h.delegationDepth??0;if(!Number.isSafeInteger(depth)||depth<0)fail('Unknown delegation depth')}
 return target;
}
function location(root,file,id){rootPath(root);rootPath(file);if(!simpleId(id))fail('Invalid Session ID');const a=path.relative(root,file).split(path.sep);if(a.length!==3||!/^(_no-cwd|--[A-Za-z0-9._~\-]+--)$/.test(a[0])||a[1]!==id||!/^session\.v4\.jsonl(?:\.zstd)?$/.test(a[2]))fail('Unsupported provider layout');return a}
// Folder names only, never access unrelated transcript contents. A newly-created
// session/child invalidates the plan even if the target log itself is unchanged.
async function census(root,snapshots){
 await checkDir(root);const rows=[],selected=new Set();
 for(const project of await fs.readdir(root,{withFileTypes:true})){
  if(!project.isDirectory()||project.isSymbolicLink())fail('Unexpected storage-root entry');
  const d=path.join(root,project.name);await checkDir(d);
  for(const session of await fs.readdir(d,{withFileTypes:true})){
   if(!session.isDirectory()||session.isSymbolicLink())fail('Unexpected project entry');
   const dir=path.join(d,session.name);await checkDir(dir);const generations=[];
   for(const file of await fs.readdir(dir,{withFileTypes:true})){
    if(file.name===LOCK){if(!file.isFile()||file.isSymbolicLink())fail('Unexpected session lock entry');continue}
    const m=/^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/.exec(file.name);
    if(!file.isFile()||file.isSymbolicLink()||!m)fail('Unexpected session-local artifacts in storage inventory');
    const version=Number(m[1]??0);if(!Number.isSafeInteger(version)||generations.some(g=>g.version===version))fail('Unknown or ambiguous storage generation');
    generations.push({version,name:file.name});
   }
   generations.sort((a,b)=>b.version-a.version);if(generations.length)selected.add(path.join(dir,generations[0].name));
   rows.push(JSON.stringify([project.name,session.name,generations.map(g=>g.name)]));
  }
 }
 if(snapshots){for(const s of snapshots){if(s.location?.kind!=='jsonl'||!selected.delete(s.location.path))fail('Provider and filesystem inventory mismatch')}if(selected.size)fail('Provider omitted a physical session');}
 return hash(rows.sort().join('\n'));
}
async function singleGeneration(f){const a=(await fs.readdir(path.dirname(f))).filter(n=>n!==LOCK);if(a.length!==1||a[0]!==path.basename(f))fail('Refusing multiple generations or unexpected session-local artifacts');return oneFile(f)}
async function privateDir(d,root,create){rootPath(d);rootPath(root);for(const [a,b] of [[d,root],[root,d]]){const rel=path.relative(a,b);if(rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)))fail('Plan directory must be separate from store')}if(create){await checkDir(path.dirname(d));await fs.mkdir(d,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e})}await checkDir(d)}
async function keyAt(d,create){const f=path.join(d,'plan-auth.key');if(create){try{await fs.writeFile(f,crypto.randomBytes(32),{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e}}await oneFile(f);const k=await fs.readFile(f);if(k.length!==32)fail('Bad local plan key');return k}
function mac(k,p){return crypto.createHmac('sha256',k).update(JSON.stringify(p)).digest('hex')}
async function preparePlan({root,sessionId,archived,snapshots,planDir,archiveStateFile,allowTree=false}){
 const epoch=rootPath(archiveStateFile),epochSig=await oneFile(epoch);const s=admit({sessionId,archived,snapshots,allowTree});const f=s.location.path;const rel=location(root,f,sessionId);const cs=await census(root,snapshots);const sig=await singleGeneration(f);const sha=await digest(f);if(JSON.stringify(sig)!==JSON.stringify(await singleGeneration(f))||Number(sig[2])!==s.sizeBytes||cs!==await census(root))fail('Storage changed during planning');
 const planId=crypto.randomUUID(),p={version:1,planId,sessionId,root,rel,created:Date.now(),sig,sha,census:cs};p.archiveStateFile=epoch;p.archiveSig=epochSig;if(JSON.stringify(epochSig)!==JSON.stringify(await oneFile(epoch)))fail('Archive state changed during planning');
 await privateDir(planDir,root,true);const k=await keyAt(planDir,true);await fs.writeFile(path.join(planDir,planId+'.json'),JSON.stringify({p,auth:mac(k,p)}),{mode:0o600,flag:'wx'});return {planId,sessionId,bytes:Number(sig[2])};
}
async function loadPlan({root,planDir,planId,sessionId}){
 if(!simpleId(sessionId)||typeof planId!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(planId))fail('Invalid plan or session identifier');await privateDir(planDir,root,false);const k=await keyAt(planDir,false),pf=path.join(planDir,planId+'.json');const sig=await oneFile(pf);if(Number(sig[2])>32768)fail('Oversized plan');const {p,auth}=JSON.parse(await fs.readFile(pf,'utf8'));if(typeof auth!=='string'||!/^[0-9a-f]{64}$/.test(auth)||!crypto.timingSafeEqual(Buffer.from(auth,'hex'),Buffer.from(mac(k,p),'hex')))fail('Plan authentication failed');if(p.version!==1||p.root!==root||p.planId!==planId||p.sessionId!==sessionId||!Number.isSafeInteger(p.created)||Date.now()<p.created||Date.now()-p.created>TTL)fail('Plan expired or confirmation mismatch');const f=path.join(root,...p.rel);location(root,f,sessionId);if(p.archiveStateFile && JSON.stringify(p.archiveSig)!==JSON.stringify(await oneFile(p.archiveStateFile)))fail('Archive state changed');if(await census(root)!==p.census||JSON.stringify(p.sig)!==JSON.stringify(await singleGeneration(f)))fail('Session inventory or log changed');return {p,f};
}
// Exclusive delete by validated handle, not by pathname. Refuse all reparse
// ancestors, hardlinks, unexpected namespace entries, and non-local NTFS.
const native=String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ScopedLogRemoval {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string f,uint access,uint share,IntPtr sec,uint disp,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder b,uint n,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int k,IntPtr b,uint n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int k,IntPtr b,uint n);
 static void Ok(bool x){if(!x)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 public static void Remove(string file,string sha,string lease){
  var drive=new DriveInfo(Path.GetPathRoot(file));if(drive.DriveType!=DriveType.Fixed||drive.DriveFormat!="NTFS")throw new IOException("A local fixed NTFS volume is required");
  using(var sem=new Semaphore(1,1,lease)){
   if(!sem.WaitOne(0))throw new IOException("DSH writer is still active");
   try{for(var d=new DirectoryInfo(Path.GetDirectoryName(file));d!=null;d=d.Parent)if((d.Attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("Reparse directory refused");
    using(var h=CreateFileW(file,0x80010000,0,IntPtr.Zero,3,0x00200000,IntPtr.Zero)){
     Ok(!h.IsInvalid);var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,b,(uint)b.Capacity,0);if(n==0||n>=b.Capacity||!String.Equals(b.ToString(),@"\\?\"+file,StringComparison.OrdinalIgnoreCase))throw new IOException("Unexpected final path");
     IntPtr mem=Marshal.AllocHGlobal(4096);try{
      Ok(GetFileInformationByHandleEx(h,7,mem,4096));if(Marshal.ReadInt32(mem)!=0||Marshal.ReadInt32(mem,4)!=14||Marshal.PtrToStringUni(IntPtr.Add(mem,24),7)!="::$DATA")throw new IOException("Alternate data streams refused");
      Ok(GetFileInformationByHandleEx(h,9,mem,64));if((Marshal.ReadInt32(mem)&(0x400|0x10|0x1000|0x200))!=0)throw new IOException("Refused special file");
      Ok(GetFileInformationByHandleEx(h,1,mem,64));if(Marshal.ReadInt32(mem,16)!=1)throw new IOException("Hard links refused");
      using(var stream=new FileStream(h,FileAccess.Read)) using(var hash=SHA256.Create()){
       if(!String.Equals(BitConverter.ToString(hash.ComputeHash(stream)).Replace("-",""),sha,StringComparison.OrdinalIgnoreCase))throw new IOException("Log content changed");
       var entries=Directory.GetFileSystemEntries(Path.GetDirectoryName(file));if(entries.Length!=1||!String.Equals(entries[0],file,StringComparison.OrdinalIgnoreCase))throw new IOException("Unexpected session-local files");
       Marshal.WriteByte(mem,1);Ok(SetFileInformationByHandle(h,4,mem,1));
      }
     }finally{Marshal.FreeHGlobal(mem);}
    }
   }finally{sem.Release();}
  }
 }
}
'@
`;
// The process gate is the only difference between offline and live mode; both keep
// the per-session writer semaphore and the exclusive handle.
const nativeGate=String.raw`
$procs=@(Get-CimInstance Win32_Process -ErrorAction Stop)
if (!$procs.Count) {throw 'Cannot verify DSH shutdown'}
foreach($p in $procs){if ($p.ProcessId -eq $PID -or $p.ProcessId -eq [int]$env:CLEANER_PID){continue};if($p.Name -match '^(DeepSeek[ -]?Harness|dsh)(\.exe)?$'){throw 'Close DSH Desktop and CLI first'};if($p.Name -match '^(node|electron|bun|deno)(\.exe)?$'){if(!$p.CommandLine -or !$p.ExecutablePath){throw 'Cannot verify runtime process'};if(($p.CommandLine+' '+$p.ExecutablePath) -match '(?i)(deepseek[ -]harness|[\\/]dsh(?:[\\/.\s"]|$)|@deepseek-ai[\\/]dsh)'){throw 'Close all DSH runtimes first'}}}
`;
// A refusal writes its own reason to CLEANER_ERR: no stdio pipes, so the same script
// works under restricted sandboxes and the page can name the cause.
const nativeRemove=String.raw`[ScopedLogRemoval]::Remove($env:CLEANER_FILE,$env:CLEANER_SHA,$env:CLEANER_LEASE)`;
const nativeTryOpen=String.raw`
try {
`;
const nativeTryCatch=String.raw`
} catch {
 try { [IO.File]::WriteAllText($env:CLEANER_ERR, [string]$_.Exception.Message) } catch {}
 exit 1
}
`;
function composeNative(withGate){
 return native+nativeTryOpen+(withGate?nativeGate:'')+nativeRemove+nativeTryCatch;
}
const nativeLive=composeNative(false);
// Translate the native check's own diagnostics into a reason the page can show,
// so a refusal explains itself instead of guessing.
const NATIVE_HINTS=[
 [/DSH writer is still active/, '该会话仍被 DSH 占用：先切换到其他对话让它关闭后再试，或完全退出 DSH 后用「清理助手.cmd」删除'],
 [/being used by another process|sharing violation/i, '日志正被其他程序打开，请关闭该对话或稍后重试'],
 [/Reparse directory refused/, '路径经过符号链接或联接点，已拒绝删除'],
 [/A local fixed NTFS volume is required/, '需要本机固定的 NTFS 卷'],
 [/Unexpected final path/, '文件实际位置与预期不符，已拒绝'],
 [/Alternate data streams refused/, '文件带有备用数据流，已拒绝'],
 [/Hard links refused/, '文件是硬链接，已拒绝'],
 [/Log content changed/, '日志内容已变化，请重新删除'],
 [/Unexpected session-local files/, '会话目录里还有其他文件，已拒绝'],
];
function explain(output){
 const lines=String(output||'').replace(/\u001b\[[0-9;]*m/g,'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 const blob=lines.join(' | ');
 for(const [pattern,message] of NATIVE_HINTS)if(pattern.test(blob))return message;
 return lines.length?`Windows 安全检查失败：${lines[lines.length-1].slice(0,200)}`:'Windows 安全检查失败';
}
async function runNative(script,env){
 const exe=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const errFile=path.join(process.env.TEMP??process.env.TMP??'.',`dsh-cleaner-${crypto.randomUUID()}.log`);
 try{
  const code=await new Promise((resolve,reject)=>{
   const cp=spawn(exe,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:'ignore',windowsHide:true,env:{...process.env,...env,CLEANER_ERR:errFile}});
   cp.once('error',reject);cp.once('exit',value=>resolve(value));
  });
  if(code!==0){const detail=await fs.readFile(errFile,'utf8').catch(()=>'');fail(explain(detail));}
 }finally{await fs.unlink(errFile).catch(()=>{});}
}
// ---------------------------------------------------------------------------
// POSIX (Linux, Android Termux, macOS) deletion.
// DSH arbitrates a session's writers with a non-blocking flock(2) on session.lock,
// so this path takes the same lock, then verifies the log through an O_NOFOLLOW
// descriptor before unlinking it. The lock file lives in the session directory and
// is expected storage, not a stray artifact.

const BUSY='该会话仍被 DSH 占用：请先切到其他对话让它关闭后再试，或完全退出 DSH 后重试';
function busyError(){return Error(BUSY)}
function isContention(error){return error?.code==='EAGAIN'||error?.code==='EWOULDBLOCK'}
// The native flock entry ships inside the running DSH installation. Resolve it from
// the DSH process itself (argv[1] or the runtime beside DSH_NODE_EXECUTABLE) so the
// plugin does not need its own copy of the addon.
function addonRoots(){
  const out=[];
  const add=value=>{if(typeof value==='string'&&path.isAbsolute(value)&&!out.includes(value))out.push(value)};
  add(process.argv[1]);
  const node=process.env.DSH_NODE_EXECUTABLE||process.execPath;
  if(typeof node==='string'&&path.isAbsolute(node)){
    add(path.join(path.dirname(node),'..','work','node_modules','@deepseek-ai','dsh-session-persistence-jsonl','lib','index.js'));
    add(path.join(path.dirname(node),'..','..','work','node_modules','@deepseek-ai','dsh-session-persistence-jsonl','lib','index.js'));
  }
  add(require.main?.filename);
  add(__filename);
  return out;
}
let flockProbe;
async function flockEntry(){
  if(flockProbe!==undefined)return flockProbe;
  flockProbe=null;
  for(const base of addonRoots()){
    try{
      const req=createRequire(base);
      const resolved=req.resolve('@deepseek-ai/node-addon-system/flock');
      const mod=await import(pathToFileURL(resolved).href);
      if(typeof mod.tryLockExclusive==='function'){flockProbe=mod.tryLockExclusive;break}
    }catch{/* another root, or the flock(1) fallback below */}
  }
  return flockProbe;
}
function flockBinary(){
  const explicit=String(process.env.DSH_SESSION_CLEANER_FLOCK||'').trim();
  const candidates=[explicit];
  for(const dir of String(process.env.PATH||'').split(':'))if(dir)candidates.push(path.join(dir,'flock'));
  candidates.push('/data/data/com.termux/files/usr/glibc/bin/flock','/data/data/com.termux/files/usr/bin/flock','/usr/bin/flock','/bin/flock');
  for(const candidate of candidates){
    if(!candidate||!path.isAbsolute(candidate))continue;
    try{const s=fsc.statSync(candidate);if(s.isFile()&&fsc.accessSync(candidate,fsc.constants.X_OK)===undefined)return candidate}catch{}
  }
  return undefined;
}
// Fallback arbitration when the addon is unavailable: keep a flock(1) holder alive
// for the duration of the verification and unlink.
async function holdWithCli(bin,lockPath){
  const child=spawn(bin,['-n',lockPath,'sleep','86400'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  let detail='';
  child.stderr.on('data',chunk=>{detail+=chunk});
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const raced=await Promise.race([exited,new Promise(resolve=>setTimeout(()=>resolve(undefined),150))]);
  if(raced){
    if(raced.code===1)throw busyError();
    throw Error(`flock 启动失败：${detail.trim()||`退出码 ${raced.code}`}`);
  }
  return ()=>{try{child.kill('SIGTERM')}catch{/* already gone */}};
}
async function acquireWriteLock(dir){
  const lockPath=path.join(dir,LOCK);
  for(let attempt=0;attempt<3;attempt+=1){
    let handle;
    try{handle=await fs.open(lockPath,'w',0o600);}
    catch(error){throw Error(`无法打开会话锁：${error?.code||error?.message||error}`)}
    let release;
    try{
      const native=await flockEntry();
      let held=false;
      if(native){
        try{await native(handle.fd);held=true;}
        catch(error){
          if(isContention(error))throw busyError();
          if(error?.code!=='ERR_FLOCK_UNSUPPORTED_PLATFORM')throw error;
        }
      }
      if(!held){
        const bin=flockBinary();
        if(!bin)throw Error('没有可用的 flock 实现，已拒绝删除');
        release=await holdWithCli(bin,lockPath);
      }
      // A POSIX lock names an inode, not a path: the locked file must still be the
      // one reachable at the lock path.
      const locked=await handle.stat({bigint:true});
      const current=await fs.stat(lockPath,{bigint:true}).catch(error=>{if(error?.code==='ENOENT')return undefined;throw error});
      if(!current||current.dev!==locked.dev||current.ino!==locked.ino){
        release?.();await handle.close().catch(()=>{});
        continue;
      }
      return {release:async()=>{release?.();await handle.close().catch(()=>{})}};
    }catch(error){release?.();await handle.close().catch(()=>{});throw error}
  }
  throw busyError();
}
function unlinkHusk(dir){
  return fs.readdir(dir).then(async left=>{
    if(left.length!==1||left[0]!==LOCK)return false;
    const lock=path.join(dir,LOCK);
    const st=await fs.lstat(lock,{bigint:true});
    if(!st.isFile()||st.nlink!==1n)return false;
    await fs.unlink(lock);
    await fs.rmdir(dir);
    return true;
  });
}
// Called only while the write lock is held. Verifies identity and content through
// a descriptor that refuses symlinks and hardlinks, then unlinks the directory entry.
async function removeUnderLock(file,sha){
  const dir=path.dirname(file),base=path.basename(file);
  await checkDir(dir);
  const entries=(await fs.readdir(dir)).filter(name=>name!==LOCK);
  if(entries.length!==1||entries[0]!==base)fail('Refusing multiple generations or unexpected session-local artifacts');
  const O=fsc.constants.O_RDONLY|fsc.constants.O_NOFOLLOW;
  let handle;
  try{handle=await fs.open(file,O);}
  catch(error){if(error?.code==='ENOENT')fail('Log already gone');fail(`无法打开日志：${error?.code||error?.message||error}`)}
  try{
    const st=await handle.stat({bigint:true});
    if(!st.isFile()||st.nlink!==1n)fail('Expected a single-link regular file');
    if(typeof sha!=='string'||!/^[0-9a-f]{64}$/.test(sha))fail('Invalid content hash');
    const sum=crypto.createHash('sha256');
    const stream=handle.createReadStream({autoClose:false,start:0});
    for await(const chunk of stream)sum.update(chunk);
    if(sum.digest('hex')!==sha)fail('Log content changed since preview');
    const current=await fs.lstat(file,{bigint:true}).catch(error=>{if(error?.code==='ENOENT')return undefined;throw error});
    if(!current||current.isSymbolicLink()||current.dev!==st.dev||current.ino!==st.ino)fail('Log entry changed during verification');
    const result={dev:String(st.dev),ino:String(st.ino),size:String(st.size),dir};
    await fs.unlink(file);
    const gone=await fs.lstat(file).then(()=>false,error=>{if(error?.code==='ENOENT')return true;throw error});
    if(!gone)fail('删除后日志仍然存在');
    return result;
  }finally{await handle.close().catch(()=>{})}
}
async function dropHusk(dir){try{return await unlinkHusk(dir)}catch{return false}}

async function executeWin32Plan(opts){
  if(opts.offlineConfirmed!==true&&opts.liveConfirmed!==true)fail('Explicit confirmation required');
  if(!WIN32)fail('Windows only');
  const {f,p}=await loadPlan(opts);const lease='Local\\dsh-session-lock-'+hash(path.resolve(path.dirname(f),LOCK).toLowerCase());
  await runNative(composeNative(opts.liveConfirmed!==true),{CLEANER_FILE:f,CLEANER_SHA:p.sha,CLEANER_LEASE:lease,CLEANER_PID:String(process.pid)});
  return {sessionId:p.sessionId,bytes:Number(p.sig[2]),deletedFiles:1};
}
async function executePosixPlan(opts){
  if(opts.offlineConfirmed!==true&&opts.liveConfirmed!==true)fail('Explicit confirmation required');
  if(WIN32)fail('POSIX only');
  const {f,p}=await loadPlan(opts);
  const lease=await acquireWriteLock(path.dirname(f));
  try{
    // The plan was signed before arbitration; take the writer lock first, then prove
    // the bytes on disk are still the ones the user previewed.
    const entries=(await fs.readdir(path.dirname(f))).filter(name=>name!==LOCK);
    if(entries.length!==1||entries[0]!==path.basename(f))fail('Refusing multiple generations or unexpected session-local artifacts');
    if(JSON.stringify(await oneFile(f))!==JSON.stringify(p.sig))fail('Log content changed since preview');
    const done=await removeUnderLock(f,p.sha);
    if(done.dev!==p.sig[0]||done.ino!==p.sig[1]||done.size!==p.sig[2])fail('Log identity changed since preview');
    await dropHusk(done.dir);
    return {sessionId:p.sessionId,bytes:Number(done.size),deletedFiles:1};
  }finally{await lease.release();}
}
async function executePlan(opts){return WIN32?executeWin32Plan(opts):executePosixPlan(opts);}

// Delete one already-previewed log by its verified content hash. Used when the
// signed plan expired or lost its archive epoch: the hash still proves the bytes
// are the ones the user previewed. Live mode keeps the writer arbitration, so an
// active writer still refuses.
async function removeWin32Verified({file,sha,liveConfirmed}){
  if(liveConfirmed!==true)fail('Explicit confirmation required');
  if(!WIN32)fail('Windows only');
  rootPath(file);if(typeof sha!=='string'||!/^[0-9a-f]{64}$/.test(sha))fail('Invalid content hash');
  const dir=path.dirname(file);await checkDir(dir);const entries=(await fs.readdir(dir)).filter(name=>name!==LOCK);if(entries.length!==1||entries[0]!==path.basename(file))fail('Refusing multiple generations or unexpected session-local artifacts');
  const actual=await digest(file);if(actual!==sha)fail('Log content changed since preview');
  const bytes=Number((await fs.stat(file)).size);
  const lease='Local\\dsh-session-lock-'+hash(path.resolve(path.join(dir,LOCK)).toLowerCase());
  await runNative(nativeLive,{CLEANER_FILE:file,CLEANER_SHA:sha,CLEANER_LEASE:lease,CLEANER_PID:String(process.pid)});
  return {file,bytes};
}
async function removePosixVerified({file,sha,liveConfirmed}){
  if(liveConfirmed!==true)fail('Explicit confirmation required');
  if(WIN32)fail('POSIX only');
  rootPath(file);if(typeof sha!=='string'||!/^[0-9a-f]{64}$/.test(sha))fail('Invalid content hash');
  const dir=path.dirname(file);await checkDir(dir);
  const lease=await acquireWriteLock(dir);
  try{
    const done=await removeUnderLock(file,sha);
    await dropHusk(dir);
    return {file,bytes:Number(done.size)};
  }finally{await lease.release();}
}
async function removeVerified(options){return WIN32?removeWin32Verified(options):removePosixVerified(options);}
module.exports={preparePlan,executePlan,inspectPlan:loadPlan,removeVerified,explain,composeNative,LOCK,
  __posix:{acquireWriteLock,removeUnderLock,dropHusk,flockEntry,flockBinary,executePosixPlan,removePosixVerified}};
