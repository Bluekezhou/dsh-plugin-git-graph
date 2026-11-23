const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const moduleSource = fs.readFileSync(require.resolve('../client.js'), 'utf8');
const m = {exports:{}};
vm.runInNewContext(moduleSource, {module:m, AbortController});
const {commitFiles,displayPath} = m.exports;
const tick = () => new Promise(resolve=>setImmediate(resolve));
function transport() {
  const calls=[];
  const connection={rpc:{call:(url,method,{args},signal)=>new Promise((resolve,reject)=>calls.push({url,method,args:{...args},signal,resolve,reject}))}};
  return {connection,calls};
}
function open(reader,oid) {
  const controller=new AbortController(), states=[];
  return {controller, states, done:reader(oid,controller.signal,state=>states.push(state))};
}
const data={files:[{status:'R',oldPath:'a',path:'b'}],truncated:true};

test('files are lazy, keyed by session/oid, successful lists reused only in the same mount', async()=>{
  const {connection,calls}=transport();
  const first=commitFiles(connection,'left');
  const second=commitFiles(connection,'right');
  await tick(); assert.equal(calls.length,0);
  const probe=open(first,'a');probe.controller.abort();await probe.done;
  assert.equal(calls.length,0);
  const request=open(first,'a'); await tick();
  assert.equal(calls[0].url,'/api'); assert.equal(calls[0].method,'gitGraph/files');
  assert.deepEqual(calls[0].args,{sessionId:'left',oid:'a'});
  calls[0].resolve({ok:true,value:data});await request.done;
  assert.equal(request.states[0].data,data);
  const cached=open(first,'a');await cached.done; assert.equal(calls.length,1); assert.equal(cached.states[0].data,data);
  const independent=open(second,'a');await tick();assert.equal(calls.length,2);
  assert.deepEqual(calls[1].args,{sessionId:'right',oid:'a'});
  const empty={files:[],truncated:false};calls[1].resolve({ok:true,value:empty});await independent.done;
  assert.equal(independent.states[0].data,empty);
});

test('late responses cannot reach the selected row or overwrite a successful retry for the same OID', async()=>{
  const {connection,calls}=transport(), reader=commitFiles(connection,'one');
  const old=open(reader,'a');await tick();old.controller.abort();
  const other=open(reader,'b');await tick();other.controller.abort();
  const current=open(reader,'a');await tick();calls[2].resolve({ok:true,value:data});await current.done;
  calls[0].resolve({ok:true,value:{files:[],truncated:false}});calls[1].reject(new Error('late'));await Promise.all([old.done,other.done]);
  assert.deepEqual(old.states,[]);assert.deepEqual(other.states,[]);
  const cached=open(reader,'a');await cached.done;assert.equal(cached.states[0].data,data);
});

test('file query errors can retry without resetting history or caching failure', async()=>{
  const {connection,calls}=transport(), reader=commitFiles(connection,'one');
  const bad=open(reader,'a');await tick();calls[0].resolve({ok:false,error:{message:'offline'}});await bad.done;
  assert.equal(bad.states[0].phase,'error');assert.equal(bad.states[0].reason,'offline');
  const retry=open(reader,'a');await tick();assert.deepEqual(calls[1].args,calls[0].args);
  calls[1].resolve({ok:true,value:data});await retry.done; assert.equal(retry.states[0].phase,'ready');
});

test('ordinary text paths remain readable; invisible controls, bidi overrides and escape lookalikes stay distinct', ()=>{
  assert.equal(displayPath('目录/a b.js'),'目录/a b.js');
  assert.equal(displayPath('a\nb\tc'), '"a\\nb\\tc"');
  assert.equal(displayPath('a\\nb'), '"a\\\\nb"');
  assert.equal(displayPath('a\u202eb\u0085\u2029'), '"a\\u202eb\\u0085\\u2029"');
  assert.equal(displayPath(' a" '), '" a\\" "');
});

test('client locale registers status labels and file-list feedback for both languages',()=>{
  let module,locales;
  vm.runInNewContext(moduleSource,{window:{__ModuleLoader__:{load:entry=>{module=entry;}}}});
  module.factory(()=>({})).apply({effect:fn=>fn(),locale:{register:(ns,copy)=>{locales=copy;},bind:()=>key=>key},sidebarRightTabs:{register(){}},slots:{inject(){}}});
  for (const key of ['fileA','fileM','fileD','fileR','fileT','fileC','fileOther','files','filesEmpty','filesLoading','filesError','filesTruncated','retry']) {
    assert.ok(locales.en[key]); assert.ok(locales.zh[key]); assert.notEqual(locales.en[key],locales.zh[key]);
  }
});
