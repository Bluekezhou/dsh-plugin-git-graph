const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const m = {exports:{}};
vm.runInNewContext(fs.readFileSync(require.resolve('../client.js'), 'utf8'), {module:m, AbortController});
const {layout,visible,chips,historyPager,historyLoader} = m.exports;
const c = (hash, ...parents) => ({hash, parents, refs:[]});

// Both lanes want J after B. Lane 1 must stay open until J, instead of
// collapsing into lane 0 at B. The graph narrows again below J.
const repo = [c('M','A','B'), c('A','X'), c('B','J'), c('X','J'), c('J','S'), c('S')];
test('per-row subject padding includes passing tracks, arrivals and departures, then shrinks', () => {
  const rows = layout(repo, 12);
  assert.deepEqual(Array.from(rows, r => r.padding), [35.5,35.5,35.5,35.5,35.5,21.5]);
  assert.deepEqual(Array.from(rows, r => r.lane), [0,0,1,0,0,0]);
  assert.deepEqual(Array.from(rows[3].after.keys()).sort(),[0,1]);
  assert.notEqual(rows[3].after.get(0), rows[3].after.get(1));
  assert.deepEqual(Array.from(rows[4].after.keys()),[0]);
  assert.equal(rows[4].detailPadding,21.5);
  assert.equal(rows[5].after.size,0);
});
test('expanded detail bridges precisely the same lanes as the two neighboring commit edges', () => {
  const rows = layout(repo,12);
  for(let i=0; i<rows.length-1; i++) {
    for(const [n,ink] of rows[i].after) {
      const x=8+14*n;
      assert.ok([...rows[i].paths.values()].some(p=>p.ink===ink && (p.d.endsWith(`${x} 22`) || (p.d.startsWith(`M${x} `) && p.d.endsWith('V22')))));
      assert.ok([...rows[i+1].paths.values()].some(p=>p.ink===ink && p.d.startsWith(`M${x} 0`)));
    }
  }
});
test('narrow cap keeps visible lanes at 14px pitch, isolates folded routes and releases their indent', () => {
  const repo=[c('M','a','b','c','d','e'), ...['a','b','c','d','e'].map(h=>c(h,'J')),c('J','S'),c('S')];
  const rows=layout(repo,4);
  assert.equal(rows[5].lane,4);
  assert.equal(rows[3].padding,79.5); // foldX = 8 + 4*14 + 2
  assert.equal(rows[6].mark,true);
  assert.equal(rows[7].padding,21.5);
  assert.ok(rows.every(r=>[...r.after.keys()].every(n=>n<4)));
  assert.ok(rows.some(r=>[...r.paths.values()].some(p=>p.d.includes('50 ')))); // fourth visible lane
});
test('default merged filter relayouts the graph, while missing metadata leaves every row intact', () => {
  const merged={branches:['topic'],hiddenHashes:['B']};
  assert.equal(visible(repo,undefined,false),repo);
  assert.equal(visible(repo,merged,true),repo);
  const collapsed=visible(repo,merged,false);
  assert.equal(collapsed.length,5);
  assert.equal(layout(collapsed,12)[0].padding,21.5);
  assert.equal(layout(visible(repo,merged,true),12)[0].padding,35.5);
});
test('head combines its local and remote branch; worktree labels stay distinct from ref chips', () => {
  const row={hash:'one',refs:[{kind:'head',name:'HEAD'},{kind:'worktree',name:'one'},{kind:'branch',name:'topic/foo'},{kind:'remote',name:'origin/topic/foo'},{kind:'tag',name:'v1'}]};
  assert.deepEqual(Array.from(chips(row,'one','topic/foo'),c=>[c.kind,c.name]),[['head','HEAD → topic/foo | origin'],['tag','v1']]);
});

function harness(sessionId = 's1') {
  const calls=[], states=[];
  const load=historyLoader({rpc:{call:(url,method,body,signal)=>new Promise(resolve=>{
    calls.push({url,method,args:{...body.args},signal,success:value=>resolve({ok:true,value}),fail:(code,message)=>resolve({ok:false,error:{code,message}})});
  })}});
  return {calls,states,pager:historyPager(sessionId,load,state=>states.push(state)),latest:()=>states.at(-1)};
}
const page=(commits,nextCursor,merged={branches:[],hiddenHashes:[]})=>({status:'ok',commits,page:{nextCursor},merged});

