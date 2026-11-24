const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('header shortcut opens once, targets the existing pane and ignores a departed session',()=>{
  let mod, registration, Body, tabs=[], calls=[];
  vm.runInNewContext(fs.readFileSync(require.resolve('../client.js'),'utf8'),{window:{__ModuleLoader__:{load:m=>mod=m}}});
  const plugin=mod.factory(()=>({createElement:(type,props,...children)=>({type,props,children})}));
  plugin.apply({locale:{bind:()=>k=>k,register(){}},effect:fn=>fn(),sidebarRightTabs:{register(){}},sidebarRight:{mounted:{getSnapshot:()=> 'here'},tabsIn:()=>tabs,openTab:(...args)=>calls.push(args)},slots:{inject:(k,fn)=>fn(),register:(r,c)=>{if(r.name==='conversation.session.header.utilities'){registration=r;Body=c;}}}});
  assert.equal(registration.order,-9);
  const buttons=id=>Body({sessionId:id}).children.filter(c=>c.type==='button');
  assert.deepEqual(Array.from(buttons('here'),b=>b.props['aria-label']),['openWorkspace','openGraph']);
  const button=id=>buttons(id)[1];
  assert.equal(button('here').props['aria-label'],'openGraph');
  button('here').props.onClick(); assert.equal(calls[0][0],'git-graph'); assert.equal(calls[0][1],undefined);
  tabs=[{kind:'git-graph',id:'tab-in-other-pane'}]; button('here').props.onClick();assert.equal(calls[1][1].replaceTab,tabs[0].id);
  button('old').props.onClick();assert.equal(calls.length,2);
  const ws=id=>buttons(id)[0];ws('here').props.onClick();assert.equal(calls[2][0],'git-working-tree');assert.equal(calls[2][1],undefined);
  tabs.push({kind:'git-working-tree',id:'workspace-tab'});ws('here').props.onClick();assert.equal(calls[3][1].replaceTab,'workspace-tab');
  ws('old').props.onClick();assert.equal(calls.length,4);
});
