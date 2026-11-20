import path from 'node:path';
import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import bridge from './bridge.cjs';
import core from './core.cjs';

export const inject=['workspaceRegistry','sessionPersistence','connection'];
export function apply(ctx){
  if(process.platform!=='win32')return;
  let stop,disposed=false,revision=0,guard,failed=false,planDir;
  // Session unarchive runs inside the registry queue before it changes membership.
  async function invalidate(){revision++;if(!guard)return;const tmp=guard+'.'+randomUUID();try{await fs.writeFile(tmp,randomUUID(),{flag:'wx',mode:0o600});await fs.rename(tmp,guard);}catch(e){failed=true;throw e;}finally{await fs.unlink(tmp).catch(()=>{});}}
  ctx.on('workspace/session-unarchiving',invalidate);

  const archived=id=>ctx.workspaceRegistry.archivedSessionIds.includes(id);

  // Verify the provider snapshot, plan, delete with the writer semaphore held, then
  // prove the log is gone. Shared by the page route and the external assistant.
  async function deleteArchived(sessionId){
    if(failed||disposed||!planDir||!guard)throw Error('插件尚未就绪，请重开 DSH');
    if(!archived(sessionId))throw Error('该会话未归档，已拒绝删除');
    const snapshots=await ctx.sessionPersistence.list();
    const target=snapshots.find(x=>x.header?.id===sessionId);
    if(!target||target.location?.kind!=='jsonl')throw Error('找不到受支持的 JSONL 会话');
    const file=target.location.path,root=path.dirname(path.dirname(path.dirname(file)));
    if(snapshots.some(s=>s.location?.kind!=='jsonl'||typeof s.location?.path!=='string'||path.dirname(path.dirname(path.dirname(s.location.path)))!==root))throw Error('无法验证统一的存储边界');
    const at=revision;
    const plan=await core.preparePlan({root,sessionId,archived:true,snapshots,planDir,archiveStateFile:guard});
    if(disposed||failed||at!==revision||!archived(sessionId))throw Error('归档状态已变化，请重试');
    const done=await core.executePlan({root,planDir,planId:plan.planId,sessionId,liveConfirmed:true});
    try{await fs.stat(file);throw Error('删除后日志仍然存在')}catch(e){if(e.code!=='ENOENT')throw e}
    return {bytes:done.bytes,title:typeof target.header?.title==='string'?target.header.title:undefined};
  }

  // Same-origin page route: the browser reaches it through DSH's authenticated API
  // channel, so the client needs no token of its own.
  ctx.effect(()=>{
    const dispose=ctx.connection.fetch.register({
      path:'/api/session-cleaner/delete',
      methods:['POST'],
      requestBody:'buffered',
      fetch:async request=>{
        let body;try{body=await request.json();}catch{return Response.json({ok:false,error:'请求格式错误'},{status:400});}
        const sessionId=body?.sessionId;
        if(typeof sessionId!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId))return Response.json({ok:false,error:'无效的会话 ID'},{status:400});
        try{return Response.json({ok:true,...await deleteArchived(sessionId)});}
        catch(e){return Response.json({ok:false,error:String(e?.message??e).slice(0,300)});}
      }
    });
    return ()=>{void Promise.resolve(dispose()).catch(()=>{});};
  });

  ctx.effect(()=>{
    const startup=(async()=>{
      const base=await bridge.baseDir(),profile=process.env.DSH_PROFILE_DIR ? await fs.realpath(process.env.DSH_PROFILE_DIR) : base;
      const key=createHash('sha256').update(profile.toLowerCase()).digest('hex');planDir=path.join(base,'plans-'+key);
      guard=path.join(base,'archive-epoch-'+key);await invalidate();if(disposed)return;
      const halt=await bridge.start(async(sessionId)=>{
        if(disposed||!archived(sessionId))throw Error('该会话未归档，或插件状态已变化。');
        const snapshots=await ctx.sessionPersistence.list();const target=snapshots.find(x=>x.header?.id===sessionId);
        if(!target||target.location?.kind!=='jsonl')throw Error('找不到受支持的 JSONL 会话');
        const file=target.location.path,root=path.dirname(path.dirname(path.dirname(file)));
        if(snapshots.some(s=>s.location?.kind!=='jsonl'||typeof s.location?.path!=='string'||path.dirname(path.dirname(path.dirname(s.location.path)))!==root))throw Error('无法验证统一的存储边界');
        const result=await core.preparePlan({root,planDir,sessionId,archived:true,snapshots,archiveStateFile:guard});
        if(disposed||failed||!archived(sessionId))throw Error('预览期间归档状态发生变化，请重新生成计划。');
        return {...result,planDir,root};
      });if(disposed)halt();else stop=halt;
    })();startup.catch(e=>console.error('[session-cleaner] Host unavailable:',e.message));
    return ()=>{disposed=true;stop?.();};
  });
}