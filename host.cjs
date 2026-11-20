'use strict';
// Host-side deletion for one eligible archived session. Kept free of cordis so the
// exact path used by the HTTP route can be exercised on synthetic stores.
const fs = require('node:fs/promises');
const path = require('node:path');

function pickTarget({sessionId, snapshots}) {
  const target = snapshots.find(x => x?.header?.id === sessionId);
  if (!target || target.location?.kind !== 'jsonl' || typeof target.location.path !== 'string') throw Error('找不到受支持的 JSONL 会话');
  const file = target.location.path;
  const root = path.dirname(path.dirname(path.dirname(file)));
  if (snapshots.some(s => s?.location?.kind !== 'jsonl' || typeof s.location.path !== 'string' || path.dirname(path.dirname(path.dirname(s.location.path))) !== root)) throw Error('无法验证统一的存储边界');
  return {target, file, root};
}

/**
 * Plan, delete and verify one session log.
 * @param options - sessionId, provider snapshots, plan directory, archive epoch file,
 *   the shared core module, and a predicate run after planning to reject a stale state.
 */
async function removePlannedSession({sessionId, snapshots, planDir, guard, core, stillValid}) {
  const {target, file, root} = pickTarget({sessionId, snapshots});
  const plan = await core.preparePlan({root, sessionId, archived: true, snapshots, planDir, archiveStateFile: guard});
  if (typeof stillValid === 'function' && !stillValid()) throw Error('归档状态已变化，请重试');
  const done = await core.executePlan({root, planDir, planId: plan.planId, sessionId, liveConfirmed: true});
  try { await fs.stat(file); throw Error('删除后日志仍然存在'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {bytes: Number(done.bytes) || 0, title: typeof target.header?.title === 'string' ? target.header.title : undefined};
}

module.exports = {removePlannedSession, pickTarget};