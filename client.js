window.__ModuleLoader__.load({
  id: '@local/dsh-session-cleaner',
  factory() {
    const clean = value => String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 160);
    const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
    return {
      inject: ['contextMenus', 'workspaces', 'sessions', 'locale'],
      apply(ctx) {
        const ns = 'localSessionCleaner';
        const zh = {
          menu: '永久删除…',
          need: '请先归档这条会话；删除只对已归档会话生效。',
          untitled: '无标题',
          confirm: '永久删除「{title}」？\n\n会话 ID：{id}\n将删除磁盘上的会话日志，不进回收站，无法恢复。',
          done: '已永久删除「{title}」，日志文件 {bytes} 字节已移除。',
          doneStale: '「{title}」的日志已删除（{bytes} 字节），列表会随下次刷新消失。',
          fail: '未删除：{error}'
        };
        const en = {
          menu: 'Delete permanently…',
          need: 'Archive this session first; deletion only applies to archived sessions.',
          untitled: 'Untitled',
          confirm: 'Permanently delete "{title}"?\n\nSession ID: {id}\nThis removes the session log from disk. It does not go to the Recycle Bin and cannot be undone.',
          done: 'Permanently deleted "{title}"; {bytes} bytes of session log removed.',
          doneStale: 'Permanently deleted "{title}" ({bytes} bytes of log); the row clears on the next list refresh.',
          fail: 'Not deleted: {error}'
        };
        ctx.effect(() => ctx.locale.register(ns, { zh, en }));
        const t = (key, values) => fill(String(ctx.locale.bind(ns)(key) ?? key), values ?? {});
        ctx.effect(() => ctx.contextMenus.register({
          id: 'local-session-cleaner.delete',
          target: 'session',
          order: 650,
          observe: () => [ctx.workspaces.list, ctx.locale],
          resolve: ({ sessionId, displayTitle }) => [{
            id: 'delete', label: t('menu'), failureLabel: t('fail', { error: '?' }), afterContent: true,
            run: async () => {
              const archived = ctx.workspaces.list.getSnapshot().archivedSessionIds;
              if (!archived.includes(sessionId)) { ctx.contextMenus.notify(t('need'), false); return; }
              const title = clean(displayTitle) || t('untitled');
              const id = clean(sessionId);
              if (!window.confirm(t('confirm', { title, id }))) return;
              let data;
              try {
                const response = await fetch('/api/session-cleaner/delete', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sessionId })
                });
                data = await response.json();
              } catch (error) {
                ctx.contextMenus.notify(t('fail', { error: clean(error?.message ?? error) }), false);
                return;
              }
              if (!data?.ok) {
                ctx.contextMenus.notify(t('fail', { error: clean(data?.error) || '?' }), false);
                return;
              }
              try { await ctx.sessions.refresh(); } catch { /* the row disappears on the next refresh */ }
              let still = false;
              try { still = ctx.sessions.list.getSnapshot().ids.includes(sessionId); } catch { /* snapshot shape changed */ }
              ctx.contextMenus.notify(t(still ? 'doneStale' : 'done', { title, bytes: data.bytes ?? 0 }), true);
            }
          }]
        }));
      }
    };
  }
});