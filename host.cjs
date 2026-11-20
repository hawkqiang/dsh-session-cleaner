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

// A conversation the user just closed can hold its write handle for a moment, so a
// transient busy refusal is retried instead of failing the whole removal.
const TRANSIENT = /被 DSH 占用|正被其他程序打开|still active|being used by another process|sharing violation/i;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Delete one session, and with `withChildren` its whole descendant tree.
 * Children go first so no surviving log keeps a parent link to a removed one.
 * @param options - sessionId, provider snapshots, plan directory, epoch file, core,
 *   `list` to re-read snapshots between deletions, `stillValid` to reject staleness,
 *   and `attempts` for a transient busy writer.
 */
async function removeTree({sessionId, snapshots, planDir, guard, core, withChildren, list, stillValid, attempts = 3}) {
  const members = descendantsOf(snapshots, sessionId);
  if (members.length > 0 && withChildren !== true) throw Error(`该会话有 ${members.length} 个子会话，需要同时删除才能移除`);
  const ids = [...members.map(s => s.header.id), sessionId];
  let total = 0;
  for (const id of ids) {
    if (typeof stillValid === 'function' && !stillValid()) throw Error('归档状态已变化，请重试');
    let result;
    for (let attempt = 1; ; attempt += 1) {
      if (typeof stillValid === 'function' && !stillValid()) throw Error('归档状态已变化，请重试');
      const current = typeof list === 'function' ? await list() : snapshots;
      try {
        result = await removeOne({sessionId: id, snapshots: current, planDir, guard, core, allowTree: members.length > 0});
        break;
      } catch (error) {
        if (attempt >= attempts || !TRANSIENT.test(String(error?.message ?? error))) throw error;
        await delay(400 * attempt);
      }
    }
    total += result.bytes;
  }
  const root = snapshots.find(s => s?.header?.id === sessionId);
  return {bytes: total, deleted: ids.length, title: typeof root?.header?.title === 'string' ? root.header.title : undefined};
}

module.exports = {removeTree, describeTree, descendantsOf, pickTarget, readPending, enqueuePending, processPending};

// DSH keeps a write handle on sessions it has loaded, so an in-app deletion can be
// refused while the app runs. Such a request is queued and executed on the next Host
// start, before the session is opened again.
const PENDING = 'pending-deletions.json';
const BUSY = /被 DSH 占用|正被其他程序打开|still active|being used by another process|sharing violation/i;

async function readPending(dir) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, PENDING), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(e => typeof e?.sessionId === 'string') : [];
  } catch { return []; }
}

async function writePending(dir, entries) {
  const file = path.join(dir, PENDING);
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(entries.slice(0, 50)), {mode: 0o600});
  await fs.rename(temp, file);
}

async function enqueuePending(dir, sessionId, title) {
  const entries = await readPending(dir);
  if (!entries.some(entry => entry.sessionId === sessionId)) {
    entries.push({sessionId, title: typeof title === 'string' ? title.slice(0, 200) : undefined, queuedAt: new Date().toISOString()});
    await writePending(dir, entries);
  }
  return entries.length;
}

/**
 * Retry queued deletions, dropping entries whose session is gone or was removed.
 * @param options - plan directory, `list` for provider snapshots, `attempt` to delete
 *   one id (throwing on refusal) and `log` for the diagnostic line.
 */
async function processPending({dir, list, attempt, log}) {
  const entries = await readPending(dir);
  if (entries.length === 0) return {done: 0, kept: 0};
  const remaining = [];
  let done = 0;
  for (const entry of entries) {
    const snapshots = await list();
    if (!snapshots.some(s => s?.header?.id === entry.sessionId)) { done += 1; continue; }
    try {
      await attempt(entry.sessionId);
      done += 1;
      await log?.(`pending delete ${entry.sessionId} done`);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (BUSY.test(message)) { remaining.push(entry); await log?.(`pending delete ${entry.sessionId} still busy`); }
      else { await log?.(`pending delete ${entry.sessionId} dropped: ${message}`); }
    }
  }
  await writePending(dir, remaining);
  return {done, kept: remaining.length};
}