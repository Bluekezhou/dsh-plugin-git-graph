const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),m={exports:{}};
vm.runInNewContext(fs.readFileSync(require.resolve('../client.js'),'utf8'),{module:m});
const {autoRefresh}=m.exports;

function harness({visible=true,busy=false,ms=10000}={}) {
  const timers=new Map(),listeners=new Map();let next=1,runs=0,shown=visible,engaged=busy;
  const target={
    addEventListener(type,fn){listeners.set(type,[...(listeners.get(type)||[]),fn]);},
    removeEventListener(type,fn){listeners.set(type,(listeners.get(type)||[]).filter(f=>f!==fn));},
  };
  const timersApi={
    set(fn,delay){const id=next++;timers.set(id,{fn,delay});return id;},
    clear(id){timers.delete(id);},
  };
  const controller=autoRefresh({run:()=>runs++,busy:()=>engaged,isVisible:()=>shown,target,ms,timers:timersApi});
  const tick=()=>{for(const {fn,delay} of [...timers.values()]){assert.equal(delay,ms);fn();}};
  const fire=type=>(listeners.get(type)||[]).slice().forEach(fn=>fn());
  return {controller,tick,fire,runs:()=>runs,timers,listeners,show:v=>shown=v,engage:v=>engaged=v};
}

test('a visible idle pane re-reads on every interval tick',()=>{
  const x=harness();x.controller.start();
  x.tick();x.tick();assert.equal(x.runs(),2);
  x.controller.stop();
});

test('hidden panes and reads in flight are skipped, not queued',()=>{
  const x=harness();x.controller.start();
  x.show(false);x.tick();assert.equal(x.runs(),0,'hidden pane must not poll');
  x.show(true);x.engage(true);x.tick();assert.equal(x.runs(),0,'an in-flight read must not be overlapped');
  x.engage(false);x.tick();assert.equal(x.runs(),1,'the next tick resumes polling');
  x.controller.stop();
});

test('returning to the tab or refocusing the window reads immediately',()=>{
  const x=harness();x.controller.start();
  x.show(false);x.fire('visibilitychange');assert.equal(x.runs(),0);
  x.show(true);x.fire('visibilitychange');assert.equal(x.runs(),1);
  x.fire('focus');assert.equal(x.runs(),2);
  x.controller.stop();
});

test('stop clears the timer and listeners; a stopped controller never reads again',()=>{
  const x=harness();x.controller.start();x.controller.start();
  assert.equal(x.timers.size,1,'start is idempotent');
  x.controller.stop();
  assert.equal(x.timers.size,0);assert.equal(x.listeners.get('visibilitychange').length,0);assert.equal(x.listeners.get('focus').length,0);
  x.tick();x.fire('focus');x.controller.start();assert.equal(x.runs(),0);assert.equal(x.timers.size,0);
});
