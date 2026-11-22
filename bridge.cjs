'use strict';
const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sid = /^[A-Za-z0-9_-]{1,160}$/;
async function safeDir(d) {
  if (typeof d !== 'string' || !path.isAbsolute(d) || path.resolve(d) !== d) throw Error('需要本机绝对目录');
  for(let p=d;;p=path.dirname(p)) {const s=await fs.lstat(p); if(!s.isDirectory() || s.isSymbolicLink()) throw Error('不接受重定向目录'); if(p===path.dirname(p)) break;}
  const real=await fs.realpath(d);
  if(process.platform==='win32'? real.toLowerCase()!==d.toLowerCase() : real!==d) throw Error('目录位置不匹配');
}
// Windows keeps its state under %LOCALAPPDATA%; POSIX (Linux, Android Termux, macOS)
// follows the XDG state directory so the plugin works without any Windows shell.
async function baseDir() {
  let base;
  if (process.platform === 'win32') {
    const parent=process.env.LOCALAPPDATA;if(!parent)throw Error('需要本机 Windows 用户目录');
    await safeDir(parent);
    base=path.join(parent,'DshSessionCleaner-v1');
  } else {
    const home=process.env.HOME;
    const state=process.env.XDG_STATE_HOME || (home ? path.join(home,'.local','state') : undefined);
    if(!state)throw Error('需要本机用户目录');
    base=path.join(state,'dsh-session-cleaner');
  }
  await fs.mkdir(base,{recursive:true,mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  await safeDir(base);
  return base;
}
async function readMessage(file) {
  const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>16384)throw Error('无效请求文件');
  return JSON.parse(await fs.readFile(file,'utf8'));
}
async function publish(dir,name,data){const temp=path.join(dir,randomUUID()+'.tmp');await fs.writeFile(temp,JSON.stringify(data),{flag:'wx',mode:0o600});try{await fs.rename(temp,path.join(dir,name));}finally{await fs.unlink(temp).catch(()=>{});}}
async function start(prepare) {
  const base=await baseDir(), dir=path.join(base,`host-${process.pid}-${randomUUID()}`);
  await fs.mkdir(dir,{mode:0o700});await safeDir(dir);
  let busy=false, stopped=false;const running=new Set();
  async function accept(name){const requestId=name.slice(0,-4);if(stopped||!uuid.test(requestId)||!name.endsWith('.req')||running.has(requestId))return;
    running.add(requestId);const request=path.join(dir,name);let acquired=false;
    try {const data=await readMessage(request);await fs.unlink(request);if(!sid.test(data.sessionId)||typeof data.sessionId!=='string')throw Error('无效的会话 ID');
      if(busy)throw Error('另一项预览正在运行');busy=true;acquired=true;const result=await prepare(data.sessionId,base);if(!stopped)await publish(dir,requestId+'.res',{ok:true,...result});
    }catch(e){if(!stopped && e.code!=='ENOENT')await publish(dir,requestId+'.res',{ok:false,error:String(e.message).slice(0,1000)}).catch(()=>{});}
    finally{if(acquired)busy=false;running.delete(requestId);}
  }
  const watcher=watch(dir,(_event,n)=>{if(typeof n==='string' && n.endsWith('.req'))void accept(n).catch(()=>{});});watcher.on('error',()=>{stopped=true;watcher.close();});
  // An assistant may have observed the new instance directory just before watch() started.
  for(const n of await fs.readdir(dir))if(n.endsWith('.req'))void accept(n).catch(()=>{});
  return ()=>{stopped=true;watcher.close();/* Do not recursively delete any directory. */void fs.rmdir(dir).catch(()=>{});};
}
async function request(sessionId){if(typeof sessionId!=='string'||!sid.test(sessionId))throw Error('无效的会话 ID');const base=await baseDir();const live=[];
  for(const ent of await fs.readdir(base,{withFileTypes:true})){const m=/^host-([1-9][0-9]*)-(.+)$/.exec(ent.name);if(!m||!uuid.test(m[2])||!ent.isDirectory()||ent.isSymbolicLink())continue;
    try{process.kill(Number(m[1]),0);}catch(e){if(e.code==='ESRCH')continue;throw e;}live.push(path.join(base,ent.name));}
  if(live.length!==1)throw Error('需要恰好一个启用此插件的 DSH 桌面实例。请重启 DSH 后重试。');
  const dir=live[0];await safeDir(dir);const id=randomUUID(),out=path.join(dir,id+'.res');let watcher,timer;
  try{return await new Promise((resolve,reject)=>{
    watcher=watch(dir,(_e,n)=>{if(n===id+'.res')readMessage(out).then(resolve,reject);});watcher.on('error',reject);
    timer=setTimeout(()=>reject(Error('Host 预览超时，请检查 DSH 后重试。')),90000);publish(dir,id+'.req',{sessionId}).catch(reject);
  });}finally{clearTimeout(timer);watcher?.close();await Promise.all(['.res','.req'].map(ext=>fs.unlink(path.join(dir,id+ext)).catch(()=>{})));}
}
module.exports={start,request,baseDir,safeDir};
