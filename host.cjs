'use strict';
// Host-side deletion for archived sessions. Kept free of cordis so the exact path
// used by the HTTP route can be exercised on synthetic stores.
const fs = require('node:fs/promises');
const path = require('node:path');

function pickTarget({sessionId, snapshots}) {
  const target = snapshots.find(x => x?.header?.id === sessionId);
  if (!target || target.location?.kind !== 'jsonl' || typeof target.location.path !== 'string') throw Error('找不到受支持的 JSONL 会话');
  const file = target.location.path;
  const root = path.dirname(path.dirname(path.dirname(file)));
  if (snapshots.some(s => s?.location?.kind !== 'jsonl' || typeof s.location.path !== 'string' || path.dirname(path.dirname(path.dirname(s.location.path))) !== root)) throw Error('无法验证统一的存储边界');
  if (target.formatStatus !== 'current') throw Error('该会话不是当前日志格式，已拒绝');
  return {target, file, root};
}

/** Descendants of one session, deepest first, from the provider snapshot. */
function descendantsOf(snapshots, rootId) {
  const children = new Map();
  for (const s of snapshots) {
    const parent = s?.header?.parentSession;
    if (typeof parent !== 'string') continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(s);
  }
  const out = [];
  const seen = new Set([rootId]);
  const walk = id => {
    for (const child of children.get(id) ?? []) {
      const childId = child.header?.id;
      if (typeof childId !== 'string' || seen.has(childId)) throw Error('会话树存在循环引用或无效身份，已拒绝');
      seen.add(childId);
      walk(childId);
      out.push(child);
    }
  };
  walk(rootId);
  return out;
}

function describeTree({sessionId, snapshots}) {
  const {target} = pickTarget({sessionId, snapshots});
  const members = descendantsOf(snapshots, sessionId);
  const size = s => Number(s?.sizeBytes) || Number(s?.location?.sizeBytes) || 0;
  return {
    title: typeof target.header?.title === 'string' ? target.header.title : undefined,
    bytes: size(target),
    children: members.map(s => ({
      id: s.header.id,
      title: typeof s.header?.title === 'string' ? s.header.title : undefined,
      origin: typeof s.header?.origin === 'string' ? s.header.origin : undefined,
      seeded: s.header?.isSeeded === true,
    })),
  };
}

async function removeOne({sessionId, snapshots, planDir, guard, core, allowTree}) {
  const {target, file, root} = pickTarget({sessionId, snapshots});
  const plan = await core.preparePlan({root, sessionId, archived: true, snapshots, planDir, archiveStateFile: guard, allowTree});
  const done = await core.executePlan({root, planDir, planId: plan.planId, sessionId, liveConfirmed: true});
  try { await fs.stat(file); throw Error('删除后日志仍然存在'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {bytes: Number(done.bytes) || 0};
}

/**
 * Delete one session, and with `withChildren` its whole descendant tree.
 * Children go first so no surviving log keeps a parent link to a removed one.
 * @param options - sessionId, provider snapshots, plan directory, epoch file, core,
 *   `list` to re-read snapshots between deletions, `stillValid` to reject staleness.
 */
async function removeTree({sessionId, snapshots, planDir, guard, core, withChildren, list, stillValid}) {
  const members = descendantsOf(snapshots, sessionId);
  if (members.length > 0 && withChildren !== true) throw Error(`该会话有 ${members.length} 个子会话，需要同时删除才能移除`);
  const ids = [...members.map(s => s.header.id), sessionId];
  let total = 0;
  for (const id of ids) {
    if (typeof stillValid === 'function' && !stillValid()) throw Error('归档状态已变化，请重试');
    const current = typeof list === 'function' ? await list() : snapshots;
    const result = await removeOne({sessionId: id, snapshots: current, planDir, guard, core, allowTree: members.length > 0});
    total += result.bytes;
  }
  const root = snapshots.find(s => s?.header?.id === sessionId);
  return {bytes: total, deleted: ids.length, title: typeof root?.header?.title === 'string' ? root.header.title : undefined};
}

module.exports = {removeTree, describeTree, descendantsOf, pickTarget};