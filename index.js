import path from 'node:path';
import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import bridge from './bridge.cjs';
import core from './core.cjs';
export const inject=['workspaceRegistry','sessionPersistence'];
export function apply(ctx){
  if(process.platform!=='win32')return;
  let stop,disposed=false,revision=0,guard,failed=false;
  // Session unarchive runs inside the registry queue before it changes membership.
  async function invalidate(){revision++;if(!guard)return;const tmp=guard+'.'+randomUUID();try{await fs.writeFile(tmp,randomUUID(),{flag:'wx',mode:0o600});await fs.rename(tmp,guard);}catch(e){failed=true;throw e;}finally{await fs.unlink(tmp).catch(()=>{});}}
  ctx.on('workspace/session-unarchiving',invalidate);
  ctx.effect(()=>{
    const startup=(async()=>{
      const base=await bridge.baseDir(),profile=process.env.DSH_PROFILE_DIR ? await fs.realpath(process.env.DSH_PROFILE_DIR) : base;
      const key=createHash('sha256').update(profile.toLowerCase()).digest('hex');const planDir=path.join(base,'plans-'+key);
      guard=path.join(base,'archive-epoch-'+key);await invalidate();if(disposed)return;
      const halt=await bridge.start(async(sessionId)=>{
        const at=revision;const archived=()=>ctx.workspaceRegistry.archivedSessionIds.includes(sessionId);
        if(failed||disposed||!archived())throw Error('该会话未归档，或插件状态已变化。');
        const snapshots=await ctx.sessionPersistence.list();const target=snapshots.find(x=>x.header?.id===sessionId);
        if(!target||target.location?.kind!=='jsonl')throw Error('找不到受支持的 JSONL 会话');
        const file=target.location.path,root=path.dirname(path.dirname(path.dirname(file)));
        if(snapshots.some(s=>s.location?.kind!=='jsonl'||typeof s.location?.path!=='string'||path.dirname(path.dirname(path.dirname(s.location.path)))!==root))throw Error('无法验证统一的存储边界');
        const result=await core.preparePlan({root,planDir,sessionId,archived:archived(),snapshots,archiveStateFile:guard});
        if(disposed||failed||at!==revision||!archived())throw Error('预览期间归档状态发生变化，请重新生成计划。');
        return {...result,planDir,root};
      });if(disposed)halt();else stop=halt;
    })();startup.catch(e=>console.error('[session-cleaner] Host unavailable:',e.message));
    return ()=>{disposed=true;stop?.();};
  });
}
