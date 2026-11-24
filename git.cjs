'use strict';
const { execFile } = require('node:child_process');
const { isUtf8 } = require('node:buffer');
const { basename, isAbsolute, join } = require('node:path');
const { stat, open, realpath, opendir, lstat } = require('node:fs/promises');
const { constants: fsFlags } = require('node:fs');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const PAGE_SIZE = 200;
// Stateless continuation tokens, valid for this Host process only. Neither paths nor
// revision expressions from the wire ever reach Git.
const cursorKey = randomBytes(32);
const restart = () => Object.assign(new Error('Git history changed or the cursor expired. Restart from the first page.'), { code: 'git-graph/restart' });
const sign = (snapshot, offset, hash) => createHmac('sha256', cursorKey).update(`${snapshot}:${offset}:${hash}`).digest('hex');
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const emptyTreeFor = oid => oid.length === 40 ? '4b825dc642cb6eb9a060e54bf8d69288fbee4904' : '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';

function text(value, max) {
  return value.slice(0, max).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '\ufffd');
}

// Like pi-toolkit's graph, only fold a divergent local branch when Git marks *every*
// right-side commit patch-equivalent. A normal merge ancestor already lives on HEAD's graph.
async function mergedBranches(rows, head, git) {
  const out = { branches: [], hiddenHashes: [], partial: false };
  const ancestors = (tips, stop = new Set()) => {
    const seen = new Set(), stack = [...tips];
    while (stack.length) {
      const h = stack.pop();
      if (seen.has(h) || stop.has(h) || !rows.has(h)) continue;
      seen.add(h);
      for (const p of rows.get(h).parents) stack.push(p);
    }
    return seen;
  };
  if (!head) return out;
  if (!rows.has(head) || [...rows.values()].some(r => r.refsTruncated)) return { ...out, partial: true };
  const onHead = ancestors([head]), proven = new Map();
  const candidate = [...rows.values()].filter(r => !onHead.has(r.hash) && r.refs.some(ref => ref.kind === 'branch') &&
    !r.refs.some(ref => ['head', 'worktree', 'tag', 'other'].includes(ref.kind)));
  if (!candidate.length) return out;
  const deadline = AbortSignal.timeout(1500);
  const opts = { deadline, bytes: 32 * 1024 };
  try {
    // Shallow roots are not true boundaries. Unknown attribute/filter drivers are not needed
    // for browsing: omit the optional comparison instead of trusting repository helper config.
    if ((await git(['rev-parse', '--is-shallow-repository'], opts)).trim() !== 'false' ||
      await git(['config', '--includes', '--name-only', '--get-regexp', '^(filter\\.|diff\\..*\\.(command|textconv)$|diff\\.external$)'], { ...opts, empty: true })) {
      return { ...out, partial: true };
    }
    const emptyTree = emptyTreeFor(head);
    for (const r of candidate.slice(0, 8)) {
      const side = ancestors([r.hash], onHead);
      // Never infer equivalence across a missing parent or for a merge's conflict resolution.
      if ([...side].some(h => rows.get(h).parents.length !== 1 || !rows.has(rows.get(h).parents[0]))) { out.partial = true; continue; }
      const marks = (await git([`--attr-source=${emptyTree}`, '-c', 'diff.external=', '-c', 'core.bigFileThreshold=32m',
        'rev-list', '--no-ext-diff', '--no-textconv', '--right-only', '--cherry-mark', `${head}...${r.hash}`, '--'], opts)).trim().split('\n');
      const eq = new Set(marks.filter(m => m.startsWith('=')).map(m => m.slice(1)));
      if (marks.length === side.size && eq.size === side.size && [...side].every(h => eq.has(h))) {
        proven.set(r.hash, r.refs.filter(ref => ref.kind === 'branch').map(ref => ref.name));
      }
    }
    if (candidate.length > 8) out.partial = true;
  } catch { out.partial = true; }
  // An ancestor required by ANY retained tip stays visible. A matching remote tracking
  // label on the identical proven local tip may follow it; unrelated remotes are protected.
  const parents = new Set([...rows.values()].flatMap(r => r.parents));
  const keepTips = [head];
  for (const r of rows.values()) {
    const names = proven.get(r.hash);
    if (!names && !parents.has(r.hash)) keepTips.push(r.hash); // unlabeled/racing tips
    if (!names || r.refs.some(ref => ref.kind !== 'branch' && !(ref.kind === 'remote' && ref.name.includes('/') && names.includes(ref.name.slice(ref.name.indexOf('/') + 1))))) {
      if (r.refs.length) keepTips.push(r.hash);
    }
  }
  const hidden = ancestors(proven.keys(), ancestors(keepTips));
  out.hiddenHashes = [...rows.keys()].filter(h => hidden.has(h));
  out.branches = [...proven].filter(([h]) => hidden.has(h)).flatMap(([, names]) => names);
  return out;
}

