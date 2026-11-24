'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const { status, diff } = require('../git.cjs');

function fixture(t) {
  const base = fs.realpathSync(tmpdir()), tmp = fs.mkdtempSync(path.join(base, 'dsh-status-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(tmp)), base);
    assert.ok(path.basename(tmp).startsWith('dsh-status-'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const root = path.join(tmp, 'repo'); fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: root, stdio: 'pipe' });
  const write = (file, content) => fs.writeFileSync(path.join(root, file), content);
  git('init', '-b', 'main');
  return { root, tmp, git, write };
}

test('session subdirectory lists the whole worktree; staging layers, literal names, unreadable ids', async t => {
  const { root, tmp, git, write } = fixture(t);
  const sub = path.join(root, 'sub'); fs.mkdirSync(sub);
  const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty);
  assert.deepEqual(await status(empty), { status: 'not-repo', files: [], truncated: false });
  assert.deepEqual(await status(root), { status: 'ok', files: [], truncated: false });
  const weird = ':(glob)*\nfile'; write(weird, 'base\n'); git('add', '-A'); git('commit', '-m', 'base');
  write(weird, 'staged\n'); git('add', '-A'); write(weird, 'working\n'); write('other', 'unrelated');
  write('.gitignore', 'ignored\n'); write('ignored', 'no');
  const indexBefore = fs.readFileSync(path.join(root, '.git/index'));
  const { files, truncated } = await status(sub, undefined, 'session'); assert.equal(truncated, false);
  const row = files.find(f => f.path === weird); assert.equal(row.x + row.y, 'MM'); assert.ok(!files.some(f => f.path === 'ignored'));
  const view = side => diff(sub, row.id, side, undefined, 'session');
  const a = await view('staged'), b = await view('unstaged');
  assert.equal(a.kind, 'diff'); assert.match(a.text, /^-base\n\+staged$/m); assert.match(b.text, /^-staged\n\+working$/m);
  assert.deepEqual(indexBefore, fs.readFileSync(path.join(root, '.git/index')));
  await assert.rejects(diff(sub, row.id, 'unstaged', undefined, 'another-session'), /Refresh/);
  await assert.rejects(diff(sub, '../.git/config', 'untracked'), /Invalid/);
  await assert.rejects(view('bogus'), /Invalid/);
  git('add', '-A'); await assert.rejects(view('unstaged'), /Refresh/);
  await assert.rejects(status(root, AbortSignal.abort()), /cancelled/);
});

test('unborn staged diff; staged rename carries both literal paths', async t => {
  const { root, git, write } = fixture(t);
  write('old', 'move me\n'); git('add', '-A');
  const [added] = (await status(root)).files;
  assert.match((await diff(root, added.id, 'staged')).text, /^\+move me$/m);
  git('commit', '-m', 'base'); git('mv', 'old', 'new');
  const [moved] = (await status(root)).files; assert.equal(moved.oldPath, 'old'); assert.equal(moved.path, 'new');
  assert.match((await diff(root, moved.id, 'staged')).text, /rename from old\nrename to new/);
});

test('untracked preview refuses symlinks/special files and bounds binary or large content', {skip: process.platform !== 'linux'}, async t => {
  const { root, tmp, write } = fixture(t);
  fs.mkdirSync(path.join(root, 'sub'));
  write('sub/text', 'hello\n'); write('raw', Buffer.from([1, 0, 2])); write('big', '汉'.repeat(160000));
  const secret = path.join(tmp, 'private'); fs.writeFileSync(secret, 'outside'); fs.symlinkSync(secret, path.join(root, 'link'));
  const files = (await status(root)).files;
  const view = name => diff(root, files.find(f => f.path === name).id, 'untracked');
  assert.deepEqual(await view('sub/text'), {kind:'preview',text:'hello\n',truncated:false});
  assert.equal((await view('raw')).kind, 'binary'); assert.equal((await view('link')).kind, 'unavailable');
  const big = await view('big'); assert.equal(big.truncated, true); assert.equal(big.kind, 'preview'); assert.ok(!big.text.includes('\ufffd'));
  fs.renameSync(path.join(root, 'sub/text'), path.join(tmp, 'old-text'));
  fs.symlinkSync(secret, path.join(root, 'sub/text')); assert.equal((await view('sub/text')).kind, 'unavailable');
});

test('per-file diff handles binary content, deletions, bounded output and conflicts', async t => {
  const {root,git,write} = fixture(t);
  write('bin', Buffer.from([0,1])); write('large', 'base'); write('gone', 'deleted\n'); write('merge', 'original\n');
  git('add', '-A'); git('commit', '-m', 'base'); git('checkout', '-b', 'side');
  write('merge', 'side\n'); git('add', 'merge'); git('commit', '-m', 'side'); git('checkout', '-');
  write('merge', 'main\n'); git('add', 'merge'); git('commit', '-m', 'main');
  assert.throws(() => git('merge', 'side')); write('bin', Buffer.from([0,9])); write('large', 'delta\n'.repeat(70000)); git('rm', 'gone');
  const {files} = await status(root); const view = (p, side) => diff(root, files.find(f => f.path === p).id, side);
  assert.equal((await view('bin', 'unstaged')).kind, 'binary');
  assert.match((await view('gone', 'staged')).text, /^-deleted$/m);
  assert.equal((await view('large', 'unstaged')).truncated, true);
  const conflict = files.find(f => f.path === 'merge'); assert.equal(conflict.x + conflict.y, 'UU');
  assert.match((await view('merge', 'unstaged')).text, /diff --cc merge/);
});

test('parent scope aggregates only real immediate repos and linked worktrees and binds each diff to its repository', {skip: process.platform === 'win32'}, async t => {
  const {root,tmp,git,write} = fixture(t);
  git('commit', '--allow-empty', '-m', 'root');
  const linked = path.join(tmp, 'linked'); git('worktree', 'add', '--detach', linked, 'HEAD');
  fs.symlinkSync(root, path.join(tmp, 'alias')); fs.mkdirSync(path.join(tmp, 'group'));
  git('worktree', 'add', '--detach', path.join(tmp, 'group', 'deep'), 'HEAD');
  write('same', 'main'); fs.writeFileSync(path.join(linked, 'same'), 'linked');
  const r = await status(tmp, undefined, 'S');
  assert.equal(r.scope, 'children'); assert.equal(r.repoCount, 2);
  assert.deepEqual(r.files.map(f => f.path), ['linked/same', 'repo/same']);
  for (const [i, text] of ['linked', 'main'].entries()) {
    const {id} = r.files[i];
    assert.equal((await diff(tmp, id, 'untracked', undefined, 'S')).text, text);
    await assert.rejects(diff(root, id, 'untracked', undefined, 'S'), /Refresh/);
    await assert.rejects(diff(tmp, id, 'untracked', undefined, 'wrong'), /Refresh/);
  }
});

test('repository clean, fsmonitor, external diff and textconv helpers are not run', {skip: process.platform === 'win32'}, async t => {
  const { root, tmp, git, write } = fixture(t);
  write('data', 'old\n'); git('add', '-A'); git('commit', '-m', 'base');
  const marker = path.join(tmp, 'unexpected'); const cmd = `touch '${marker}'; false`;
  git('config', 'core.fsmonitor', cmd); git('config', 'filter.test.clean', cmd); git('config', 'filter.test.required', 'true');
  git('config', 'diff.external', cmd); git('config', 'diff.test.textconv', cmd); write('.gitattributes', 'data filter=test diff=test\n'); write('data', 'changed\n');
  const row = (await status(root)).files.find(f => f.path === 'data');
  assert.match((await diff(root, row.id, 'unstaged')).text, /\+changed/); assert.equal(fs.existsSync(marker), false);
});
