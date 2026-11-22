'use strict';
// One-confirmation helper: reads the session ID copied by the DSH menu from the
// clipboard, previews the verified target, then deletes it while DSH keeps running.
// The plan is requested again right before deletion, so an expired plan or a bumped
// archive epoch cannot make the confirmation act on stale facts.
const {createInterface}=require('node:readline/promises');
const {stdin,stdout}=require('node:process');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const bridge=require('./bridge.cjs');
const core=require('./core.cjs');
const sid=/^[A-Za-z0-9_-]{1,160}$/;
const SUPPORTED=new Set(['win32','linux','darwin','android']);
function run(bin,args){try{return String(execFileSync(bin,args,{encoding:'utf8',timeout:5000,windowsHide:true})).trim()}catch{return ''}}
// Windows reads the clipboard through PowerShell; Termux has its own clipboard
// helper, and desktop POSIX falls back to the usual Wayland/X11/macOS tools.
function clipboardId(){
  let text='';
  if(process.platform==='win32'){
    text=run(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command','Get-Clipboard -Raw']);
  }else if(process.platform==='darwin'){
    text=run('pbpaste',[]);
  }else{
    for(const [bin,args] of [['termux-clipboard-get',[]],['wl-paste',['-n']],['xclip',['-o','-selection','clipboard']],['xsel',['-ob']]]){
      const out=run(bin,args);if(out){text=out;break}
    }
  }
  return sid.test(text)?text:'';
}
async function planFor(id){
  const r=await bridge.request(id);
  if(!r.ok)throw Error(r.error||'DSH 拒绝了请求');
  const base=await bridge.baseDir();
  if(typeof r.planDir!=='string'||path.dirname(r.planDir)!==base||!/^plans-[a-f0-9]{64}$/.test(path.basename(r.planDir))||r.sessionId!==id)throw Error('计划身份或目录不符');
  const opts={root:r.root,planDir:r.planDir,planId:r.planId,sessionId:id};
  const {p,f}=await core.inspectPlan(opts);
  return {opts,p,f};
}
async function main(){
  if(!SUPPORTED.has(process.platform))throw Error('仅支持 Windows、Linux、macOS 与 Termux');
  if(process.versions.electron||!stdin.isTTY||!stdout.isTTY)throw Error('请在本机独立的终端中启动助手。');
  const rl=createInterface({input:stdin,output:stdout});
  try{
    const guess=clipboardId();
    console.log('清理单个会话 · 无需归档 · 预览阶段不删除。');
    if(guess)console.log(`剪贴板中的会话 ID：${guess}`);
    const answer=(await rl.question(guess?'直接回车使用上面的 ID，或粘贴另一个（回车取消）：':'粘贴会话 ID（回车取消）：')).trim();
    const id=answer||guess;
    if(!id)return console.log('已取消。');
    if(!sid.test(id))return console.log('不是有效的会话 ID。请从会话菜单的「准备清理…」复制。');

    const first=await planFor(id);
    console.log(`\n目标：${first.f}\n日志大小：${first.p.sig[2]} 字节（不等于磁盘实际释放量）`);
    console.log('将永久删除且仅删除这份日志，不进入回收站；搜索索引、附件不会被清除。');
    console.log('DSH 可以保持打开。如需备份请先取消并自行导出。');
    const yes=(await rl.question('\n确认永久删除？输入 y 回车执行，其他任意输入取消：')).trim().toLowerCase();
    if(yes!=='y')return console.log('已取消，未删除任何文件。');

    console.log('正在向 DSH 重新核验目标…');
    const fresh=await planFor(id);
    if(fresh.f!==first.f)throw Error('目标文件在确认后发生变化，已中止');
    const done=await core.executePlan({...fresh.opts,liveConfirmed:true});
    console.log(`\n已删除 ${done.deletedFiles} 份日志（${done.bytes} 字节）。`);
    console.log('回到 DSH 按 F5 刷新侧栏；该会话应从列表中消失。若仍显示，请完全退出再打开 DSH。');
  }finally{rl.close();}
}
if(require.main===module)main().catch(e=>{console.error('未完成：'+e.message);process.exitCode=1;});