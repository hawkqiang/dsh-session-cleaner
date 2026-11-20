'use strict';
const {createInterface}=require('node:readline/promises');const {stdin,stdout}=require('node:process');const path=require('node:path');const fs=require('node:fs/promises');const bridge=require('./bridge.cjs');const core=require('./core.cjs');
async function main(){if(process.platform!=='win32'||process.versions.electron||!stdin.isTTY||!stdout.isTTY)throw Error('请在本机独立的 Windows 终端中通过 Node.js 启动助手。');const rl=createInterface({input:stdin,output:stdout});try{
 console.log('单会话日志清理 · 预览不删除文件。请先归档目标，对其使用「准备离线清理」。');const id=(await rl.question('粘贴会话 ID（回车取消）：')).trim();if(!id)return;const r=await bridge.request(id);if(!r.ok)throw Error(r.error||'Host 拒绝请求');const base=await bridge.baseDir();if(typeof r.planDir!=='string'||path.dirname(r.planDir)!==base||!/^plans-[a-f0-9]{64}$/.test(path.basename(r.planDir))||r.sessionId!==id)throw Error('计划身份或目录不符');const opts={root:r.root,planDir:r.planDir,planId:r.planId,sessionId:id};const {p,f}=await core.inspectPlan(opts);
 console.log(`\n会话：${id}\n目标：${f}\n日志大小：${p.sig[2]} 字节（不等于磁盘实际释放量）\n将永久删除且仅删除上述日志，不进入回收站。搜索索引、附件等不会被清除。`);
 console.log('退出前请回到 DSH 目标会话行，重新打开「准备离线清理」，核对通知中的会话标题及 ID 与上方预览相符。请勿只把剪贴板内容重复粘贴作为确认。如需备份，请先取消并自行导出。这份计划仅在十分钟内有效。保持归档，不要创建新会话；完全退出所有 DSH Desktop、CLI 和后台 Host。在本助手返回前不要重新启动 DSH。');const confirm=await rl.question('确认已退出 DSH，并永久删除？请重新输入完整会话 ID，直接回车则取消：');if(confirm!==id){console.log('已取消；未删除日志。');return;}
 const done=await core.executePlan({...opts,offlineConfirmed:true});console.log(`已删除 ${done.deletedFiles} 个日志（${done.bytes} 字节）。现在可以重新打开 DSH。`);
 }finally{rl.close();}}
if(require.main===module)main().catch(e=>{console.error('未完成：'+e.message);process.exitCode=1;});