test('explicit pages append to the same graph; retry keeps cursor, folding and all prior commits', async()=>{
  const {pager,calls,latest}=harness();
  const merged={branches:['topic'],hiddenHashes:['B']};
  const start=pager.start();
  assert.equal(calls[0].method,'gitGraph/history');
  assert.deepEqual(calls[0].args,{sessionId:'s1'});
  calls[0].success(page(repo.slice(0,4),'opaque',merged)); await start;
  const first=latest().data;
  assert.equal(calls.length,1); // No automatic continuation.
  const more=pager.more(); await pager.more();
  assert.equal(calls.length,2); assert.equal(calls[1].url,'/api');
  assert.equal(calls[1].method,'gitGraph/historyPage');
  assert.deepEqual(calls[1].args,{sessionId:'s1',cursor:'opaque'});
  assert.equal(latest().data,first);
  calls[1].fail('temporary','offline'); await more;
  assert.equal(latest().phase,'moreError'); assert.equal(latest().reason,'offline');
  assert.equal(latest().data,first);
  const retry=pager.more(); assert.deepEqual(calls[2].args,calls[1].args);
  calls[2].success(page([repo[3],...repo.slice(4)],null)); await retry;
  const {data,cursor}=latest(); assert.equal(cursor,null);
  assert.deepEqual(data.commits,repo); assert.equal(data.commits[0],first.commits[0]);
  assert.equal(data.merged,merged);
  assert.equal(visible(data.commits,data.merged,false).length,5);
  assert.equal(layout(visible(data.commits,data.merged,true),12)[3].padding,35.5);
  await pager.more(); assert.equal(calls.length,3);
});

test('a cached older host keeps its truncated first page visible without pretending it is the end', async()=>{
  const {pager,calls,latest}=harness();
  const start=pager.start(); calls[0].success({status:'ok',commits:[c('cached')],truncated:true}); await start;
  assert.equal(latest().phase,'legacy'); assert.equal(latest().data.commits[0].hash,'cached');
  await pager.more(); assert.equal(calls.length,1);
});

test('refresh supersedes pending append immediately, resets cursor, rejects stale responses', async()=>{
  const {pager,calls,latest}=harness();
  const start=pager.start(); calls[0].success(page([c('old')],'old-cursor')); await start;
  const more=pager.more(),refresh=pager.refresh(); await pager.more(); await pager.refresh();
  assert.equal(calls[1].signal.aborted,true); assert.equal(calls.length,3);
  assert.equal(calls[2].method,'gitGraph/history'); assert.equal(latest().cursor,null);
  calls[2].fail('temporary','offline'); await refresh;
  assert.equal(latest().phase,'refreshError'); assert.equal(latest().data.commits[0].hash,'old');
  await pager.more(); assert.equal(calls.length,3); // No paging a stale revision.
  const retry=pager.refresh(); calls[3].success(page([c('new')],'new-cursor')); await retry;
  calls[1].success(page([c('obsolete')],null)); await more;
  assert.deepEqual(latest().data.commits.map(c=>c.hash),['new']); assert.equal(latest().cursor,'new-cursor');
});

test('disposed session ignores late RPCs and commands; changed host snapshot restarts at page one', async()=>{
  const old=harness('left'), current=harness('right');
  const oldRequest=old.pager.start(); old.pager.stop();
  const start=current.pager.start(); old.calls[0].success(page([c('stale')],'old')); await oldRequest;
  await old.pager.refresh(); assert.equal(old.calls.length,1); assert.equal(old.latest().data,null);
  current.calls[0].success(page([c('initial')],'token')); await start;
  const more=current.pager.more(); current.calls[1].fail('git-graph/restart','history changed');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(current.latest().data,null); assert.equal(current.calls[2].method,'gitGraph/history');
  assert.deepEqual(current.calls[2].args,{sessionId:'right'});
  current.calls[2].success(page([c('replacement')],null)); await more;
  assert.equal(current.latest().data.commits[0].hash,'replacement');
});
