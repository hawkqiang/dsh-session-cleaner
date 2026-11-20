import path from 'node:path';
import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import bridge from './bridge.cjs';
import core from './core.cjs';
import host from './host.cjs';

export const inject=['workspaceRegistry','sessionPersistence','connection'];
// Bump together with package.json. The startup line in host.log proves which
// Host code the running DSH actually loaded.
const VERSION='1.3.3';
export function apply(ctx){
  if(process.platform!=='win32')return;
  let stop,disposed=false,revision=0,guard,failed=false,planDir,logFile;
  // Diagnostics only: a rejection reason the page saw, so a failure can be explained
  // later without reproducing it. Never records chat content.
  async function note(line){
    if(!logFile)return;
    try{
      const stamp=new Date().toISOString();
      const old=await fs.readFile(logFile,'utf8').catch(()=>'');
      const lines=old.split('\n').filter(Boolean);
      lines.push(`${stamp} ${line}`);
      await fs.writeFile(logFile,lines.slice(-200).join('\n')+'\n',{mode:0o600});
    }catch{/* diagnostics must never break the operation */}
  }
  // Session unarchive runs inside the registry queue before it changes membership.
  async function invalidate(){revision++;if(!guard)return;const tmp=guard+'.'+randomUUID();try{await fs.writeFile(tmp,randomUUID(),{flag:'wx',mode:0o600});await fs.rename(tmp,guard);}catch(e){failed=true;throw e;}finally{await fs.unlink(tmp).catch(()=>{});}}
  ctx.on('workspace/session-unarchiving',invalidate);

  const archived=id=>ctx.workspaceRegistry.archivedSessionIds.includes(id);

  // Inspect the verified target and its descendant tree before the page asks for
  // confirmation, so the dialog can name what a cascade removal would destroy.
  async function inspectArchived(sessionId){
    if(failed||disposed||!planDir||!guard)throw Error('插件尚未就绪，请重开 DSH');
    if(!archived(sessionId))throw Error('该会话未归档，删除只对已归档会话生效');
    return host.describeTree({sessionId,snapshots:await ctx.sessionPersistence.list()});
  }

  // Verify the provider snapshot, plan, delete with the writer semaphore held, then
  // prove every log is gone. Shared by the page route and the external assistant.
  async function deleteArchived(sessionId,withChildren){
    if(failed||disposed||!planDir||!guard)throw Error('插件尚未就绪，请重开 DSH');
    if(!archived(sessionId))throw Error('该会话未归档，已拒绝删除');
    const snapshots=await ctx.sessionPersistence.list();
    const at=revision;
    return host.removeTree({sessionId,snapshots,planDir,guard,core,withChildren,
      list:()=>ctx.sessionPersistence.list(),
      stillValid:()=>!disposed&&!failed&&at===revision&&archived(sessionId)});
  }

  // Same-origin page routes: the browser reaches them through DSH's authenticated
  // API channel, so the client needs no token of its own.
  ctx.effect(()=>{
    const readId=body=>typeof body?.sessionId==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(body.sessionId);
    const inspect=ctx.connection.fetch.register({
      path:'/api/session-cleaner/inspect',
      methods:['POST'],
      requestBody:'buffered',
      fetch:async request=>{
        let body;try{body=await request.json();}catch{return Response.json({ok:false,error:'请求格式错误'},{status:400});}
        if(!readId(body))return Response.json({ok:false,error:'无效的会话 ID'},{status:400});
        try{return Response.json({ok:true,...await inspectArchived(body.sessionId)});}
        catch(e){const message=String(e?.message??e).slice(0,300);await note(`inspect ${body.sessionId} refused: ${message}`);return Response.json({ok:false,error:message});}
      }
    });
    const remove=ctx.connection.fetch.register({
      path:'/api/session-cleaner/delete',
      methods:['POST'],
      requestBody:'buffered',
      fetch:async request=>{
        let body;try{body=await request.json();}catch{return Response.json({ok:false,error:'请求格式错误'},{status:400});}
        if(!readId(body))return Response.json({ok:false,error:'无效的会话 ID'},{status:400});
        try{return Response.json({ok:true,...await deleteArchived(body.sessionId,body.withChildren===true)});}
        catch(e){const message=String(e?.message??e).slice(0,300);await note(`delete ${body.sessionId} failed: ${message}`);return Response.json({ok:false,error:message});}
      }
    });
    return ()=>{for(const dispose of [inspect,remove])void Promise.resolve(dispose()).catch(()=>{});};
  });

  ctx.effect(()=>{
    const startup=(async()=>{
      const base=await bridge.baseDir(),profile=process.env.DSH_PROFILE_DIR ? await fs.realpath(process.env.DSH_PROFILE_DIR) : base;
      const key=createHash('sha256').update(profile.toLowerCase()).digest('hex');planDir=path.join(base,'plans-'+key);
      logFile=path.join(base,'host.log');
      guard=path.join(base,'archive-epoch-'+key);await invalidate();if(disposed)return;
      await note(`host started v${VERSION} profile=${path.basename(profile)} pid=${process.pid}`);
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