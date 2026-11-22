window.__ModuleLoader__.load({
  id: '@local/dsh-session-cleaner',
  factory() {
    const clean = value => String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 160);
    const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
    const post = async (path, body) => {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        // The Host answers an unregistered route with a plain-text 404 (or 401 before
        // authentication); report that instead of a raw JSON syntax error.
        const hint = response.status === 404
          ? '插件 Host 未载入（HTTP 404），请完全退出并重开 DSH 后再试'
          : response.status === 401
            ? '这次请求未通过 DSH 认证（HTTP 401），请刷新页面后重试'
            : `插件接口返回了非 JSON 响应（HTTP ${response.status}）`;
        throw Error(`${hint}：${clean(text).slice(0, 120) || '空响应'}`);
      }
      return data;
    };
    return {
      inject: ['contextMenus', 'workspaces', 'sessions', 'locale'],
      apply(ctx) {
        const ns = 'localSessionCleaner';
        const zh = {
          menu: '永久删除…',
          need: '请先归档这条会话；删除只对已归档会话生效。',
          untitled: '无标题',
          confirm: '永久删除「{title}」？\n\n会话 ID：{id}\n日志 {bytes} 字节，不进回收站，无法恢复。',
          confirmTree: '「{title}」有 {count} 个子会话，删除父会话会连同它们一起永久删除：\n\n{list}\n\n删除后均无法恢复，确认吗？',
          subagentHint: '（子代理）',
          more: '…另外还有 {count} 个',
          done: '已永久删除「{title}」，移除 {deleted} 份日志、{bytes} 字节。',
          queued: '「{title}」正被 DSH 占用，已排队：下次启动 DSH 时会自动删除它（重启后不必再点一次）。',
          doneStale: '「{title}」的日志已删除（{bytes} 字节），列表会随下次刷新消失。',
          fail: '未删除：{error}'
        };
        const en = {
          menu: 'Delete permanently…',
          need: 'Archive this session first; deletion only applies to archived sessions.',
          untitled: 'Untitled',
          confirm: 'Permanently delete "{title}"?\n\nSession ID: {id}\n{bytes} bytes of session log. It does not go to the Recycle Bin and cannot be undone.',
          confirmTree: '"{title}" has {count} child sessions. Deleting it also permanently deletes:\n\n{list}\n\nNone of this can be undone. Continue?',
          subagentHint: ' (subagent)',
          more: '…and {count} more',
          done: 'Permanently deleted "{title}"; {deleted} logs and {bytes} bytes removed.',
          queued: '"{title}" is still held by DSH, so it is queued: it will be deleted automatically on the next DSH start.',
          doneStale: 'Deleted "{title}" ({bytes} bytes); the row clears on the next list refresh.',
          fail: 'Not deleted: {error}'
        };
        ctx.effect(() => ctx.locale.register(ns, { zh, en }));
        const t = (key, values) => fill(String(ctx.locale.bind(ns)(key) ?? key), values ?? {});
        const fail = error => ctx.contextMenus.notify(t('fail', { error: clean(error?.message ?? error) || '?' }), false);

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
              let info;
              try { info = await post('/api/session-cleaner/inspect', { sessionId }); }
              catch (error) { fail(error); return; }
              if (!info?.ok) { fail(info?.error ?? '?'); return; }
              const children = Array.isArray(info.children) ? info.children : [];
              let message = t('confirm', { title, id, bytes: info.bytes ?? 0 });
              if (children.length > 0) {
                const shown = children.slice(0, 5).map(child => `· ${clean(child.title) || clean(child.id)}${child.origin === 'subagent' ? t('subagentHint') : ''}`);
                if (children.length > shown.length) shown.push(t('more', { count: children.length - shown.length }));
                message = t('confirmTree', { title, count: children.length, list: shown.join('\n') });
              }
              if (!window.confirm(message)) return;
              let data;
              try {
                data = await post('/api/session-cleaner/delete', { sessionId, withChildren: children.length > 0 });
              } catch (error) { fail(error); return; }
              if (!data?.ok) { fail(data?.error ?? '?'); return; }
              if (data.queued) { ctx.contextMenus.notify(t('queued', { title }), true); return; }
              try { await ctx.sessions.refresh(); } catch { /* the row clears on the next refresh */ }
              let still = false;
              try { still = ctx.sessions.list.getSnapshot().ids.includes(sessionId); } catch { /* snapshot shape changed */ }
              ctx.contextMenus.notify(still
                ? t('doneStale', { title, bytes: data.bytes ?? 0 })
                : t('done', { title, bytes: data.bytes ?? 0, deleted: data.deleted ?? 1 }), true);
            }
          }]
        }));
      }
    };
  }
});