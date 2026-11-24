const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),m={exports:{}};
vm.runInNewContext(fs.readFileSync(require.resolve('../client.js'),'utf8'),{module:m});
const {workspaceRead,unifiedRows}=m.exports;
test('unified view counts hunk content, not headers, and resets old/new coordinates',()=>{
  const patch='diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +7,2 @@ fn\n keep\n---literal\n+++literal\n\\ No newline at end of file\n@@ -20,0 +30 @@\n+\n';
  const {added,removed,rows}=unifiedRows(patch);
  assert.equal(added,2);assert.equal(removed,1);
  assert.deepEqual(Array.from(rows,r=>[r.kind,r.old,r.next,r.text]),[['hunk',undefined,undefined,'@@ -3,2 +7,2 @@ fn'],['context',3,7,'keep'],['del',4,'','--literal'],['add','',8,'++literal'],['note',undefined,undefined,'\\ No newline at end of file'],['hunk',undefined,undefined,'@@ -20,0 +30 @@'],['add','',30,'']]);
  for(const s of ['rename from old\nrename to new','@@@ -1,1 -1,1 +1,2 @@@\n++merge'])assert.equal(unifiedRows(s),null);
});
const workspaceGroups=files=>structuredClone(m.exports.workspaceGroups(files));
test('working tree separates both sides of one file and does not double-count conflicts',()=>{
  const mm={id:'both',path:'r/new',oldPath:'r/old',x:'R',y:'M'},u={id:'new',path:'?\n',x:'?',y:'?'},c={id:'conflict',path:'c',x:'A',y:'A'};
  const {staged,unstaged,conflicts,untracked}=workspaceGroups([mm,u,c]);
  assert.deepEqual(staged,[{side:'staged',file:mm,status:'R'}]);
  assert.deepEqual(unstaged,[{side:'unstaged',file:mm,status:'M'}]);
  assert.deepEqual(conflicts,[{side:'unstaged',file:c,status:'AA'}]);
  assert.deepEqual(untracked,[{side:'untracked',file:u,status:'?'}]);
});
test('working tree DTOs and abort signal use session-scoped RPCs, never a file path',async()=>{
  const calls=[],api={rpc:{call:async(...args)=>{calls.push([args[0],args[1],{...args[2]},args[3]]);return {ok:true,value:'test'};}}},s=new AbortController().signal;
  assert.equal(await workspaceRead(api,'status',{sessionId:'a'},s),'test');
  await workspaceRead(api,'diff',{sessionId:'a',id:'opaque',side:'staged'},s);
  assert.deepEqual(calls,[['/api','gitGraph/status',{args:{sessionId:'a'}},s],['/api','gitGraph/diff',{args:{sessionId:'a',id:'opaque',side:'staged'}},s]]);
  await assert.rejects(workspaceRead({rpc:{call:async()=>({ok:false,error:{message:'gone'}})}},'status',{},s),/gone/);
});
