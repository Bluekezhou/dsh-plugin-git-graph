const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const gitGraph = require('../git.cjs');

// A side of the newest merge lives beyond the first page. A correct continuation
// must follow the original all-refs walk, not start an independent walk at row 200.
test('a merge crossing page 200 joins up with the same geometry as the uninterrupted Git walk', async t => {
  const tmp = fs.realpathSync(os.tmpdir());
  const cwd = fs.mkdtempSync(path.join(tmp,'dsh-graph-cross-page-'));
  t.after(()=>{assert.equal(path.dirname(fs.realpathSync(cwd)),tmp); assert.ok(path.basename(cwd).startsWith('dsh-graph-cross-page-')); fs.rmSync(cwd,{recursive:true,force:true});});
  const git = (args,input) => execFileSync('git',args,{cwd,input,encoding:'utf8',timeout:10000,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(cwd,'no-global-config')}}).trim();
  git(['init','-q','-b','main']);
  let stream='';
  const add=(branch,mark,parents)=>{stream+=`commit refs/heads/${branch}\nmark :${mark}\ncommitter Test <a@example.invalid> ${1700000000+mark} +0000\ndata 1\nx\n${parents.map((n,i)=>`${i?'merge':'from'} :${n}\n`).join('')}\n`;};
  add('main',1,[]); add('side',2,[1]);
  for(let n=3;n<=222;n++) add('main',n,[n===3?1:n-1]);
  add('main',223,[222,2]);git(['fast-import','--quiet'],stream);
  const reference=git(['log','--all','--date-order','--format=%H %P']).split('\n').map(line=>{const [hash,...parents]=line.trim().split(' ');return {hash,parents};});
  const a=await gitGraph.history(cwd); assert.equal(a.commits.length,200);
  const b=await gitGraph.historyPage(cwd,a.page.nextCursor); assert.equal(b.page.nextCursor,null);
  const combined=[...a.commits,...b.commits]; assert.deepEqual(combined.map(({hash,parents})=>({hash,parents})),reference);
  assert.ok(!a.commits.some(c=>c.hash===reference[0].parents[1]));
  const sandbox={module:{exports:{}}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../client.js'),'utf8'),sandbox);
  const {layout}=sandbox.module.exports;
  const short=layout(a.commits,12),full=layout(combined,12);
  assert.ok(short[0].stub); assert.ok(!full[0].stub); assert.ok(full[199].after.size>=2);
});
