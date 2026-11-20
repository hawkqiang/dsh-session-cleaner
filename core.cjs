'use strict';
// Offline maintenance for the Windows JSONL provider shipped in DSH 0.2.2-rc.5.
// Not a generic file remover. All roots, archive and snapshot facts come from the Host.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const TTL=10*60*1000;
const fail=m=>{throw Error(m)};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function simpleId(s){return typeof s==='string' && /^[A-Za-z0-9_-]{1,160}$/.test(s) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(s)}
function rootPath(p){if(typeof p!=='string'||!path.isAbsolute(p)||path.resolve(p)!==p||path.parse(p).root===p|| (process.platform==='win32' && (!/^[A-Za-z]:\\/.test(p)||/[\x00-\x1f<>:"|?*]/.test(p.slice(2))||p.slice(3).split('\\').some(x=>/[. ]$/.test(x)))))fail('Expected canonical absolute local path');return p}
async function checkDir(p){rootPath(p);for(let q=p;;q=path.dirname(q)){const s=await fs.lstat(q);if(!s.isDirectory()||s.isSymbolicLink())fail('Unexpected directory type');if(q===path.dirname(q))break}if(path.normalize(await fs.realpath(p)).toLowerCase()!==p.toLowerCase())fail('Redirected directory');}
async function oneFile(f){await checkDir(path.dirname(f));const s=await fs.lstat(f,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size>BigInt(Number.MAX_SAFE_INTEGER))fail('Expected a single-link regular file');return [String(s.dev),String(s.ino),String(s.size),String(s.mtimeNs),String(s.ctimeNs)]}
async function digest(f){const h=await fs.open(f,'r');try{const s=await h.stat({bigint:true});if(!s.isFile()||s.nlink!==1n)fail('Unsafe log');const sum=crypto.createHash('sha256');for await(const chunk of h.createReadStream({autoClose:false}))sum.update(chunk);return sum.digest('hex')}finally{await h.close()}}
function admit({sessionId,archived,snapshots}){
 if(!simpleId(sessionId)||archived!==true||!Array.isArray(snapshots))fail('Archived session with verified provider inventory required');
 const seen=new Set();let target;for(const s of snapshots){const h=s?.header;if(!h||typeof h.id!=='string'||seen.has(h.id)||h.version!==4)fail('Incomplete or ambiguous provider inventory');seen.add(h.id);if(h.parentSession===sessionId)fail('Session has child sessions');if(h.id===sessionId)target=s}
 const h=target?.header;if(!h||target.formatStatus!=='current'||target.location?.kind!=='jsonl'||h.isSeeded!==false||h.parentSession!==undefined||h.origin!==undefined||(h.delegationDepth??0)!==0)fail('Only independent current-format JSONL sessions qualify');return target;
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
async function singleGeneration(f){const a=await fs.readdir(path.dirname(f));if(a.length!==1||a[0]!==path.basename(f))fail('Refusing multiple generations or unexpected session-local artifacts');return oneFile(f)}
async function privateDir(d,root,create){rootPath(d);rootPath(root);for(const [a,b] of [[d,root],[root,d]]){const rel=path.relative(a,b);if(rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)))fail('Plan directory must be separate from store')}if(create){await checkDir(path.dirname(d));await fs.mkdir(d,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e})}await checkDir(d)}
async function keyAt(d,create){const f=path.join(d,'plan-auth.key');if(create){try{await fs.writeFile(f,crypto.randomBytes(32),{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e}}await oneFile(f);const k=await fs.readFile(f);if(k.length!==32)fail('Bad local plan key');return k}
function mac(k,p){return crypto.createHmac('sha256',k).update(JSON.stringify(p)).digest('hex')}
async function preparePlan({root,sessionId,archived,snapshots,planDir,archiveStateFile}){
 const epoch=rootPath(archiveStateFile),epochSig=await oneFile(epoch);const s=admit({sessionId,archived,snapshots});const f=s.location.path;const rel=location(root,f,sessionId);const cs=await census(root,snapshots);const sig=await singleGeneration(f);const sha=await digest(f);if(JSON.stringify(sig)!==JSON.stringify(await singleGeneration(f))||Number(sig[2])!==s.sizeBytes||cs!==await census(root))fail('Storage changed during planning');
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
$procs=@(Get-CimInstance Win32_Process -ErrorAction Stop)
if (!$procs.Count) {throw 'Cannot verify DSH shutdown'}
foreach($p in $procs){if ($p.ProcessId -eq $PID -or $p.ProcessId -eq [int]$env:CLEANER_PID){continue};if($p.Name -match '^(DeepSeek[ -]?Harness|dsh)(\.exe)?$'){throw 'Close DSH Desktop and CLI first'};if($p.Name -match '^(node|electron|bun|deno)(\.exe)?$'){if(!$p.CommandLine -or !$p.ExecutablePath){throw 'Cannot verify runtime process'};if(($p.CommandLine+' '+$p.ExecutablePath) -match '(?i)(deepseek[ -]harness|[\\/]dsh(?:[\\/.\s"]|$)|@deepseek-ai[\\/]dsh)'){throw 'Close all DSH runtimes first'}}}
[ScopedLogRemoval]::Remove($env:CLEANER_FILE,$env:CLEANER_SHA,$env:CLEANER_LEASE)
`;
// Live mode keeps every check except the "all DSH processes are closed" gate: the
// same per-session writer semaphore and exclusive handle still guard the deletion.
const nativeLive=(()=>{const gate=native.indexOf('$procs=@(Get-CimInstance'),call=native.indexOf('[ScopedLogRemoval]::Remove');if(gate<0||call<=gate)return native;return native.slice(0,gate)+native.slice(call)})();
async function executePlan(opts){
  if(opts.offlineConfirmed!==true&&opts.liveConfirmed!==true)fail('Explicit confirmation required');
  if(process.platform!=='win32')fail('Windows only');
  const {f,p}=await loadPlan(opts);const lease='Local\\dsh-session-lock-'+hash(path.resolve(path.dirname(f),'session.lock').toLowerCase());const script=opts.liveConfirmed===true?nativeLive:native;const exe=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  await new Promise((res,rej)=>{const cp=spawn(exe,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio:'inherit',windowsHide:true,env:{...process.env,CLEANER_FILE:f,CLEANER_SHA:p.sha,CLEANER_LEASE:lease,CLEANER_PID:String(process.pid)}});cp.once('error',rej);cp.once('exit',code=>code===0?res():rej(Error('Safety checks or Windows deletion failed; see diagnostic output')))});
  return {sessionId:p.sessionId,bytes:Number(p.sig[2]),deletedFiles:1};
}
module.exports={preparePlan,executePlan,inspectPlan:loadPlan,removeVerified};

// Delete one already-previewed log by its verified content hash. Used when the
// signed plan expired or lost its archive epoch: the hash still proves the bytes
// are the ones the user previewed. Live mode keeps the writer semaphore and the
// exclusive handle, so an active writer or an open reader still refuses.
async function removeVerified({file,sha,liveConfirmed}){
  if(liveConfirmed!==true)fail('Explicit confirmation required');
  if(process.platform!=='win32')fail('Windows only');
  rootPath(file);if(typeof sha!=='string'||!/^[0-9a-f]{64}$/.test(sha))fail('Invalid content hash');
  const dir=path.dirname(file);await checkDir(dir);const entries=await fs.readdir(dir);if(entries.length!==1||entries[0]!==path.basename(file))fail('Refusing multiple generations or unexpected session-local artifacts');
  const actual=await digest(file);if(actual!==sha)fail('Log content changed since preview');
  const bytes=Number((await fs.stat(file)).size);
  const lease='Local\\dsh-session-lock-'+hash(path.resolve(path.join(dir,'session.lock')).toLowerCase());
  const exe=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  await new Promise((res,rej)=>{const cp=spawn(exe,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(nativeLive,'utf16le').toString('base64')],{stdio:'inherit',windowsHide:true,env:{...process.env,CLEANER_FILE:file,CLEANER_SHA:sha,CLEANER_LEASE:lease,CLEANER_PID:String(process.pid)}});cp.once('error',rej);cp.once('exit',code=>code===0?res():rej(Error('Safety checks or Windows deletion failed; see diagnostic output')))});
  return {file,bytes};
}
