'use strict';
// POSIX (Linux / Android Termux / macOS) coverage for the deletion path and for the
// page-facing error that used to surface as `Unexpected token 'o', "not found" is not
// valid JSON` when the Host route was never registered.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const core = require('./core.cjs');
const posix = process.platform !== 'win32';
const PROJECT = '--data-data-com.termux-files-home-projects--';

async function fixture(t) {
  const base = await fs.mkdtemp(path.resolve(__dirname, 'fixture-'));
  t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
  const root = path.join(base, 'store');
  const dir = path.join(root, PROJECT, 'session-11111111-2222-4333-8444-555555555555');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'session.v4.jsonl');
  const body = '{"synthetic":"log"}\n';
  await fs.writeFile(file, body, { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'session.lock'), '', { mode: 0o600 });
  const snapshot = { header: { id: path.basename(dir), version: 4, isSeeded: false }, formatStatus: 'current', sizeBytes: Buffer.byteLength(body), location: { kind: 'jsonl', path: file } };
  const guard = path.join(base, 'epoch');
  await fs.writeFile(guard, crypto.randomUUID());
  const planDir = path.join(base, 'plans');
  return { base, root, dir, file, snapshot, guard, planDir, sessionId: snapshot.header.id, snapshots: [snapshot], archived: true, archiveStateFile: guard };
}

async function gone(file) {
  try { await fs.lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

test('POSIX live delete removes the log and the emptied session directory', { skip: !posix }, async t => {
  const a = await fixture(t);
  const plan = await core.preparePlan({ ...a });
  const done = await core.executePlan({ ...a, planId: plan.planId, liveConfirmed: true });
  assert.equal(done.deletedFiles, 1);
  assert.equal(await gone(a.file), true);
  assert.equal(await gone(a.dir), true);
});

test('POSIX refuses while a DSH writer holds session.lock', { skip: !posix }, async t => {
  const a = await fixture(t);
  const plan = await core.preparePlan({ ...a });
  const lease = await core.__posix.acquireWriteLock(a.dir);
  try {
    await assert.rejects(core.executePlan({ ...a, planId: plan.planId, liveConfirmed: true }), /被 DSH 占用/);
    assert.equal(await gone(a.file), false);
  } finally { await lease.release(); }
  await core.executePlan({ ...a, planId: plan.planId, liveConfirmed: true });
  assert.equal(await gone(a.file), true);
});

test('POSIX refuses a log rewritten after planning', { skip: !posix }, async t => {
  const a = await fixture(t);
  const plan = await core.preparePlan({ ...a });
  await fs.appendFile(a.file, 'changed');
  await assert.rejects(core.executePlan({ ...a, planId: plan.planId, liveConfirmed: true }), /changed|identity/i);
  assert.equal(await gone(a.file), false);
});

test('an unregistered page route reports the Host is not loaded', async () => {
  const source = await fs.readFile(path.join(__dirname, 'client.js'), 'utf8');
  let entry;
  const sandbox = { window: { __ModuleLoader__: { load: value => { entry = value; } }, confirm: () => true }, console, fetch: undefined };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  const notes = [];
  let menu;
  let tables = {};
  const ID = 'session-11111111-2222-4333-8444-555555555555';
  entry.factory().apply({
    effect: fn => { fn(); },
    locale: {
      register(namespace, value) { tables = { ...tables, [namespace]: value }; },
      bind: namespace => key => tables[namespace]?.en?.[key] ?? key
    },
    contextMenus: { notify: (message, ok) => notes.push({ message, ok }), register: value => { menu = value; } },
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [ID] }) } },
    sessions: { refresh: async () => {}, list: { getSnapshot: () => ({ ids: [] }) } }
  });
  sandbox.fetch = async () => ({ status: 404, text: async () => 'not found' });
  await menu.resolve({ sessionId: ID, displayTitle: '测试会话' })[0].run();
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /插件 Host 未载入（HTTP 404）/);
  assert.doesNotMatch(notes[0].message, /Unexpected token/);
});