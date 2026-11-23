const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('header shortcut opens once, targets the existing pane and ignores a departed session',()=>{
  let mod, registration, Body, tabs=[], calls=[];
  vm.runInNewContext(fs.readFileSync(require.resolve('../client.js'),'utf8'),{window:{__ModuleLoader__:{load:m=>mod=m}}});
  const plugin=mod.factory(()=>({createElement:(type,props,...children)=>({type,props,children})}));
  plugin.apply({locale:{bind:()=>k=>k,register(){}},effect:fn=>fn(),sidebarRightTabs:{register(){}},sidebarRight:{mounted:{getSnapshot:()=> 'here'},tabsIn:()=>tabs,openTab:(...args)=>calls.push(args)},slots:{inject:(k,fn)=>fn(),register:(r,c)=>{if(r.name==='conversation.session.header.utilities'){registration=r;Body=c;}}}});
  assert.equal(registration.order,-9);
  const button=id=>Body({sessionId:id}).children.find(c=>c.type==='button');
  assert.equal(button('here').props['aria-label'],'openGraph');
  button('here').props.onClick(); assert.equal(calls[0][0],'git-graph'); assert.equal(calls[0][1],undefined);
  tabs=[{kind:'git-graph',id:'tab-in-other-pane'}]; button('here').props.onClick();assert.equal(calls[1][1].replaceTab,tabs[0].id);
  button('old').props.onClick();assert.equal(calls.length,2);
});
