window.__ModuleLoader__.load({
  id: '@local/dsh-session-cleaner',
  factory() {
    const clean = value => String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 160);
    return {
      inject: ['contextMenus', 'workspaces', 'locale'],
      apply(ctx) {
        const ns = 'localSessionCleaner';
        const zh = {menu:'准备离线清理…', need:'请先归档这条会话，然后在侧栏「视图」选择「仅显示已归档」或「全部对话」，打开目标行的 ⋯ 菜单。', copied:'ID 已复制。双击插件目录中的「清理助手.cmd」预览，退出前核对下方标题与 ID。尚未删除任何内容。', untitled:'无标题', failure:'无法复制。请从会话菜单复制 Session ID，再运行清理助手。'};
        const en = {menu:'Prepare offline cleanup…', need:'Archive this session first. In the sidebar View menu, show Archived or All conversations and open the target row menu.', copied:'ID copied. Open 清理助手.cmd in the plugin directory. Match the title and ID below before exiting. Nothing has been deleted.', untitled:'Untitled', failure:'Copy failed. Copy the session ID from the menu, then open the cleanup assistant.'};
        ctx.effect(() => ctx.locale.register(ns, {zh,en}));const t=ctx.locale.bind(ns);
        ctx.effect(() => ctx.contextMenus.register({
          id:'local-session-cleaner.prepare', target:'session', order:650,
          observe:()=>[ctx.workspaces.list,ctx.locale],
          resolve:({sessionId,displayTitle})=>[{id:'prepare', label:t('menu'), failureLabel:t('failure'), afterContent:true,
            run:async()=>{
              if(!ctx.workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId)){ctx.contextMenus.notify(t('need'),false);return;}
              await navigator.clipboard.writeText(sessionId);
              ctx.contextMenus.notify(`${t('copied')}\n${clean(displayTitle)||t('untitled')} · ID: ${clean(sessionId)}`,true);
            }
          }]
        }));
      }
    };
  }
});