function history(cwd, signal, sessionId = '') {
  return readPage(cwd, null, signal, sessionId);
}

async function historyPage(cwd, cursor, signal, sessionId = '') {
  if (typeof cursor !== 'string' || cursor.length > 160) throw restart();
  const match = /^([1-9]\d{0,15})\.([0-9a-f]{40}|[0-9a-f]{64})\.([0-9a-f]{64})$/.exec(cursor);
  if (!match || !Number.isSafeInteger(+match[1]) || +match[1] % PAGE_SIZE !== 0) throw restart();
  return readPage(cwd, { offset: +match[1], hash: match[2], mac: match[3] }, signal, sessionId);
}

function gitReader(cwd, signal) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Session has no absolute working directory.');
  const timeout = AbortSignal.timeout(8000);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  // Do not inherit GIT_DIR, replacement refs, injected configuration or trace destinations.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: '', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  const prefix = ['--no-pager', '--no-lazy-fetch', '--no-replace-objects', '-c', 'color.ui=false',
    '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=' + env.GIT_CONFIG_GLOBAL, '-c', 'log.showSignature=false'];
  return async function git(args, { empty = false, probe = false, deadline, stdin, prefixOutput = false, bytes = 1024 * 1024 } = {}) {
    try {
      const run = exec('git', [...prefix, ...args], { cwd, env, signal: deadline ? AbortSignal.any([stop, deadline]) : stop, killSignal: 'SIGKILL',
        maxBuffer: bytes, windowsHide: true, encoding: prefixOutput ? 'buffer' : 'utf8' });
      if (stdin !== undefined && run.child.stdin) {
        // Git may exit (timeout, cancellation, bad repo) before consuming stdin.
        run.child.stdin.on('error', () => {});
        run.child.stdin.end(stdin);
      }
      const { stdout } = await run;
      return prefixOutput ? { stdout, truncated: false } : stdout;
    } catch (err) {
      if (stop.aborted) throw new Error(timeout.aborted ? 'Git history timed out.' : 'Git history was cancelled.');
      if (empty && err.code === 1) return '';
      if (probe && err.code === 128 && /^fatal: not a git repository\b/.test(err.stderr)) return null;
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        if (prefixOutput && err.stdout?.length === bytes && err.message.startsWith('stdout ')) {
          return { stdout: err.stdout, truncated: true };
        }
        throw new Error('Git history exceeds the output limit.');
      }
      if (err.code === 'ENOENT') throw new Error('Git executable or session directory not found.');
      if (err.code === 129) throw new Error('Git 2.45 or newer is required.');
      throw new Error(`Git ${args[0]} failed.`);
    }
  };
}

// Git paths are bytes. Keep all valid UTF-8 (including whitespace and controls)
// verbatim; for non-UTF-8 paths use a quoted octal representation, not U+FFFD.
function fileName(bytes) {
  if (isUtf8(bytes)) return bytes.toString('utf8');
  return '"' + Array.from(bytes, b => b >= 32 && b < 127 && b !== 34 && b !== 92
    ? String.fromCharCode(b) : '\\' + b.toString(8).padStart(3, '0')).join('') + '"';
}

