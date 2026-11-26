(() => {
  const laneX = n => 8 + 14 * n;
  const drawnX = (n, limit) => laneX(Math.min(n, limit)) + (n >= limit ? 2 : 0);
  const color = n => `var(--gg-lane-${n % 8})`;
  const hiddenSet = merged => new Set(merged?.branches?.length ? merged.hiddenHashes : []);
  function visible(commits, merged, showMerged) {
    if (showMerged || !merged?.branches?.length) return commits;
    const hidden = hiddenSet(merged);
    return commits.filter(c => !hidden.has(c.hash));
  }

  // Resolve entire routes before folding: a hidden endpoint must not leave a
  // misleading connected line in a visible lane. First parents inherit color.
  function layout(commits, limit) {
    const index = new Map(commits.map((c, i) => [c.hash, i]));
    const lanes = [], routes = [];
    let nextColor = 0;
    const hole = () => { const n = lanes.indexOf(null); return n < 0 ? lanes.length : n; };
    const rows = commits.map((c, i) => {
      let lane = lanes.findIndex(w => w?.oid === c.hash);
      if (lane < 0) lane = hole();
      const ink = lanes[lane]?.ink ?? nextColor++;
      lanes[lane] = null;
      lanes.forEach((w, j) => { if (w?.oid === c.hash) lanes[j] = null; });
      let stub = !c.parents.length;
      c.parents.forEach((oid, k) => {
        const to = index.get(oid);
        if (!(to > i)) { stub = true; return; }
        let run = k ? lanes.findIndex(w => w?.oid === oid) : lane;
        if (run < 0) run = hole();
        const edgeInk = k ? (lanes[run]?.ink ?? nextColor++) : ink;
        lanes[run] = { oid, ink: edgeInk };
        routes.push({ from: i, to, run, ink: edgeInk });
      });
      return { c, lane, ink, stub, mark: lane >= limit, extent: Math.min(lane, limit), paths: new Map(), after: new Map() };
    });
    const add = (row, a, b, y, z, ink, dashed = false) => {
      const d = a === b ? `M${laneX(a)} ${y}V${z}` : `M${laneX(a)} ${y}C${laneX(a)} ${(y+z)/2} ${laneX(b)} ${(y+z)/2} ${laneX(b)} ${z}`;
      row.paths.set(d, { d, ink, dashed });
      row.extent = Math.max(row.extent, a, b);
    };
    for (const {from, to, run, ink} of routes) {
      const a = rows[from].lane, b = rows[to].lane;
      if (Math.max(a, b, run) >= limit) {
        if (a < limit) add(rows[from], a, a, 11, 18, ink, true);
        if (b < limit) add(rows[to], b, b, 4, 11, ink, true);
        for (let i = from; i <= to; i++) { rows[i].mark = true; rows[i].extent = limit; }
        continue;
      }
      // The inclusive interval is significant: incoming/outgoing curves and
      // passing tracks reserve space even when the current dot is farther left.
      for (let i = from; i <= to; i++) {
        add(rows[i], i === from ? a : run, i === to ? b : run, i === from ? 11 : 0, i === to ? 11 : 22, ink);
        if (i < to) rows[i].after.set(run, ink);
      }
    }
    for (const row of rows) {
      if (row.stub && row.lane < limit) add(row, row.lane, row.lane, 11, 21, row.ink, true);
      row.padding = drawnX(row.extent, limit) + 13.5;
      row.detailPadding = row.after.size ? laneX(Math.max(...row.after.keys())) + 13.5 : row.padding;
    }
    return rows;
  }
  function chips(c, head, branch) {
    const refs = c.refs, consumed = new Set();
    const local = name => {
      const remotes = refs.filter(r => r.kind === 'remote' && r.name.slice(r.name.indexOf('/') + 1) === name && r.name.includes('/'));
      remotes.forEach(r => consumed.add(r));
      return remotes.length ? `${name} | ${remotes.map(r => r.name.split('/')[0]).join(',')}` : name;
    };
    const out = [];
    if (c.hash === head) out.push({kind:'head', name: branch ? `HEAD → ${local(branch)}` : 'HEAD'});
    for (const r of refs) if (r.kind === 'branch' && !(c.hash === head && r.name === branch)) out.push({kind:'branch', name:local(r.name)});
    for (const r of refs) if (!['head','branch','worktree'].includes(r.kind) && !consumed.has(r)) out.push(r);
    return out;
  }
  function historyLoader(connection) {
    return async (sessionId, cursor, signal) => {
      const first = cursor === null;
      const result = await connection.rpc.call('/api', first ? 'gitGraph/history' : 'gitGraph/historyPage',
        {args:first ? {sessionId} : {sessionId,cursor}}, signal);
      if (!result.ok) throw Object.assign(new Error(result.error?.message || result.error?.code || String(result.error)), {code:result.error?.code});
      return result.value;
    };
  }

  // One pager per mounted session/cwd. Lock and invalidate synchronously, before
  // React renders a disabled button; an RPC may settle even after it was aborted.
  function historyPager(sessionId, load, publish) {
    let state = {phase:'idle', data:null, cursor:null}, request = null, active = false;
    function update(next) { state = next; publish(next); }
    async function fetchPage(append, discard = false) {
      if (!active || (append ? request || !state.cursor : request && state.phase === 'loading')) return;
      request?.abort();
      const current = request = new AbortController(), cursor = append ? state.cursor : null;
      update({phase:append ? 'appending' : 'loading', data:discard ? null : state.data, cursor});
      try {
        const page = await load(sessionId, cursor, current.signal);
        if (request !== current) return;
        let data = page;
        if (append) {
          const seen = new Set(state.data.commits.map(c => c.hash));
          const commits = state.data.commits.slice();
          for (const c of page.commits) if (!seen.has(c.hash)) { seen.add(c.hash); commits.push(c); }
          // Folding proofs belong to the first page. A continuation's empty
          // metadata is not a reason to reveal previously folded rows.
          data = {...state.data, page:page.page, truncated:page.truncated, commits};
        }
        // Older Host modules can remain cached after a Client upgrade. Keep
        // their first page, but never mistake a truncated legacy page for EOF.
        update({phase:!page.page && page.truncated ? 'legacy' : 'ready', data, cursor:page.page?.nextCursor ?? null, appendedFrom:append ? state.data.commits.length : null});
      } catch (err) {
        if (request !== current) return;
        if (append && err?.code === 'git-graph/restart') return fetchPage(false, true);
        update({...state, phase:append ? 'moreError' : 'refreshError', reason:String(err?.message || err)});
      } finally { if (request === current) request = null; }
    }
    return {
      start() { active = true; return fetchPage(false); },
      refresh:() => fetchPage(false), more:() => fetchPage(true),
      stop() { active = false; request?.abort(); request = null; },
    };
  }
  // A visible pane re-reads on an interval and right after the window regains
  // focus. A read in flight is never overlapped or queued behind another.
  function autoRefresh({run, busy, isVisible, target = null, ms = 10000, timers = {set: setInterval, clear: clearInterval}}) {
    let timer = null, stopped = false;
    const check = () => { if (!stopped && isVisible() && !busy()) run(); };
    const wake = () => check();
    return {
      start() {
        if (timer || stopped) return;
        target?.addEventListener?.('visibilitychange', wake);
        target?.addEventListener?.('focus', wake);
        timer = timers.set(check, ms);
      },
      stop() {
        stopped = true;
        if (timer) timers.clear(timer);
        timer = null;
        target?.removeEventListener?.('visibilitychange', wake);
        target?.removeEventListener?.('focus', wake);
      },
    };
  }
  // Each history mount owns a small cache of successful immutable commit lists.
  // Each expanded detail owns its request, including the right to publish/cache it.
  function commitFiles(connection, sessionId) {
    const cache = new Map();
    return async (oid, signal, publish) => {
      await Promise.resolve(); // StrictMode can dispose the first effect before sending.
      if (signal.aborted) return;
      try {
        let data = cache.get(oid);
        if (!data) {
          const result = await connection.rpc.call('/api', 'gitGraph/files', {args:{sessionId,oid}}, signal);
          if (signal.aborted) return;
          if (!result.ok) throw new Error(result.error?.message || result.error?.code || '');
          data = result.value;
          if (!Array.isArray(data?.files)) throw new Error();
        }
        cache.delete(oid);
        cache.set(oid,data);
        if (cache.size > 32) cache.delete(cache.keys().next().value);
        publish({phase:'ready',data});
      } catch (err) {
        if (!signal.aborted) publish({phase:'error',reason:String(err?.message || '')});
      }
    };
  }
  function displayPath(path) {
    // Quote only ambiguous names. Distinguish literal backslashes from escapes,
    // and make line breaks, bidi overrides and other invisible controls visible.
    if (!/["\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|^\s|\s$/u.test(path)) return path;
    return JSON.stringify(path).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, c =>
      c.split('').map(unit => '\\u'+unit.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
  }
  function workspaceGroups(files) {
    const groups={conflicts:[],staged:[],unstaged:[],untracked:[]};
    for (const f of files) {
      const xy=f.x+f.y;
      const add=(group,side,status)=>groups[group].push({file:f,side,status});
      if (xy==='??') add('untracked','untracked','?');
      else if (['DD','AU','UD','UA','DU','AA','UU'].includes(xy)) add('conflicts','unstaged',xy);
      else {
        if (f.x!==' ') add('staged','staged',f.x);
        if (f.y!==' ') add('unstaged','unstaged',f.y);
      }
    }
    return groups;
  }
  async function workspaceRead(connection,method,args,signal) {
    const result=await connection.rpc.call('/api',`gitGraph/${method}`,{args},signal);
    if (!result.ok) throw new Error(result.error?.message || result.error?.code || '');
    return result.value;
  }
  // Only interpret ordinary unified hunks; combined diffs and mode-only changes stay verbatim.
  function unifiedRows(text) {
    const lines=text.split('\n'); if(lines.at(-1)==='') lines.pop();
    const rows=[]; let inside=false,old=0,next=0,added=0,removed=0;
    for(const line of lines){
      const m=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if(m){ inside=true;old=Number(m[1]);next=Number(m[2]);rows.push({kind:'hunk',text:line});continue; }
      if(line.startsWith('diff ')||line.startsWith('@@@')){if(inside)return null;continue;}
      if(!inside)continue;
      const mark=line[0];
      if(mark==='\\'){rows.push({kind:'note',text:line});continue;}
      if(![' ','+','-'].includes(mark))return null;
      if(mark==='+')added++;if(mark==='-')removed++;
      rows.push({kind:mark==='+'?'add':mark==='-'?'del':'context',old:mark==='+'?'':old++,next:mark==='-'?'':next++,mark,text:line.slice(1)});
    }
    return inside?{rows,added,removed}:null;
  }
  if (typeof window === 'undefined' && typeof module !== 'undefined') { module.exports = {layout, visible, chips, historyLoader, historyPager, autoRefresh, commitFiles, displayPath, workspaceGroups, workspaceRead, unifiedRows}; return; }
  window.__ModuleLoader__.load({
    id: 'dsh-plugin-git-graph',
    factory(require) {
      const React = require('react');
      const { createElement: h, useEffect, useMemo, useState, useRef } = React;
      const ID = 'dsh-plugin-git-graph', SLOT = 'sidebar.right.pane.tab', NS = 'gitGraph';
      const copy = {
        en: { title:'Git Graph', guide:'Explore this session’s commit history', refresh:'Refresh', retry:'Retry', loading:'Loading history…', empty:'This repository has no commits yet.', outside:'This session’s working directory is not in a Git repository.', error:'Could not load commit history.', stale:'Refresh failed. Showing the previous history.', count:'{n} commits loaded', more:'Load more', loadingMore:'Loading more…', moreError:'Could not load more commits.', legacy:'Restart the DSH host to load older commits.', end:'End of history', source:'date-order · local refs · no fetch', hidden:'{n} commits hidden', detached:'Detached HEAD', noTitle:'(no subject)', parent:'Parents', root:'Root commit', merge:'Merge', branch:'Branch', remote:'Remote', tag:'Tag', worktree:'Worktree', head:'HEAD', other:'Ref', hash:'Commit', beyond:'outside this view', moreRefs:'Additional refs omitted', fold:'Folded lanes', show:'Show {n} merged branches', hide:'Hide {n} merged branches', copy:'Copy full commit hash', copied:'Copied', manual:'Select and copy the hash', details:'Commit details', files:'Changed files', filesLoading:'Loading changed files…', filesEmpty:'No files changed.', filesError:'Could not load changed files.', filesTruncated:'Only part of the file list is shown.', fileA:'Added', fileM:'Modified', fileD:'Deleted', fileR:'Renamed', fileT:'Type changed', fileC:'Copied', fileOther:'Changed' },
        zh: { title:'Git 提交图', guide:'浏览当前会话的提交历史', refresh:'刷新', retry:'重试', loading:'正在读取提交历史…', empty:'该仓库还没有提交。', outside:'当前会话的工作目录不在 Git 仓库中。', error:'无法读取提交历史。', stale:'刷新失败，仍显示上次读取的历史。', count:'已加载 {n} 个提交', more:'加载更多', loadingMore:'正在加载更多…', moreError:'无法加载更多提交。', legacy:'请重启 DSH 宿主以加载更早的提交。', end:'已到历史末尾', source:'date-order · 本地引用 · 不执行 fetch', hidden:'隐藏了 {n} 个提交', detached:'分离的 HEAD', noTitle:'（无标题）', parent:'父提交', root:'根提交', merge:'合并', branch:'分支', remote:'远程分支', tag:'标签', worktree:'工作树', head:'HEAD', other:'引用', hash:'提交', beyond:'不在当前视图中', moreRefs:'其余引用未显示', fold:'已折叠轨道', show:'显示已合入的 {n} 个分支', hide:'隐藏已合入的 {n} 个分支', copy:'复制完整提交哈希', copied:'已复制', manual:'请选择并复制哈希', details:'提交详情', files:'变更文件', filesLoading:'正在读取变更文件…', filesEmpty:'此提交没有文件变更。', filesError:'无法读取变更文件。', filesTruncated:'仅显示部分变更文件。', fileA:'新增', fileM:'修改', fileD:'删除', fileR:'重命名', fileT:'类型变更', fileC:'复制', fileOther:'变更' },
      };
      Object.assign(copy.en,{auto:'auto-refresh every 10 s',workspace:'Working tree',openWorkspace:'Open Git working tree changes',workspaceGuide:'Review all uncommitted changes in this repository',statusLoading:'Reading repository status…',statusError:'Could not read repository status.',clean:'Working tree clean. No uncommitted changes.',conflicts:'Conflicts',staged:'Staged changes',unstaged:'Unstaged changes',untracked:'Untracked files',diffLoading:'Loading comparison…',diffError:'Could not load comparison. Refresh if the file changed.',diffEmpty:'No textual changes.',preview:'File preview',binary:'Binary file; no text comparison.',unavailable:'Text comparison unavailable.',limited:'Output truncated.',fileCount:'{n} changed files'});
      Object.assign(copy.zh,{auto:'每 10 秒自动刷新',workspace:'工作区变更',openWorkspace:'打开 Git 工作区变更',workspaceGuide:'查看整个仓库尚未提交的改动',statusLoading:'正在读取仓库状态…',statusError:'无法读取仓库状态。',clean:'工作区干净，没有未提交的变更。',conflicts:'冲突',staged:'已暂存',unstaged:'未暂存',untracked:'未跟踪',diffLoading:'正在读取差异…',diffError:'无法读取差异；如果文件已变化，请刷新。',diffEmpty:'没有文本差异。',preview:'文件预览',binary:'二进制文件，无文本差异。',unavailable:'无法显示文本差异。',limited:'内容已截断。',fileCount:'{n} 个变更文件'});
      Object.assign(copy.en,{childScope:'{n} repositories in this folder',workspaceOutside:'No Git repository found here or in immediate subfolders.',partialStatus:'Partial results: some files or repositories were not listed.'});
      Object.assign(copy.zh,{childScope:'此目录下的 {n} 个仓库',workspaceOutside:'当前目录不在 Git 仓库中，直属子目录也未找到仓库。',partialStatus:'结果不完整：部分文件或仓库未列出。'});
      Object.assign(copy.zh,{comparison:'代码差异',rawPatch:'原始补丁',wrap:'自动换行',moreLines:'再显示 200 行',oldNew:'左列为旧行号，右列为新行号'});
      Object.assign(copy.en,{comparison:'Code changes',rawPatch:'Raw patch',wrap:'Wrap lines',moreLines:'Show 200 more lines',oldNew:'Old line numbers on the left, new on the right'});
      const style = `
.gg-ws-entry[aria-expanded=true]{background:var(--gg-hover);font-weight:600}.gg-ws .gg-patch{padding:0;border:1px solid var(--gg-border);border-radius:7px;overflow:hidden}.gg-diff-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:var(--gg-hover);padding:5px 8px;border-bottom:1px solid var(--gg-border)}.gg-diff-bar strong{margin-inline-end:auto}.gg-diff-bar label{display:inline-flex;align-items:center;gap:3px;cursor:pointer}.gg-diff-count{font:600 12px ui-monospace,monospace}.gg-diff-count.add{color:var(--gg-lane-4)}.gg-diff-count.del{color:var(--gg-lane-5)}.gg-diff-body{overflow:auto;max-height:55vh;overscroll-behavior:contain;font:12px/1.65 ui-monospace,monospace;tab-size:4;font-variant-numeric:tabular-nums}.gg-diff-lines{width:max-content;min-width:100%}.gg-wrap .gg-diff-lines{width:100%}.gg-code-row{display:grid;grid-template-columns:var(--gg-gutter) var(--gg-gutter) 2ch minmax(0,1fr);white-space:pre}.gg-wrap .gg-code-row,.gg-patch .gg-wrap pre{white-space:pre-wrap;overflow-wrap:anywhere}.gg-code-row.add{background:color-mix(in srgb,var(--gg-lane-4) 13%,transparent)}.gg-code-row.del{background:color-mix(in srgb,var(--gg-lane-5) 13%,transparent)}.gg-num,.gg-sign{color:var(--gg-muted);text-align:right;user-select:none}.gg-sign{text-align:center}.gg-hunk,.gg-diff-note{padding:3px 8px;color:var(--gg-muted);overflow-wrap:anywhere;white-space:pre-wrap}.gg-hunk{background:var(--gg-hover);border-block:1px solid var(--gg-border)}.gg-ws .gg-diff-body pre{max-height:none;overflow:visible;padding:6px 8px}.gg-diff-body code{font:inherit}

.gg-ws h3{font:inherit;font-weight:600;margin:12px 6px 4px}.gg-ws ul{list-style:none;padding:0;margin:0}.gg-ws-entry{width:100%;display:flex;gap:6px;align-items:baseline;padding:5px 6px;text-align:start;background:none;border:0;border-radius:4px}.gg-ws-entry code{font-size:inherit}.gg-ws-status{color:var(--gg-muted);min-width:2ch;font-family:monospace}.gg-patch{margin:2px 6px 8px;padding:6px 8px;border-inline-start:2px solid var(--gg-border);min-width:0}.gg-patch pre{direction:ltr;overflow:auto;max-height:48vh;margin:0;tab-size:4;white-space:pre;font:12px/1.55 ui-monospace,monospace}.gg-ws .gg-scroll{padding-bottom:12px}
.gg-files{margin-top:5px;border-top:1px solid var(--gg-border);padding-top:4px}.gg-files h3{font:inherit;font-weight:600;margin:0}.gg-files ul{list-style:none;margin:3px 0;padding:0}.gg-files li{display:flex;align-items:baseline;gap:6px}.gg-file-status{flex:none;color:var(--gg-muted)}.gg-file-path{min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}.gg-files button{margin:2px 0;background:none;border:1px solid var(--gg-border);border-radius:4px}
.gg-line{display:flex;align-items:center;min-width:0}.gg-chips{display:inline-flex;flex:0 1 auto;min-width:0}.gg-line .gg-chips .gg-ref{min-width:0;max-width:none}.gg-line .gg-sub{flex:1 1 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.gg-line .k-more{flex:none}.gg-view .gg-detail .gg-ref{box-sizing:border-box;max-width:100%;white-space:normal;overflow-wrap:anywhere}.gg-detail-summary{white-space:normal;overflow-wrap:anywhere}.gg-note{margin:0;flex:none}
.gg-view{--gg-fg:var(--dsw-alias-label-primary);--gg-muted:var(--dsw-alias-label-secondary);--gg-border:var(--dsw-alias-border-l2);--gg-hover:var(--dsw-alias-interactive-bg-hover);--gg-accent:var(--dsw-alias-state-business-primary);--gg-row:max(22px,1.5em);height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;color:var(--gg-fg);font-size:.8125rem}
/* The graph artwork shares the reference palette; chrome inherits DSH tokens. */
.gg-view{--gg-lane-0:light-dark(#075e56,#3ccbb9);--gg-lane-1:light-dark(#174bad,#72a7f5);--gg-lane-2:light-dark(#5b34b5,#a98bf5);--gg-lane-3:light-dark(#8a3908,#f2914a);--gg-lane-4:light-dark(#0f6a34,#4cc77e);--gg-lane-5:light-dark(#7c1a20,#f2767a);--gg-lane-6:light-dark(#5f4711,#d6a84e);--gg-lane-7:light-dark(#4a5a62,#9db0b8);--gg-branch:light-dark(#0a5f58,#8ae6d9);--gg-branch-bg:light-dark(#e3f4f1,#12302d);--gg-remote:light-dark(#43535c,#c2ced4);--gg-remote-bg:light-dark(#eef3f3,#1b2428);--gg-tag:light-dark(#6b3fa0,#cabaf9);--gg-tag-bg:light-dark(#f0ebfd,#231c3a);}
.gg-bar,.gg-note{padding:5px 8px;overflow-wrap:anywhere}.gg-bar{display:flex;gap:5px 8px;align-items:center;flex-wrap:wrap;border-bottom:1px dashed var(--gg-border)}.gg-bar h2{font:inherit;font-weight:600;margin:0}.gg-context{color:var(--gg-muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.gg-view button{font:inherit;color:inherit;cursor:pointer}.gg-bar button,.gg-toggle{background:none;border:1px solid var(--gg-border);border-radius:4px;padding:2px 7px}.gg-view button:hover,.gg-row:hover{background:var(--gg-hover)}.gg-view :focus-visible{outline:2px solid var(--gg-accent);outline-offset:-2px}.gg-toggle{align-self:flex-start;margin:4px 8px}.gg-note,.gg-date,.gg-author,.gg-hash{font-size:.88em;color:var(--gg-muted)}.gg-scroll{overflow:auto;overflow-anchor:none;min-height:0;flex:1;padding:3px 4px}.gg-table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:inherit}.gg-table td{border:0;padding:0 4px}.gg-row{height:var(--gg-row);cursor:pointer}.gg-row[aria-current=true],.gg-row[aria-expanded=true]{background:var(--gg-hover)}.gg-cell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gg-subject{position:relative}.gg-ink{position:absolute;inset:0 auto 0 0;pointer-events:none}.gg-ink svg{width:100%;height:100%;display:block}.gg-node,.gg-mark{position:absolute;top:50%;transform:translate(-50%,-50%)}.gg-node{width:7px;height:7px;border-radius:100%;background:currentColor}.gg-node.hollow,.gg-node.folded{box-sizing:border-box;background:var(--dsw-alias-bg-base);border:2px solid currentColor}.gg-node.folded{border-radius:0;transform:translate(-50%,-50%) rotate(45deg)}.gg-mark{color:var(--gg-muted);font:12px monospace}.gg-merge .gg-sub{color:var(--gg-muted)}.gg-ref{display:inline-block;margin-right:4px;max-width:48ch;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;border-radius:4px;padding:1px 5px;background:var(--gg-hover);font:600 .85em ui-monospace,monospace}.gg-ref.k-head,.gg-ref.k-branch{color:var(--gg-branch);background:var(--gg-branch-bg)}.gg-ref.k-head{font-weight:750}.gg-ref.k-tag{color:var(--gg-tag);background:var(--gg-tag-bg)}.gg-ref.k-remote{color:var(--gg-remote);background:var(--gg-remote-bg)}.gg-ref.k-remote,.gg-ref.k-worktree,.gg-ref.k-more{border:1px solid var(--gg-border);font-weight:400}.gg-ref.k-worktree,.gg-ref.k-more{border-style:dashed}.gg-ref.k-worktree:before{content:'● ';font-size:.8em}.gg-hashcol{width:calc(7ch + 12px)}.gg-datecol{width:17ch}.gg-authorcol{width:12ch}.gg-view .gg-hash{display:block;width:100%;min-height:var(--gg-row);padding:0;border:0;background:none;color:var(--gg-muted);font: .9em ui-monospace,monospace}.gg-detail td{position:relative;padding-block:5px;border-bottom:1px dashed var(--gg-border);overflow-wrap:anywhere;color:var(--gg-muted);font-size:.9em}.gg-detail code{user-select:all;color:var(--gg-fg)}.gg-sr{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.gg-note{margin:0}.gg-narrow .gg-ref{max-width:16ch}@media(pointer:coarse){.gg-view{--gg-row:max(32px,1.5em)}}`;
      function Tracks({row, limit, detail = false}) {
        const {lane, extent, ink} = row, width = drawnX(extent, limit) + 8;
        const paths = detail ? [...row.after].map(([n, ink]) => ({d:`M${laneX(n)} 0V22`, ink})) : [...row.paths.values()];
        return h('span', {className:'gg-ink','aria-hidden':true,style:{width}},
          h('svg',{viewBox:`0 0 ${width} 22`,preserveAspectRatio:'none',focusable:false},paths.map(({d,ink,dashed}) => h('path',{key:d,d,fill:'none',stroke:color(ink),strokeWidth:2,strokeDasharray:dashed?'1 3':undefined,vectorEffect:'non-scaling-stroke'}))),
          !detail && h('span',{className:`gg-node ${lane >= limit ? 'folded' : row.c.parents.length > 1 ? 'hollow' : ''}`,style:{left:drawnX(lane,limit),color:color(ink)}}),
          !detail && row.mark && lane < limit && h('span',{className:'gg-mark',style:{left:drawnX(limit,limit)}},'⋮'));
      }
      function ChangedFiles({oid,readFiles,t,rowRef}) {
        const [state,setState]=useState({phase:'loading'}), [attempt,retry]=useState(0);
        useEffect(()=>{
          const request=new AbortController();
          readFiles(oid,request.signal,setState);
          return ()=>request.abort();
        },[oid,readFiles,attempt]);
        const data=state.data;
        const path=p=>h('bdi',{dir:'ltr',translate:'no'},displayPath(p));
        return h('section',{className:'gg-files','aria-label':t('files')},h('h3',null,t('files')),
          h('div',{role:'status'},state.phase==='loading' ? t('filesLoading') : state.phase==='error' ? `${t('filesError')} ${state.reason}` : !data.files.length && !data.truncated ? t('filesEmpty') : ''),
          state.phase==='error' && h('button',{type:'button',onClick:()=>{rowRef.current?.focus({preventScroll:true});setState({phase:'loading'});retry(n=>n+1);}},t('retry')),
          data?.files.length>0 && h('ul',null,data.files.map((f,i)=>h('li',{key:i},
            h('span',{className:'gg-file-status'},t(['A','M','D','R','T','C'].includes(f.status)?`file${f.status}`:'fileOther')),
            h('code',{className:'gg-file-path'},f.oldPath!=null && path(f.oldPath),f.oldPath!=null && ' → ',path(f.path))))),
          data?.truncated && h('div',null,t('filesTruncated')));
      }
      function Commit({row,limit,wide,head,branch,hashes,t,open,toggle,feedback,onCopy,readFiles}) {
        const {c} = row, merge = c.parents.length > 1, narrow = limit === 4;
        const detailId=React.useId(), rowRef=useRef(null);
        const all = chips(c, head, branch), trees = c.refs.filter(r => r.kind === 'worktree');
        const labels = [...all, ...trees], shown = labels.slice(0, narrow ? 1 : 3), overflow = labels.slice(shown.length);
        const badge = (r,i) => h('span',{key:r.kind+i,className:`gg-ref k-${r.kind}`,title:`${t(r.kind)}: ${r.name}`},r.name);
        const date = new Date(c.date);
        const pad = n => String(n).padStart(2,'0');
        const when = Number.isNaN(+date) ? c.date : `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
        return h(React.Fragment,null,h('tr',{className:`gg-row${merge?' gg-merge':''}`,ref:rowRef,'data-oid':c.hash,tabIndex:0,'aria-controls':open?detailId:undefined,'aria-current':c.hash===head || undefined,'aria-expanded':open,'aria-label':`${t('details')}: ${c.subject || c.hash}`,
          onClick:e=>{if(!e.target.closest('button') && !window.getSelection()?.toString()) toggle(c.hash);},onKeyDown:e=>{if(e.target===e.currentTarget && ['Enter',' '].includes(e.key)){e.preventDefault();toggle(c.hash);}}},
          h('td',{className:'gg-cell gg-subject',style:{paddingLeft:row.padding},title:c.subject},h(Tracks,{row,limit}),h('span',{className:'gg-line'},shown.length>0 && h('span',{className:'gg-chips'},...shown.map(badge)),
            (overflow.length>0 || c.refsTruncated) && h('span',{className:'gg-ref k-more',title:[...overflow.map(r=>r.name),...(c.refsTruncated?[t('moreRefs')]:[])].join(', ')},overflow.length?`+${overflow.length}${c.refsTruncated?'…':''}`:'…'),
            h('span',{className:'gg-sub'},c.subject || t('noTitle'))),h('span',{className:'gg-sr'},[merge && t('merge'),row.mark && t('fold'),row.stub && c.parents.length>0 && t('beyond')].filter(Boolean).join(', '))),
          !narrow && h('td',{className:'gg-cell gg-date',title:c.date},h('time',{dateTime:c.date},when)),wide && h('td',{className:'gg-cell gg-author',title:c.author},c.author),
          h('td',null,h('button',{type:'button',className:'gg-hash',title:`${t('copy')}: ${c.hash}`,'aria-label':`${t('copy')}: ${c.hash}`,onClick:()=>onCopy(c.hash)},feedback?.oid===c.hash && feedback.ok?'✓':c.hash.slice(0,7)))),
          open && h('tr',{id:detailId,className:'gg-detail'},h('td',{colSpan:2+Number(!narrow)+Number(wide),style:{paddingLeft:row.detailPadding}},h(Tracks,{row,limit,detail:true}),
            h('div',{className:'gg-detail-summary'},c.subject || t('noTitle')),h('div',null,t('hash'),': ',h('code',{ref:el=>{if(el && feedback?.oid===c.hash && !feedback.ok){const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(el);selection?.removeAllRanges();selection?.addRange(range);}}},c.hash)),h('div',null,c.parents.length ? `${t('parent')}: ` : t('root'),c.parents.map((p,i)=>h('span',{key:p},i?', ':'',h('code',null,p),hashes.has(p)?'':` (${t('beyond')})`))),narrow && h('div',null,c.author,' · ',when),labels.map(badge),h(ChangedFiles,{oid:c.hash,readFiles,t,rowRef}))));
      }
      function useAutoRefresh(run, busy) {
        const live = useRef({run, busy}); live.current = {run, busy};
        useEffect(() => {
          if (typeof document === 'undefined' || typeof window === 'undefined') return;
          const controller = autoRefresh({run:() => live.current.run(), busy:() => live.current.busy(),
            isVisible:() => document.visibilityState === 'visible', target:window});
          controller.start();
          return () => controller.stop();
        }, []);
      }
      function History({sessionId, actions, load, connection, t}) {
        const readFiles=useMemo(()=>commitFiles(connection,sessionId),[connection,sessionId]);
        const [state,setState]=useState({phase:'loading'}),[selected,select]=useState(null),[showMerged,setShowMerged]=useState(false),[size,setSize]=useState(0),[feedback,setFeedback]=useState(null);
        const pane=useRef(null), moreButton=useRef(null), focusAfterAppend=useRef(null), note=useRef(null), attempt=useRef(0);
        const pager=useMemo(()=>historyPager(sessionId,load,next=>{
          const button=moreButton.current;
          focusAfterAppend.current=next.appendedFrom!=null && button && button.ownerDocument.activeElement===button ? button : null;
          setState(next);
        }),[sessionId,load]);
        useEffect(()=>{
          // Skip an RPC for an already-disposed mount (including StrictMode's probe).
          let mounted=true;
          queueMicrotask(()=>{if(mounted) pager.start();});
          return ()=>{mounted=false;pager.stop();};
        },[pager]);
        useEffect(()=>actions.bindCommands({refresh:pager.refresh}),[actions,pager]);
        const phaseRef=useRef(phase); phaseRef.current=phase;
        useAutoRefresh(pager.refresh,()=>phaseRef.current==='loading'||phaseRef.current==='appending');
        useEffect(()=>{const el=pane.current;const measure=()=>setSize(el.clientWidth);measure();const ro=new ResizeObserver(measure);ro.observe(el);return ()=>ro.disconnect();},[]);
        useEffect(()=>{if(!feedback)return;const id=setTimeout(()=>setFeedback(null),2200);return ()=>clearTimeout(id);},[feedback]);
        useEffect(()=>()=>{attempt.current++;},[]);
        async function onCopy(oid){const i=++attempt.current;let ok=false;try{await navigator.clipboard.writeText(oid);ok=true;}catch{}if(i!==attempt.current)return;setFeedback({oid,ok});if(!ok)select(oid);}
        const {data,phase,cursor}=state, busy=phase==='loading', appending=phase==='appending', failed=phase==='refreshError', limit=size<=480?4:12,wide=size>=768;
        const commits=useMemo(()=>visible(data?.commits || [],data?.merged,showMerged),[data,showMerged]);
        const rows=useMemo(()=>layout(commits,limit),[commits,limit]),hashes=useMemo(()=>new Set(commits.map(c=>c.hash)),[commits]);
        useEffect(()=>{if(selected && !hashes.has(selected)) select(null);},[selected,hashes]);
        React.useLayoutEffect(()=>{
          const button=focusAfterAppend.current;
          focusAfterAppend.current=null;
          if (!button) return;
          const doc=button.ownerDocument;
          if (doc.activeElement!==button && (button.isConnected || doc.activeElement!==doc.body)) return;
          const first=data.commits.slice(state.appendedFrom).find(c=>hashes.has(c.hash));
          // The Host validates full hexadecimal OIDs. Focus without scrolling:
          // keyboard traversal continues at the new rows rather than skipping them.
          const target=first ? pane.current.querySelector(`[data-oid="${first.hash}"]`) : moreButton.current || note.current;
          target?.focus({preventScroll:true});
        },[state,data,hashes]);
        const total=data?.commits.length || 0,merged=data?.merged?.branches.length || 0;
        const status=[total>0 && t('count',{n:total}),total>rows.length && t('hidden',{n:total-rows.length}),
          busy?t('loading'):failed?`${t(total?'stale':'error')} ${state.reason}`:phase==='moreError'?`${t('moreError')} ${state.reason}`:
          appending?t('loadingMore'):phase==='legacy'?t('legacy'):data?.status==='not-repo'?t('outside'):!total?t('empty'):!cursor?t('end'):null].filter(Boolean).join(' · ');
        return h('section',{ref:pane,className:`gg-view ${limit===4?'gg-narrow':''}`,'aria-label':t('title')},h('style',null,style),
          h('header',{className:'gg-bar'},h('h2',null,t('title')),h('span',{className:'gg-context'},data?.branch || (data?.head?t('detached'):'')),h('button',{type:'button',onClick:pager.refresh,disabled:busy},t(failed?'retry':'refresh'))),
          merged>0 && h('button',{type:'button',className:'gg-toggle','aria-pressed':showMerged,onClick:()=>setShowMerged(v=>!v)},t(showMerged?'hide':'show',{n:merged})),
          h('div',{className:'gg-scroll','aria-busy':busy || appending},rows.length>0 && h('table',{className:'gg-table','aria-label':t('title')},h('colgroup',null,h('col'),limit!==4 && h('col',{className:'gg-datecol'}),wide && h('col',{className:'gg-authorcol'}),h('col',{className:'gg-hashcol'})),h('tbody',null,rows.map(row=>h(Commit,{key:row.c.hash,row,limit,wide,hashes,head:data.head,branch:data.branch,t,open:selected===row.c.hash,toggle:id=>select(prev=>prev===id?null:id),feedback,onCopy,readFiles})))),
            cursor && h('button',{type:'button',ref:moreButton,className:'gg-toggle gg-more','aria-disabled':appending,onClick:pager.more},t(appending?'loadingMore':phase==='moreError'?'retry':'more'))),
          h('p',{ref:note,tabIndex:-1,className:'gg-note',role:'status'},status,total>0?` · ${t('source')} · ${t('auto')}`:` · ${t('auto')}`),
          h('span',{className:'gg-sr',role:'status'},feedback?t(feedback.ok?'copied':'manual'):''));
      }
      // An expanded row owns its diff request; refreshing the listing remounts all rows.
      function useWorkspaceRead(connection,method,args,version,quiet=false) {
        const [state,setState]=useState({phase:'loading'});
        useEffect(()=>{
          const controller=new AbortController();
          // A quiet (automatic) re-read keeps the previous listing on screen.
          setState(prev => quiet && prev.data ? prev : {phase:'loading'});
          (async()=>{
            await Promise.resolve();
            if(controller.signal.aborted) return;
            try {
              const data=await workspaceRead(connection,method,args,controller.signal);
              if(!controller.signal.aborted) setState({phase:'ready',data});
            } catch(err) {
              if(!controller.signal.aborted) setState({phase:'error',reason:String(err?.message || '')});
            }
          })();
          return ()=>controller.abort();
        },[connection,method,args,version,quiet]);
        return state;
      }
      function CodeDiff({data,label,t}) {
        const [wrap,setWrap]=useState(true),[raw,setRaw]=useState(false),[limit,setLimit]=useState(200);
        const model=useMemo(()=>data.kind==='diff'?unifiedRows(data.text):null,[data]);
        const rich=model&&!raw;
        const widths=useMemo(()=>model?model.rows.reduce((n,r)=>Math.max(n,String(r.old??'').length,String(r.next??'').length),2):2,[model]);
        const check=(text,value,update)=>h('label',null,h('input',{type:'checkbox',checked:value,onChange:e=>update(e.target.checked)}),text);
        return h(React.Fragment,null,
          h('div',{className:'gg-diff-bar'},h('strong',null,t(data.kind==='preview'?'preview':'comparison')),
            model&&h(React.Fragment,null,h('span',{className:'gg-diff-count add'},'+'+model.added),h('span',{className:'gg-diff-count del'},'−'+model.removed)),
            model&&check(t('rawPatch'),raw,setRaw),check(t('wrap'),wrap,setWrap)),
          h('div',{className:'gg-diff-body'+(wrap?' gg-wrap':''),tabIndex:0,dir:'ltr',role:'region','aria-label':label,translate:'no'},
            rich?h('div',{className:'gg-diff-lines',style:{'--gg-gutter':(widths+1)+'ch'},title:t('oldNew')},model.rows.slice(0,limit).map((r,i)=>r.mark===undefined?
              h('div',{key:i,className:r.kind==='hunk'?'gg-hunk':'gg-diff-note'},r.text):
              h('div',{className:'gg-code-row '+r.kind,key:i},h('span',{className:'gg-num','aria-hidden':true},r.old),h('span',{className:'gg-num','aria-hidden':true},r.next),h('span',{className:'gg-sign'},r.mark),h('code',null,r.text)))):h('pre',null,data.text)),
          rich&&model.rows.length>limit&&h('button',{className:'gg-toggle',type:'button',onClick:()=>setLimit(n=>n+200)},t('moreLines')));
      }
      function Patch({sessionId,entry,connection,t}) {
        const args=useMemo(()=>({sessionId,id:entry.file.id,side:entry.side}),[sessionId,entry.file.id,entry.side]);
        const [attempt,setAttempt]=useState(0);
        const {phase,data,reason}=useWorkspaceRead(connection,'diff',args,attempt);
        return h('div',{className:'gg-patch'},
          phase==='loading' && h('span',{role:'status'},t('diffLoading')),
          phase==='error' && h('div',{role:'status'},t('diffError'),' ',reason,h('button',{type:'button',className:'gg-toggle',onClick:()=>setAttempt(i=>i+1)},t('retry'))),
          data && (['binary','unavailable'].includes(data.kind) ? h('p',null,t(data.kind)) :
            data.text ? h(CodeDiff,{data,t,label:t(entry.side)+' · '+displayPath(entry.file.path)}) : h('span',null,t('diffEmpty'))),
          data?.truncated && h('div',{role:'status'},t('limited')));
      }
      function Workspace({sessionId,actions,connection,t}) {
        const panelId=React.useId();
        const [revision,setRevision]=useState({n:0,manual:false}),[expanded,expand]=useState(null);
        const refresh=useMemo(()=>()=>{expand(null);setRevision(s=>({n:s.n+1,manual:true}));},[]);
        useEffect(()=>actions.bindCommands({refresh}),[actions,refresh]);
        const args=useMemo(()=>({sessionId}),[sessionId]);
        const {data,phase,reason}=useWorkspaceRead(connection,'status',args,revision,!revision.manual);
        const phaseRef=useRef(phase); phaseRef.current=phase;
        // Automatic re-reads keep the expanded file open; its diff request is keyed by content.
        useAutoRefresh(useMemo(()=>()=>setRevision(s=>({n:s.n+1,manual:false})),[]),()=>phaseRef.current==='loading');
        const groups=useMemo(()=>workspaceGroups(data?.files || []),[data]);
        const path=p=>h('bdi',{dir:'ltr',translate:'no'},displayPath(p));
        const message=phase==='loading'?t('statusLoading'):phase==='error'?`${t('statusError')} ${reason}`:data.status==='not-repo'?t('workspaceOutside'):data.files.length?t('fileCount',{n:data.files.length}):!data.truncated?t('clean'):'';
        return h('section',{className:'gg-view gg-ws','aria-label':t('workspace')},h('style',null,style),
          h('header',{className:'gg-bar'},h('h2',null,t('workspace')),h('span',{className:'gg-context'},data?.scope==='children'?t('childScope',{n:data.repoCount}):''),h('button',{type:'button',onClick:refresh,disabled:phase==='loading'},t(phase==='error'?'retry':'refresh'))),
          h('div',{className:'gg-note',role:'status'},message,data?.truncated && ' '+t('partialStatus'),message && ' · ',t('auto')),
          h('div',{className:'gg-scroll','aria-busy':phase==='loading'},Object.entries(groups).filter(([,entries])=>entries.length).map(([group,entries])=>h('section',{key:group},
            h('h3',null,t(group),' · ',entries.length),h('ul',null,entries.map(entry=>{
              const {file,status}=entry,key=JSON.stringify([entry.side,file.id]),open=key===expanded;
              const label=['A','M','D','R','T','C'].includes(status)?t('file'+status):t(group);
              return h('li',{key},h('button',{type:'button',className:'gg-ws-entry','aria-expanded':open,'aria-controls':open?panelId:undefined,onClick:()=>expand(open?null:key)},
                h('span',{'aria-hidden':true},open?'▾':'▸'),h('span',{className:'gg-ws-status',title:label,'aria-label':label},status),
                h('code',{className:'gg-file-path'},file.oldPath!=null && ['R','C'].includes(status) && path(file.oldPath),file.oldPath!=null && ['R','C'].includes(status) && ' → ',path(file.path))),
                open && h('div',{id:panelId},h(Patch,{key:revision,sessionId,entry,connection,t})));
            }))))));
      }
      function WorkspaceIcon({size=24}={}){return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:'M5 3h9l5 5v13H5zM14 3v5h5M8 12h6m-3-3v6m-3 3h6'}));}
      function Icon(){return h('svg',{width:24,height:24,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,'aria-hidden':true},h('path',{d:'M6 6v12m0-3c0-4 12-1 12-8'}),...[[6,4],[6,20],[18,5]].map(([cx,cy])=>h('circle',{key:cy,cx,cy,r:2})));}
      copy.zh.openGraph='打开 Git 提交图'; copy.en.openGraph='Open Git commit graph';
      return {inject:['slots','sidebarRight','sidebarRightTabs','connection','locale'],apply(ctx){
        ctx.effect(()=>ctx.locale.register(NS,copy));const t=ctx.locale.bind(NS);
        const headerSlot='conversation.session.header.utilities';
        function HeaderGraph({sessionId}) {
          const label=t('openGraph');
          function open(kind) {
            const sidebar=ctx.sidebarRight;
            if(sidebar.mounted.getSnapshot()!==sessionId) return;
            const tab=sidebar.tabsIn(sessionId).find(item=>item.kind===kind);
            // Target the existing tab's own pane, even if floating. As the target already
            // contains this singleton page the host reveals it instead of replacing it.
            sidebar.openTab(kind,tab ? {replaceTab:tab.id} : undefined);
          }
          return h(React.Fragment,null,h('style',null,'.gg-header-open{display:inline-grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.gg-header-open:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.gg-header-open:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary)}'),h('button',{type:'button',className:'gg-header-open',title:t('openWorkspace'),'aria-label':t('openWorkspace'),onClick:()=>open('git-working-tree')},h(WorkspaceIcon,{size:18})),h('button',{type:'button',className:'gg-header-open',title:label,'aria-label':label,onClick:()=>open('git-graph')}, h('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,'aria-hidden':true},h('path',{d:'M5 6v12m0-9c0 4 7 2 7 6M12 8h8m-5 5h5m-9 5h9'}),h('circle',{cx:5,cy:4,r:2}),h('circle',{cx:5,cy:20,r:2}))));
        }
        ctx.effect(()=>ctx.slots.inject(headerSlot,()=>ctx.slots.register({name:headerSlot,id:ID,order:-9,locale:NS},HeaderGraph)));
        const load=historyLoader(ctx.connection);
        ctx.effect(()=>ctx.sidebarRightTabs.register({id:ID,kind:'git-graph',title:()=>t('title'),guide:[{id:'history',order:45,title:()=>t('title'),description:()=>t('guide'),icon:Icon}]}));
        const workspaceId=ID+'-working-tree';
        ctx.effect(()=>ctx.sidebarRightTabs.register({id:workspaceId,kind:'git-working-tree',title:()=>t('workspace'),guide:[{id:'workspace',order:44,title:()=>t('workspace'),description:()=>t('workspaceGuide'),icon:WorkspaceIcon}]}));
        function WorkspaceBody({sessionId,useSessions,useTabInfo,t}){const cwd=useSessions(s=>s.byId[sessionId]?.cwd);const {tab}=useTabInfo();return h(Workspace,{key:JSON.stringify([sessionId,cwd]),sessionId,actions:tab.actions,connection:ctx.connection,t});}
        ctx.effect(()=>ctx.slots.inject(SLOT,()=>ctx.slots.register({name:SLOT,key:workspaceId,locale:NS},WorkspaceBody)));
        function Body({sessionId,useSessions,useTabInfo,t}){const cwd=useSessions(s=>s.byId[sessionId]?.cwd);const {tab}=useTabInfo();return h(History,{key:JSON.stringify([sessionId,cwd]),sessionId,actions:tab.actions,t,load,connection:ctx.connection});}
        ctx.effect(()=>ctx.slots.inject(SLOT,()=>ctx.slots.register({name:SLOT,key:ID,locale:NS},Body)));
      }};
    },
  });
})();
