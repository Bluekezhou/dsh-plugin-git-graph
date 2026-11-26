// Render smoke test: runs the plugin factory and renders every registered pane's
// element tree once with a minimal hooks simulator. Catches render-time crashes
// (e.g. reading a const before its declaration) that pure-function tests cannot
// see, without the DSH shell or a real React. Effects never run here.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
let factory;const slots=[];
const React={
  createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(c=>c!=null&&c!==false)}),
  Fragment:Symbol('Fragment'),
};
// One hook store per component call; every hook forwards to the component rendering now.
function hooksFor(){
  const cells=[];let i=0;
  const cell=()=>{const n=i++;return cells[n]??(cells[n]={});};
  return {
    useState:init=>{const s=cell();if(!('v' in s))s.v=typeof init==='function'?init():init;return[s.v,v=>{s.v=typeof v==='function'?v(s.v):v;}];},
    useRef:init=>{const s=cell();if(!('v' in s))s.v={current:init};return s.v;},
    useMemo:(fn,deps)=>{const s=cell();if(!('v' in s)||!deps||deps.some((d,j)=>!Object.is(d,s.deps?.[j])))s.v=fn();s.deps=deps;return s.v;},
    useEffect(){},useLayoutEffect(){},useId:()=>'id',
  };
}
let hooks=hooksFor();
for(const name of ['useState','useRef','useMemo','useEffect','useLayoutEffect','useId'])React[name]=(...a)=>hooks[name](...a);
const ctx={effect(fn){fn();},connection:{call:()=>new Promise(()=>{})},
  locale:{register(){},bind:()=>(k,p)=>p?`${k}:${Object.values(p).join('/')}`:k},
  sidebarRightTabs:{register:()=>()=>{}},
  slots:{inject(s,fn){fn();},register:(opts,Comp)=>{slots.push({id:opts.key||opts.id,Comp});return()=>{};}}};
vm.runInNewContext(fs.readFileSync(require.resolve('../client.js'),'utf8'),{
  window:{__ModuleLoader__:{load:m=>{factory=m.factory;}}},
  document:{visibilityState:'visible'},setInterval,clearInterval,setTimeout,clearTimeout,console,
  Object,Array,String,Number,JSON,Math,Map,Set,Promise,Symbol,Error,RegExp,Date,AbortController});
factory(name=>{if(name==='react')return React;throw new Error('unexpected require '+name);}).apply(ctx);
let seen=[];
function render(el,depth=0){
  assert.ok(depth<25,'element tree must terminate');
  if(el==null||typeof el==='boolean')return;
  if(Array.isArray(el)){el.forEach(e=>render(e,depth+1));return;}
  if(typeof el!=='object')return;
  seen.push(String(el.props?.className||''));
  if(el.type===React.Fragment){render(el.children,depth+1);return;}
  if(typeof el.type==='function'){
    const outer=hooks;hooks=hooksFor();
    try{render(el.type({...el.props,children:el.children}),depth+1);}finally{hooks=outer;}
  }else render(el.children,depth+1);
}
const actions={bindCommands(){}},t=(k,p)=>p?`${k}:${Object.values(p).join('/')}`:k;
const session={useSessions:sel=>sel({byId:{s:{cwd:process.env.HOME}}}),useTabInfo:()=>({tab:{actions}}),t};
test('history and working-tree panes render their full tree without throwing',()=>{
  // Header icon, history pane and working-tree pane are all registered here.
  assert.deepEqual([...new Set(slots.map(s=>s.id))].sort(),['dsh-plugin-git-graph','dsh-plugin-git-graph-working-tree']);
  let roots=0;
  for(const {id,Comp} of slots){
    seen=[];const outer=hooks;hooks=hooksFor();
    let tree;try{tree=Comp({sessionId:'s',...session});}finally{hooks=outer;}
    // The header icon renders no pane; the two panes each reach a gg-view root through render().
    const panes=seen.filter(c=>c.startsWith('gg-view')).length+(Array.isArray(tree)&&tree.length?0:0);
    seen=[];render(tree);
    const views=seen.filter(c=>c.startsWith('gg-view'));
    if(views.length)roots++;
    else assert.notEqual(id,'dsh-plugin-git-graph-working-tree',`${id} must reach a gg-view root`);
  }
  assert.ok(roots>=2,'both panes must reach their gg-view root; got '+roots);
});
