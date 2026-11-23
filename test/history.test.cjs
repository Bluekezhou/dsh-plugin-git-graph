'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { history, historyPage, files } = require('../git.cjs');

function fixture(t) {
  const root = realpathSync(tmpdir());
  const tmp = mkdtempSync(path.join(root, 'dsh-git-graph-'));
  t.after(() => {
    assert.equal(path.dirname(realpathSync(tmp)), root);
    assert.ok(path.basename(tmp).startsWith('dsh-git-graph-'));
    rmSync(tmp, { recursive: true, force: true });
  });
  const cwd = path.join(tmp, 'repo'); mkdirSync(cwd);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'no-config'),
    GIT_AUTHOR_NAME: 'Graph Tester', GIT_COMMITTER_NAME: 'Graph Tester',
    GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_EMAIL: 'a@example.invalid' };
  const git = (args, dir = cwd, input) => execFileSync('git', args,
    { cwd: dir, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  return { cwd, tmp, git };
}

test('distinguishes a non-repository, unborn branch, missing cwd, and cancellation', async t => {
  const { cwd, git } = fixture(t);
  assert.equal((await history(cwd)).status, 'not-repo');
  git(['init', '-b', 'main']);
  assert.deepEqual(await history(cwd), { status: 'ok', head: null, branch: 'main', commits: [], truncated: false, page: { nextCursor: null },
    merged: { branches: [], hiddenHashes: [], partial: false } });
  await assert.rejects(history(path.join(cwd, 'missing')), /not found/);
  await assert.rejects(history(cwd, AbortSignal.abort()), /cancelled/);
});

test('reads merge parents, tags, local/remote/other refs and detached linked worktrees from a subdirectory', async t => {
  const { cwd, tmp, git } = fixture(t);
  git(['init', '-b', 'main']);
  const commit = (subject, dir) => git(['commit', '--allow-empty', '-m', subject], dir);
  commit('root'); git(['checkout', '-b', 'side']); commit('side'); git(['checkout', 'main']); commit('main');
  git(['merge', '--no-ff', 'side', '-m', 'merge']);
  const head = git(['rev-parse', 'HEAD']);
  git(['tag', '-a', 'v1', '-m', 'annotated']);
  git(['update-ref', 'refs/remotes/origin/main', head]); git(['update-ref', 'refs/custom/snapshot', head]);
  const linked = path.join(tmp, 'linked tree'); git(['worktree', 'add', '--detach', linked, 'HEAD']);
  commit('linked only', linked); const detached = git(['rev-parse', 'HEAD'], linked);
  const sub = path.join(cwd, 'sub'); mkdirSync(sub);
  const graph = await history(sub);
  assert.equal(graph.head, head); assert.equal(graph.branch, 'main'); assert.equal(graph.commits.length, 5);
  const row = graph.commits.find(c => c.hash === head);
  assert.equal(row.parents.length, 2); assert.equal(row.author, 'Graph Tester'); assert.equal(row.subject, 'merge');
  assert.ok(Number.isFinite(Date.parse(row.date)));
  assert.deepEqual(new Set(row.refs.map(r => `${r.kind}:${r.name}`)),
    new Set(['head:HEAD', 'branch:main', 'other:custom/snapshot', 'tag:v1', 'remote:origin/main', 'worktree:repo']));
  assert.deepEqual(graph.commits.find(c => c.hash === detached).refs, [{ kind: 'worktree', name: 'linked tree' }]);
  const detachedView = await history(linked); assert.equal(detachedView.branch, null); assert.equal(detachedView.head, detached);
});

function picked(t) {
  const f = fixture(t), { git, cwd } = f;
  git(['init', '-b', 'main']); git(['commit', '--allow-empty', '-m', 'base']);
  git(['checkout', '-b', 'topic']);
  writeFileSync(path.join(cwd, 'change'), 'one\n'); git(['add', 'change']); git(['commit', '-m', 'topic']);
  const tip = git(['rev-parse', 'HEAD']);
  git(['checkout', 'main']); git(['commit', '--allow-empty', '-m', 'independent']); git(['cherry-pick', tip]);
  assert.notEqual(tip, git(['rev-parse', 'HEAD']));
  return { ...f, tip };
}

test('counts only completely patch-equivalent branches and retains shared ancestry', async t => {
  const { git, cwd, tip } = picked(t);
  git(['branch', 'alias', tip]); git(['update-ref', 'refs/remotes/origin/topic', tip]);
  assert.deepEqual((await history(cwd)).merged, { branches: ['alias', 'topic'], hiddenHashes: [tip], partial: false });
  git(['checkout', '-b', 'retained', tip]);
  writeFileSync(path.join(cwd, 'new'), 'two\n'); git(['add', 'new']); git(['commit', '-m', 'not picked']);
  git(['checkout', 'main']);
  assert.deepEqual((await history(cwd)).merged, { branches: [], hiddenHashes: [], partial: false });
});

test('never folds tags, worktrees, unrelated remotes or truncated refs', async t => {
  const { git, cwd, tmp, tip } = picked(t);
  const remote = 'refs/remotes/other/retained';
  git(['update-ref', remote, tip]); assert.deepEqual((await history(cwd)).merged.branches, []);
  git(['update-ref', '-d', remote]); git(['tag', 'saved', tip]);
  assert.deepEqual((await history(cwd)).merged.hiddenHashes, []); git(['tag', '-d', 'saved']);
  git(['worktree', 'add', path.join(tmp, 'linked'), 'topic']);
  assert.deepEqual((await history(cwd)).merged.hiddenHashes, []);
  const aliases = Array.from({length: 68}, (_, i) => `create refs/heads/b${i} ${tip}\n`).join('');
  git(['update-ref', '--stdin'], cwd, aliases);
  assert.deepEqual((await history(cwd)).merged, { branches: [], hiddenHashes: [], partial: true });
});

test('skips optional folding for configured diff helpers without failing history', async t => {
  const { git, cwd } = picked(t);
  git(['config', 'diff.example.textconv', 'unused']);
  const graph = await history(cwd);
  assert.equal(graph.status, 'ok');
  assert.deepEqual(graph.merged, { branches: [], hiddenHashes: [], partial: true });
});

test('does not fold a visible patch when the side path crosses the 200-row boundary', async t => {
  const { git, cwd } = fixture(t);
  git(['init', '-b', 'main']);
  let stream = '';
  function commit(branch, i, parent = '', patch = '') {
    stream += `commit refs/heads/${branch}\nmark :${i}\ncommitter A <a@example.invalid> ${1000000000+i} +0000\ndata 1\nx\n`;
    if (parent) stream += `from :${parent}\n`;
    if (patch) stream += 'M 100644 inline change\ndata 2\nx\n';
    stream += '\n';
  }
  for (let i = 1; i <= 201; i++) commit('main', i, i - 1, i === 201);
  commit('topic', 202, 1, true);
  git(['fast-import', '--quiet'], cwd, stream);
  const graph = await history(cwd);
  assert.equal(graph.truncated, true);
  assert.ok(graph.commits.some(r => r.refs.some(ref => ref.name === 'topic')));
  assert.deepEqual(graph.merged, { branches: [], hiddenHashes: [], partial: true });
});

test('rejects a Git result above the subprocess byte budget', async t => {
  const { cwd, git } = fixture(t); git(['init', '-b', 'main']);
  git(['commit', '--quiet', '--allow-empty', '-F', '-'], cwd, 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(history(cwd), /exceeds the output limit/);
});

test('applies a fixed deadline even when the caller supplies no signal', async t => {
  const { cwd } = fixture(t);
  t.mock.method(AbortSignal, 'timeout', ms => {
    assert.equal(ms, 8000);
    return AbortSignal.abort(new Error('deadline elapsed'));
  });
  await assert.rejects(history(cwd), /timed out/);
});

test('proves truncation with an extra commit and bounds text fields', async t => {
  const { cwd, git } = fixture(t); git(['init', '-b', 'main']);
  let stream = '';
  for (let i = 0; i < 201; i++) {
    const msg = i === 200 ? 'x'.repeat(900) : `c${i}`;
    stream += `commit refs/heads/main\ncommitter A <a@example.invalid> ${1000000000 + i} +0000\ndata ${msg.length}\n${msg}\n\n`;
  }
  git(['fast-import', '--quiet'], cwd, stream);
  const graph = await history(cwd); assert.equal(graph.commits.length, 200); assert.equal(graph.truncated, true);
  assert.equal(graph.commits[0].subject.length, 512); assert.equal(graph.commits.at(-1).subject, 'c1');
});

function linear(t, count) {
  const f = fixture(t);
  f.git(['init', '-b', 'main']);
  let stream = '';
  for (let i = 0; i < count; i++) {
    const subject = `commit ${i}`;
    stream += `commit refs/heads/main\ncommitter A <a@example.invalid> ${1000000000 + i} +0000\ndata ${subject.length}\n${subject}\n\n`;
  }
  f.git(['fast-import', '--quiet'], f.cwd, stream);
  return f;
}

for (const count of [199, 200, 201, 400, 429]) test(`reads all ${count} commits in exact Git order with no empty final page`, async t => {
  const { cwd, git } = linear(t, count);
  const order = git(['rev-list', '--date-order', '--all']).split('\n');
  const seen = [];
  let page = await history(cwd);
  while (true) {
    assert.deepEqual(page.commits.map(c => c.hash), order.slice(seen.length, seen.length + 200));
    seen.push(...page.commits);
    assert.equal(page.truncated, seen.length < count);
    if (seen.length === count) { assert.equal(page.page.nextCursor, null); break; }
    assert.equal(typeof page.page.nextCursor, 'string');
    page = await historyPage(cwd, page.page.nextCursor);
    assert.deepEqual(page.merged, { branches: [], hiddenHashes: [], partial: true });
  }
  assert.equal(seen.length, count);
});

test('file details compare roots to empty and merges to first parent; rename paths survive -z', async t => {
  const { cwd, git } = fixture(t);
  git(['init', '-b', 'main']);
  const oldPath = process.platform === 'win32' ? 'old 名' : 'old\t名\n';
  const newPath = '-renamed 文';
  writeFileSync(path.join(cwd, oldPath), 'content\n'.repeat(20));
  git(['add', '--', oldPath]); git(['commit', '-m', 'root']);
  const oid = () => git(['rev-parse', 'HEAD']);
  assert.deepEqual(await files(cwd, oid()), { files: [{status:'A', path:oldPath}], truncated:false });
  git(['checkout', '-b', 'side']); git(['mv', '--', oldPath, newPath]); git(['commit', '-m', 'rename']);
  const rename = {files:[{status:'R', oldPath, path:newPath}], truncated:false};
  assert.deepEqual(await files(cwd, oid()), rename);
  git(['checkout', 'main']); writeFileSync(path.join(cwd, 'main-only'), 'x'); git(['add', 'main-only']); git(['commit', '-m', 'main']);
  git(['merge', '--no-ff', 'side', '-m', 'merge']);
  mkdirSync(path.join(cwd, 'sub')); git(['config', 'diff.relative', 'true']); git(['config', 'diff.external', 'unused']);
  assert.deepEqual(await files(path.join(cwd, 'sub'), oid()), rename);
  git(['commit', '--allow-empty', '-m', 'empty']);
  assert.deepEqual(await files(cwd, oid()), {files:[], truncated:false});
});

test('file details accept only full reachable commit IDs, not tags, trees, reflogs or options', async t => {
  const { cwd, git } = linear(t, 202);
  const page = await history(cwd), older = await historyPage(cwd, page.page.nextCursor);
  const oid = older.commits[1].hash;
  assert.deepEqual(await files(cwd, oid), { files:[], truncated:false });
  for (const bad of ['--all', 'HEAD', 'HEAD^', oid.slice(0, 16), oid+'\n', {}, null]) {
    await assert.rejects(files(cwd, bad), /full commit OID/);
  }
  git(['tag','-a','annotated','-m','tag']);
  git(['commit','--allow-empty','-m','abandoned']); const abandoned = git(['rev-parse','HEAD']); git(['reset','--hard','HEAD^']);
  for (const bad of [abandoned, 'f'.repeat(40), git(['rev-parse','annotated']), git(['rev-parse','HEAD^{tree}'])]) {
    await assert.rejects(files(cwd,bad), /not reachable/);
  }
  await assert.rejects(files(cwd, oid, AbortSignal.abort()), /cancelled/);
});

test('file details distinguish full SHA-256 IDs from SHA-1-sized abbreviations', async t => {
  const { cwd, git } = fixture(t);
  git(['init','--object-format=sha256','-b','main']); git(['commit','--allow-empty','-m','root']);
  const oid = git(['rev-parse','HEAD']);
  assert.equal(oid.length,64); assert.deepEqual(await files(cwd,oid.toUpperCase()), {files:[], truncated:false});
  await assert.rejects(files(cwd,oid.slice(0,40)), /not reachable/);
});

test('file details cap counts and return complete names when Git exceeds its byte limit', async t => {
  const { cwd, git } = fixture(t); git(['init','-b','main']);
  const commit = (branch, count, name) => {
    let input = `commit refs/heads/${branch}\ncommitter Test <a@example.invalid> 1000000000 +0000\ndata 1\nx\n`;
    for (let i = 0; i < count; i++) input += `M 100644 inline ${name(i)}\ndata 1\nx\n`;
    git(['fast-import','--quiet'], cwd, input+'\n'); return git(['rev-parse', branch]);
  };
  const a = await files(cwd, commit('main',501,i=>'short'+i));
  assert.equal(a.truncated,true); assert.equal(a.files.length,500);
  const prefix = ('a'.repeat(200)+'/').repeat(4);
  const b = await files(cwd, commit('large',490,i=>prefix+'file'+i));
  assert.equal(b.truncated,true); assert.ok(b.files.length>0 && b.files.length<490);
  assert.ok(b.files.every(f=>f.path.startsWith(prefix) && /^file\d+$/.test(f.path.slice(prefix.length))));
});

test('authenticates cursors and requests restart on branch, label or session changes', async t => {
  const { cwd, git } = linear(t, 205);
  const { page: { nextCursor } } = await history(cwd, undefined, 's1');
  const reason = { code: 'git-graph/restart' };
  for (const bad of [undefined, null, {}, '--all', '../HEAD', nextCursor.replace(/^200\./, '400.'), 'x'.repeat(4096)]) {
    await assert.rejects(historyPage(cwd, bad, undefined, 's1'), reason);
  }
  await assert.rejects(historyPage(cwd, nextCursor, undefined, 's2'), reason);
  git(['tag', 'new-tag', 'HEAD~1']);
  await assert.rejects(historyPage(cwd, nextCursor, undefined, 's1'), reason);
  const fresh = await history(cwd);
  git(['commit', '--allow-empty', '-m', 'change between pages']);
  await assert.rejects(historyPage(cwd, fresh.page.nextCursor), reason);
});

test('detects a ref changed while Git was reading a page', { skip: process.platform === 'win32' }, async t => {
  const { cwd, tmp } = linear(t, 205);
  const { page: { nextCursor } } = await history(cwd);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(tmp, 'bin'); mkdirSync(bin);
  // Interpose only on log, after the first ref snapshot and before validation.
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor arg do\n  if [ "$arg" = log ]; then "$REAL_GIT" tag concurrent HEAD; break; fi\ndone\nexec "$REAL_GIT" "$@"\n`.replaceAll('"$REAL_GIT"', `'${realGit.replaceAll("'", "'\\''")}'`), { mode: 0o755 });
  const original = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${original}`;
    await assert.rejects(historyPage(cwd, nextCursor), { code: 'git-graph/restart' });
  } finally { process.env.PATH = original; }
});