async function files(cwd, oid, signal) {
  if (typeof oid !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) throw new Error('A full commit OID is required.');
  oid = oid.toLowerCase();
  const git = gitReader(cwd, signal);
  // Comparing the peeled identity rejects tags, trees, and a SHA-1-sized
  // abbreviation in a SHA-256 repo. Subtract the same roots history walks,
  // not the first page (or just HEAD); an empty difference proves reachability.
  if ((await git(['rev-parse', '--verify', '--quiet', `${oid}^{commit}`], { empty: true })).trimEnd() !== oid ||
      await git(['rev-list', '--max-count=1', oid, '--not', '--all', '--'])) {
    throw new Error('Commit is not reachable in this repository.');
  }
  const emptyTree = emptyTreeFor(oid);
  const { stdout, truncated } = await git([`--attr-source=${emptyTree}`, '-c', 'core.bigFileThreshold=32m',
    'diff-tree', '--root', '--diff-merges=first-parent', '-r', '--no-commit-id', '--name-status', '-z',
    '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none', '-M', '-l500',
    '-O' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), oid, '--'], { bytes: 256 * 1024, prefixOutput: true });
  const rows = [];
  let pos = 0;
  function field() {
    const end = stdout.indexOf(0, pos);
    if (end < 0) return null;
    const value = stdout.subarray(pos, end);
    pos = end + 1;
    return value;
  }
  while (pos < stdout.length && rows.length < 500) {
    const kind = field()?.toString('ascii');
    const from = field(), paired = kind?.[0] === 'R' || kind?.[0] === 'C';
    const to = paired ? field() : from;
    if (truncated && (!kind || !from || !to)) break; // never publish an incomplete record
    if (!kind || !/^(?:[ADMTUXB]|[RC]\d{1,3})$/.test(kind) || !from?.length || !to?.length) throw new Error('Invalid Git file record.');
    rows.push({ status: kind[0], path: fileName(to), ...(paired ? { oldPath: fileName(from) } : {}) });
  }
  return { files: rows, truncated: truncated || pos < stdout.length };
}

async function readPage(cwd, cursor, signal, sessionId) {
  const git = gitReader(cwd, signal);
  const result = { status: 'ok', commits: [], head: null, branch: null, truncated: false,
    page: { nextCursor: null }, merged: { branches: [], hiddenHashes: [], partial: false } };
  if (await git(['rev-parse', '--git-dir'], { probe: true }) === null) {
    if (cursor) throw restart();
    return { ...result, status: 'not-repo' };
  }
  // Capture all traversal roots (including other worktrees' detached HEADs) as
  // immutable commit IDs. Also capture the labels; a tag-only change invalidates a page.
  async function snapshot() {
    const [ref, head, trees, refs, roots, commonDirOutput] = await Promise.all([
      git(['symbolic-ref', '--quiet', 'HEAD'], { empty: true }),
      git(['rev-parse', '--quiet', '--verify', 'HEAD^{commit}'], { empty: true }),
      git(['worktree', 'list', '--porcelain', '-z']),
      git(['show-ref', '--dereference'], { empty: true }),
      git(['rev-list', '--all', '--no-walk=unsorted', '--']),
      git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ]);
    // Deepening a shallow clone or changing legacy grafts rewrites graph edges
    // without changing a ref. Fingerprint metadata, never read an unbounded file.
    const commonDir = commonDirOutput.replace(/\n$/, '');
    const boundaries = await Promise.all(['shallow', 'info/grafts'].map(async name => {
      try {
        const s = await stat(join(commonDir, name), { bigint: true });
        return `${s.dev}:${s.ino}:${s.ctimeNs}:${s.size}`;
      } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    }));
    if (roots && !roots.trimEnd().split('\n').every(h => OID.test(h))) throw new Error('Invalid Git traversal root.');
    const id = createHash('sha256').update(JSON.stringify([cwd, sessionId, commonDir, boundaries, ref, head, trees, refs, roots])).digest('hex');
    return { id, ref: ref.trim(), head: head.trim(), trees, refs, roots };
  }
  const { id, ref, head, trees, refs, roots } = await snapshot();
  const offset = cursor?.offset || 0;
  if (cursor && !timingSafeEqual(Buffer.from(cursor.mac, 'hex'), Buffer.from(sign(id, offset, cursor.hash), 'hex'))) throw restart();
  result.branch = ref ? text(ref.replace(/^refs\/heads\//, ''), 256) : null;
  if (OID.test(head)) result.head = head;
  const log = !roots ? '' : await git(['log', '--stdin', '--date-order', `--skip=${offset}`, `--max-count=${PAGE_SIZE + 1}`, '--no-patch',
    '--no-show-signature', '--no-notes', '--no-decorate', '--no-use-mailmap', '--encoding=UTF-8', '-z',
    '--format=%H%x00%P%x00%an%x00%aI%x00%s', '--'], { stdin: roots });
  const fields = log.split('\0');
  if (fields.pop() !== '' || fields.length % 5) throw new Error('Invalid Git log record.');
  if (cursor && fields[0] !== cursor.hash) throw restart();
  result.truncated = fields.length > PAGE_SIZE * 5;
  if (result.truncated) {
    const next = fields[PAGE_SIZE * 5];
    if (!OID.test(next)) throw new Error('Invalid Git continuation boundary.');
    result.page.nextCursor = `${offset + PAGE_SIZE}.${next}.${sign(id, offset + PAGE_SIZE, next)}`;
  }
  const rows = new Map();
  for (let i = 0; i < Math.min(PAGE_SIZE * 5, fields.length); i += 5) {
    const [hash, p, author, date, subject] = fields.slice(i, i + 5);
    const parents = p ? p.split(' ') : [];
    if (!OID.test(hash) || !parents.every(v => OID.test(v))) throw new Error('Invalid Git commit identity.');
    const row = { hash, parents, author: text(author, 128), date, subject: text(subject, 512), refs: [] };
    rows.set(hash, row); result.commits.push(row);
  }
  let ambiguousRefs = false;
  function label(hash, kind, name) {
    const row = rows.get(hash);
    if (!row) return;
    if (row.refs.length >= 64) { row.refsTruncated = true; return; }
    const safeName = text(name, 256);
    if (kind !== 'worktree' && (safeName !== name || name.includes('\ufffd'))) ambiguousRefs = true;
    row.refs.push({ kind, name: safeName });
  }
  label(head, 'head', 'HEAD');
  for (const record of trees.split('\0\0')) {
    const parts = record.split('\0');
    const path = parts.find(s => s.startsWith('worktree '));
    const tip = parts.find(s => s.startsWith('HEAD '));
    if (path && tip) label(tip.slice(5), 'worktree', basename(path.slice(9)) || '/');
  }
  // show-ref -d peels even nested annotated tags. Unpeeled tag object IDs won't match a row.
  for (const line of refs.split('\n')) {
    const match = /^(\S+) refs\/(?:(heads|remotes|tags)\/)?(.+?)(?:\^\{\})?$/.exec(line);
    if (match) label(match[1], ({ heads: 'branch', remotes: 'remote', tags: 'tag' })[match[2]] || 'other', match[3]);
    else if (line) ambiguousRefs = true;
  }
  // Date-order puts every child before its parents. A first-page proof has seen
  // every descendant of its hidden rows and rejects any incomplete side path.
  // Subsequent windows cannot see all descendants: never infer additional folds.
  if (cursor || ambiguousRefs) result.merged.partial = true;
  else result.merged = await mergedBranches(rows, result.head, git);
  if ((await snapshot()).id !== id) throw restart();
  if (signal?.aborted) throw new Error('Git history was cancelled.');
  return result;
}
const WORK_LIMIT = 256 * 1024;
const workResult = (kind, text = '', truncated = false) => ({ kind, text, truncated });

async function workTree(cwd, signal, sessionId, expectedRoot) {
  const discover = gitReader(cwd, signal);
  if ((await discover(['rev-parse', '--is-inside-work-tree'], { probe: true }))?.trim() !== 'true') return null;
  const root = await realpath((await discover(['rev-parse', '--show-toplevel'])).replace(/\n$/, ''));
  if (expectedRoot && expectedRoot !== root) return null;
  const run = gitReader(root, signal);
  // Worktree status/diff can run clean filters merely by comparing index entries.
  // Neutralize each configured clean/process driver, including definitions in includes.
  const opts = ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'core.bigFileThreshold=16m'];
  const keys = await run(['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'], { empty: true, bytes: 64 * 1024 });
  for (const key of new Set(keys.split('\0').filter(Boolean))) opts.push('-c', key + (key.endsWith('.required') ? '=false' : '='));
  const git = (args, options) => run([...opts, ...args], options);
  const { stdout, truncated } = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--find-renames', '--ignore-submodules=dirty'], { prefixOutput: true, bytes: 2 * 1024 * 1024 });
  const rows = [];
  let pos = 0;
  function field() {
    const end = stdout.indexOf(0, pos);
    if (end === -1) return null;
    const val = stdout.subarray(pos, end); pos = end + 1; return val;
  }
  while (pos < stdout.length && rows.length < 10000) {
    const entry = field();
    if (!entry && truncated) break;
    if (!entry || entry.length < 4 || entry[2] !== 32) throw new Error('Invalid Git status record.');
    const x = String.fromCharCode(entry[0]), y = String.fromCharCode(entry[1]);
    const path = entry.subarray(3), paired = /[RC]/.test(x + y), old = paired && field();
    if (paired && !old) { if (truncated) break; throw new Error('Invalid Git rename record.'); }
    const id = createHmac('sha256', cursorKey).update(sessionId).update('\0').update(root).update('\0').update(entry).update('\0').update(old || '').digest('hex');
    rows.push({ id, x, y, path: fileName(path), ...(old && { oldPath: fileName(old) }), usable: isUtf8(path) && (!old || isUtf8(old)) });
  }
  return { root, git, rows, truncated: truncated || pos < stdout.length };
}

// Only direct, non-symlink directories with a real .git directory/file qualify.
// Do not traverse the workspace or substitute a path supplied by the client.
async function children(cwd, signal, sessionId) {
  const base = await realpath(cwd), repos = [];
  let count = 0, truncated = false;
  for await (const entry of await opendir(base)) {
    signal?.throwIfAborted();
    if (++count > 4096) { truncated = true; break; }
    if (!entry.isDirectory() || entry.name === '.git') continue;
    const root = join(base, entry.name);
    try {
      if ((await realpath(root)) !== root) continue;
      const meta = await lstat(join(root, '.git'));
      if (!meta.isDirectory() && !meta.isFile()) continue;
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') truncated = true; continue; }
    if (repos.length >= 64) { truncated = true; break; }
    const tag = createHmac('sha256', cursorKey).update(JSON.stringify([sessionId, base, root])).digest('hex').slice(0, 32);
    repos.push({ root, name: entry.name, tag });
  }
  repos.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { repos, truncated };
}

async function status(cwd, signal, sessionId = '') {
  const tree = await workTree(cwd, signal, sessionId);
  if (tree) return { status: 'ok', files: tree.rows.map(({ usable, ...row }) => row), truncated: tree.truncated };
  const group = await children(cwd, signal, sessionId);
  const result = { status: 'not-repo', files: [], truncated: group.truncated };
  let repoCount = 0;
  for (let i = 0; i < group.repos.length; i += 4) {
    const batch = group.repos.slice(i, i + 4);
    const trees = await Promise.all(batch.map(async repo => {
      try { return await workTree(repo.root, signal, sessionId, repo.root); }
      catch (error) { if (signal?.aborted) throw error; result.truncated = true; return null; }
    }));
    trees.forEach((child, j) => {
      if (!child) return;
      repoCount++;
      const {name, tag} = batch[j]; result.truncated ||= child.truncated;
      for (const { usable, oldPath, ...row } of child.rows) {
        if (result.files.length === 10000) { result.truncated = true; break; }
        result.files.push({ ...row, id: tag + row.id.slice(0, 32), path: name + '/' + row.path, ...(oldPath && {oldPath: name + '/' + oldPath}) });
      }
    });
  }
  return repoCount ? { ...result, status: 'ok', scope: 'children', repoCount } : result;
}

function safeParts(name) {
  const parts = name.split('/');
  return !isAbsolute(name) && parts.every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git' &&
    (process.platform !== 'win32' || !/[\\:]/.test(p))) ? parts : null;
}

function asText(kind, bytes, truncated) {
  // A bounded prefix may end halfway through a valid UTF-8 character.
  let end = bytes.length;
  if (truncated) {
    let lead = end - 1;
    while (lead >= Math.max(0, end - 3) && (bytes[lead] & 0xc0) === 0x80) lead--;
    if (lead >= 0 && bytes[lead] >= 0xc2 && end - lead < (bytes[lead] < 0xe0 ? 2 : bytes[lead] < 0xf0 ? 3 : 4)) end = lead;
  }
  bytes = bytes.subarray(0, end);
  if (bytes.includes(0) || !isUtf8(bytes)) return workResult('binary');
  return workResult(kind, bytes.toString('utf8'), truncated);
}

async function preview(root, parts, signal) {
  // Walk pinned directory descriptors: a symlink inserted into an ancestor after
  // status must never redirect a preview outside the tree. Fail closed if the OS
  // lacks a usable descriptor filesystem. O_NONBLOCK also prevents FIFO hangs.
  const dirFlags = fsFlags.O_RDONLY | fsFlags.O_DIRECTORY | fsFlags.O_NOFOLLOW;
  if (!fsFlags.O_NOFOLLOW || !fsFlags.O_DIRECTORY) return workResult('unavailable');
  const fdRoot = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  const handles = [];
  try {
    let dir = await open(root, dirFlags); handles.push(dir);
    for (const [i, part] of parts.entries()) {
      signal?.throwIfAborted();
      const last = i === parts.length - 1;
      const candidate = join(fdRoot, String(dir.fd), part);
      if (last && !(await lstat(candidate)).isFile()) return workResult('unavailable');
      const next = await open(candidate, last ? fsFlags.O_RDONLY | fsFlags.O_NOFOLLOW | fsFlags.O_NONBLOCK : dirFlags);
      handles.push(next); dir = next;
    }
    if (!(await dir.stat()).isFile()) return workResult('unavailable');
    const bytes = Buffer.alloc(WORK_LIMIT + 1);
    const { bytesRead } = await dir.read(bytes, 0, bytes.length, 0);
    signal?.throwIfAborted();
    return asText('preview', bytes.subarray(0, Math.min(bytesRead, WORK_LIMIT)), bytesRead > WORK_LIMIT);
  } catch (error) {
    if (signal?.aborted) throw error;
    return workResult('unavailable');
  } finally { await Promise.all(handles.map(h => h.close())); }
}

async function diff(cwd, id, side, signal, sessionId = '') {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || !['staged', 'unstaged', 'untracked'].includes(side)) throw new Error('Invalid worktree file request.');
  let tree = await workTree(cwd, signal, sessionId);
  let row = tree?.rows.find(r => r.id === id);
  if (!tree) {
    const { repos } = await children(cwd, signal, sessionId);
    const repo = repos.find(r => id.startsWith(r.tag));
    if (repo) {
      tree = await workTree(repo.root, signal, sessionId, repo.root);
      row = tree?.rows.find(r => repo.tag + r.id.slice(0, 32) === id);
    }
  }
  if (!row) throw new Error('File status changed. Refresh the file list.');
  const parts = safeParts(row.path);
  if (!row.usable || !parts || (row.oldPath && !safeParts(row.oldPath))) return workResult('unavailable');
  if (side === 'untracked' && row.x === '?' && row.y === '?') return preview(tree.root, parts, signal);
  const state = side === 'staged' ? row.x : row.y;
  if (side === 'untracked' || state === '?' || state === ' ') throw new Error('File does not have the requested change.');
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--ignore-submodules=dirty', '--submodule=short',
    '-O' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '--find-renames', ...(side === 'staged' ? ['--cached'] : []), '--', row.path];
  if (row.oldPath && /[RC]/.test(state)) args.push(row.oldPath);
  const { stdout, truncated } = await tree.git(args, { bytes: WORK_LIMIT, prefixOutput: true });
  const result = asText('diff', stdout, truncated);
  return /^Binary files .* differ$/m.test(result.text) ? workResult('binary') : result;
}

module.exports = { history, historyPage, files, status, diff };
